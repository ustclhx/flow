import {
  type BlockedReason,
  DELEGATION_ENDING_EVENTS,
  type LedgerEvent,
  type TaskOrigin,
  type WakeOrigin,
} from '@flow/core'

/**
 * supervisor 唤醒队列的投影（add-m1-supervisor D2、D3、D15；tasks 3.1、3.2）。
 *
 * 纯内存、只由账本事件按 seq 顺序折叠而成：中枢启动时从头重放，之后随订阅增量更新，
 * 所以重启后队列、代数、失败次数与放行状态都能恢复，不另存状态。
 *
 * 每个 workspace 三条队列（instruction、autonomous、reply）。事件被某次唤醒的
 * `supervisor.wake_started.events` 引用即出队；普通唤醒以 `failed` 结束时，它的事件回到原队列
 * （唤醒没能处理它们），以 `done` / `cancelled` 结束则不再处理。reply 唤醒的事件一律不回队列
 * （D15：失败不重试，直接转交）。
 */

export type Queue = WakeOrigin
export const NORMAL_QUEUES = ['instruction', 'autonomous'] as const satisfies readonly TaskOrigin[]

/** 派生任务进入这些原因的 blocked 时唤醒（同一任务同一原因只一次，D3）。 */
export const WAKING_BLOCKED_REASONS: ReadonlySet<BlockedReason> = new Set([
  'crashed',
  'node_lost',
  'no_progress',
  'other',
])

const TERMINAL_EVENTS = {
  'task.done': 'done',
  'task.failed': 'failed',
  'task.cancelled': 'cancelled',
} as const

export interface QueuedEvent {
  seq: number
  type: LedgerEvent['type']
  ts: string
  task_id?: string
  /** 同一 key 的事件只保留最新一条（同一条巡检规则的多次触发）。 */
  key?: string
}

export interface WakeState {
  task_id: string
  workspace: string
  origin: WakeOrigin
  generation: number
  /** `supervisor.wake_started` 的 seq 与时间。 */
  seq: number
  ts: string
  events: number[]
  /** 不计入每日上限：手动放行（`supervisor.release`）或失败后的那一次重试。 */
  bypass: boolean
  retry: boolean
  status: 'open' | 'done' | 'failed' | 'cancelled'
  ended_ts: string | null
}

export interface QueueState {
  /** 待处理事件（seq → 事件）。 */
  pending: Map<number, QueuedEvent>
  /** 连续失败的唤醒数（成功、取消或放行后清零）。 */
  failures: number
  lastFailTs: string | null
  lastFailedWake: string | null
  /** 已放行、尚未被唤醒消费（放行时队列非空才有"通行证"）。 */
  releasePending: boolean
  /** 放行事件的 seq：放行只作用于 seq 小于它的事件（放行当时已存在的）。 */
  releaseSeq: number | null
}

export interface WorkspaceWakes {
  workspace: string
  generation: number
  queues: Record<Queue, QueueState>
  /** 按创建先后。 */
  wakes: WakeState[]
}

/** 查询中枢其他投影的只读信息（提问条目所属的唤醒，D11）。 */
export interface ProjectionLookups {
  /**
   * 收件箱条目的来源信息（条目创建后不变）：提问条目的 source_ref 为提问所在的唤醒任务 id（D11）。
   */
  item(itemId: string): {
    source: string
    source_ref: string
    workspace: string | null
    actions: readonly string[]
  } | null
}

/** 本组自己写的收件箱条目（上限、失败）的 id 前缀：它们关闭时不唤醒。 */
export const WAKE_ITEM_PREFIX = 'wake.'

/** 放行范围内（seq 小于放行事件）的事件都已不在队列中时，放行作废（不留通行证）。 */
function settleRelease(q: QueueState) {
  if (!q.releasePending || q.releaseSeq === null) return
  const seq = q.releaseSeq
  if (![...q.pending.keys()].some((s) => s < seq)) {
    q.releasePending = false
    q.releaseSeq = null
  }
}

/**
 * 入队：同一 key（同一条巡检规则）只保留最新一条。新事件到达、失败唤醒退回事件都走这里：
 * - 已有更新的同 key 事件时，较旧的不再入队；
 * - 放行范围内（seq 小于放行事件）的旧事件不被去重删除，保证放行能落到它们身上。
 */
function enqueue(q: QueueState, ev: QueuedEvent) {
  if (ev.key !== undefined) {
    for (const [seq, other] of q.pending) {
      if (other.key !== ev.key) continue
      if (seq > ev.seq) return
      const protectedByRelease = q.releasePending && q.releaseSeq !== null && seq < q.releaseSeq
      if (!protectedByRelease) q.pending.delete(seq)
    }
  }
  q.pending.set(ev.seq, ev)
}

const newQueue = (): QueueState => ({
  pending: new Map(),
  failures: 0,
  lastFailTs: null,
  lastFailedWake: null,
  releasePending: false,
  releaseSeq: null,
})

export class WakeProjection {
  private readonly ws = new Map<string, WorkspaceWakes>()
  /** 有 origin 的非唤醒任务（D2：origin 创建时固化）。 */
  private readonly taskOrigin = new Map<string, TaskOrigin>()
  private readonly wakes = new Map<string, WakeState>()
  private readonly blockedSeen = new Set<string>()
  /** 任务提案 id → 提交它的唤醒任务。 */
  private readonly proposals = new Map<string, string>()
  /** 合并请求条目 id → 发起它的唤醒任务（`merge_request.created.wake_task_id`）。 */
  private readonly mergeRequests = new Map<string, string>()
  /** 普通唤醒合并的原始事件（出队时记下，失败放回队列时用）。 */
  private readonly originals = new Map<string, QueuedEvent[]>()
  private last = 0
  /** 是否已写过 `supervisor.scheduler_initialized`（只看这条标记）。 */
  private initialized = false

  constructor(private readonly lookups: ProjectionLookups) {}

  /** 已折叠到的 seq。 */
  position(): number {
    return this.last
  }

  workspace(ref: string): WorkspaceWakes {
    let w = this.ws.get(ref)
    if (!w) {
      w = {
        workspace: ref,
        generation: 0,
        queues: { instruction: newQueue(), autonomous: newQueue(), reply: newQueue() },
        wakes: [],
      }
      this.ws.set(ref, w)
    }
    return w
  }

  workspaces(): string[] {
    return [...this.ws.keys()]
  }

  /** 账本里是否已有初始化标记 `supervisor.scheduler_initialized`。 */
  isInitialized(): boolean {
    return this.initialized
  }

  wake(taskId: string): WakeState | null {
    return this.wakes.get(taskId) ?? null
  }

  /** 唤醒会合并的事件所在队列；不是唤醒事件时为 null（D2 表、D3）。 */
  classify(e: LedgerEvent): Queue | null {
    return this.classifyIn(e)?.queue ?? null
  }

  /** 事件所在的 workspace 与队列（收件箱关闭事件的 workspace 取自条目）。 */
  private classifyIn(e: LedgerEvent): { workspace: string; queue: Queue } | null {
    if (e.type === 'inbox.item_closed') {
      // G13：supervisor 提问 7 天未回答关闭为 expired 时唤醒一次，origin 取提问所在唤醒。
      if ((e.payload.reason as string) !== 'expired') return null
      if (e.payload.item_id.startsWith(WAKE_ITEM_PREFIX)) return null
      const item = this.lookups.item(e.payload.item_id)
      // 只限提问条目：source 为 supervisor 且可以回复（ask_user，D11）。
      if (item?.source !== 'supervisor' || !item.workspace || !item.actions.includes('reply')) {
        return null
      }
      return { workspace: item.workspace, queue: this.normalOriginOf(item.source_ref) }
    }
    if (e.workspace === undefined) return null
    const queue = this.queueOf(e)
    return queue === null ? null : { workspace: e.workspace, queue }
  }

  private queueOf(e: LedgerEvent): Queue | null {
    switch (e.type) {
      case 'user.instruction':
        return e.actor === 'user' ? 'instruction' : null
      case 'schedule.fired':
        return (e.payload.payload as { kind?: unknown }).kind === 'supervisor_patrol'
          ? 'autonomous'
          : null
      case 'decision.review_due':
        return e.workspace === undefined ? null : 'autonomous'
      case 'task.done':
      case 'task.failed':
      case 'task.cancelled':
        if (e.task_id === undefined || this.wakes.has(e.task_id)) return null
        return this.taskOrigin.get(e.task_id) ?? null
      case 'task.blocked': {
        if (e.task_id === undefined || this.wakes.has(e.task_id)) return null
        const origin = this.taskOrigin.get(e.task_id)
        if (!origin || !WAKING_BLOCKED_REASONS.has(e.payload.reason)) return null
        const key = `${e.task_id}\n${e.payload.reason}`
        if (this.blockedSeen.has(key)) return null
        this.blockedSeen.add(key)
        return origin
      }
      case 'supervisor.answered':
        return this.normalOriginOf(this.lookups.item(e.payload.item_id)?.source_ref)
      case 'task_proposal.accepted':
        return 'instruction'
      case 'task_proposal.rejected':
        return this.normalOriginOf(this.proposals.get(e.payload.proposal_id))
      // G14：用户驳回合并请求 → 唤醒 supervisor，origin 取请求所在唤醒的 origin（与 task_proposal.rejected 一致，D2）。
      case 'merge_request.rejected':
        if (e.actor !== 'user') return null
        return this.normalOriginOf(this.mergeRequests.get(e.payload.item_id))
      case 'task.reply_delegated':
        return 'reply'
      default:
        return null
    }
  }

  /** 某唤醒的普通 origin；未知或 reply 时取更保守的 autonomous。 */
  private normalOriginOf(wakeTaskId: string | undefined): TaskOrigin {
    const o = wakeTaskId === undefined ? undefined : this.wakes.get(wakeTaskId)?.origin
    return o === 'instruction' ? 'instruction' : 'autonomous'
  }

  /**
   * 折叠一条事件，返回受影响的 workspace（需要重新调度），没有影响时为 null。
   * 必须按 seq 升序调用；重复或更早的事件被忽略。
   */
  apply(e: LedgerEvent): string | null {
    if (e.seq <= this.last) return null
    this.last = e.seq
    switch (e.type) {
      case 'task.created':
        if (e.payload.origin !== undefined && e.task_id !== undefined) {
          this.taskOrigin.set(e.task_id, e.payload.origin)
        }
        return null
      case 'task_proposal.created':
        this.proposals.set(e.payload.proposal_id, e.payload.wake_task_id)
        break
      case 'merge_request.created':
        if (e.payload.item_id) this.mergeRequests.set(e.payload.item_id, e.payload.wake_task_id)
        break
      case 'supervisor.wake_started':
        return this.started(e)
      case 'supervisor.release': {
        if (e.workspace === undefined) return null
        const q = this.workspace(e.workspace).queues[e.payload.queue]
        // 放行只对当时已有的事件生效；队列为空时不保留通行证（只解除暂停）。
        q.releasePending = q.pending.size > 0
        q.releaseSeq = q.releasePending ? e.seq : null
        q.failures = 0
        return e.workspace
      }
      case 'supervisor.queue_dropped': {
        if (e.workspace === undefined) return null
        const q = this.workspace(e.workspace).queues[e.payload.queue]
        for (const seq of [...q.pending.keys()]) {
          if (seq <= e.payload.up_to_seq) q.pending.delete(seq)
        }
        settleRelease(q)
        return e.workspace
      }
      case 'supervisor.scheduler_initialized': {
        // 首次启动之前写下的普通队列事件不回放（reply 委托另按 activeDelegation 判定）。
        this.initialized = true
        for (const w of this.ws.values()) {
          for (const queue of NORMAL_QUEUES) {
            const q = w.queues[queue]
            for (const seq of [...q.pending.keys()]) {
              if (seq <= e.payload.up_to_seq) q.pending.delete(seq)
            }
            settleRelease(q)
          }
        }
        return null
      }
      default:
        break
    }
    let touched: string | null = null
    if (e.type in TERMINAL_EVENTS && e.task_id !== undefined) {
      const wake = this.wakes.get(e.task_id)
      if (wake) {
        this.ended(wake, TERMINAL_EVENTS[e.type as keyof typeof TERMINAL_EVENTS], e.ts)
        return wake.workspace
      }
    }
    // 唤醒任务卡住或恢复：reply 唤醒 blocked 时委托要立即转交（3.5 的钩子），所以也重新调度。
    if (e.task_id !== undefined && this.wakes.has(e.task_id)) {
      touched = this.wakes.get(e.task_id)?.workspace ?? null
    }
    if (e.task_id !== undefined && e.workspace !== undefined) this.purgeReplies(e)
    const hit = this.classifyIn(e)
    if (hit !== null) {
      const key = e.type === 'schedule.fired' ? `schedule:${e.payload.rule_id}` : undefined
      enqueue(this.workspace(hit.workspace).queues[hit.queue], {
        seq: e.seq,
        type: e.type,
        ts: e.ts,
        ...(e.task_id === undefined ? {} : { task_id: e.task_id }),
        ...(key === undefined ? {} : { key }),
      })
      touched = hit.workspace
    }
    return touched
  }

  /**
   * reply 队列中已失效的委托随事件清掉（D15 的隐式失效与转交）：该任务写了 `task.reply_escalated`、
   * 离开这次卡住（DELEGATION_ENDING_EVENTS）或进入终态时，它此前的委托事件出队。
   */
  private purgeReplies(e: LedgerEvent) {
    const ending =
      e.type === 'task.reply_escalated' ||
      DELEGATION_ENDING_EVENTS.has(e.type) ||
      e.type in TERMINAL_EVENTS
    if (!ending || e.workspace === undefined) return
    const pending = this.ws.get(e.workspace)?.queues.reply.pending
    if (!pending) return
    for (const [seq, ev] of pending) {
      if (ev.task_id === e.task_id && seq < e.seq) pending.delete(seq)
    }
  }

  private started(e: Extract<LedgerEvent, { type: 'supervisor.wake_started' }>): string {
    const p = e.payload
    const w = this.workspace(p.workspace)
    const q = w.queues[p.origin]
    const retry = p.origin !== 'reply' && q.failures === 1 && !q.releasePending
    const bypass = p.origin !== 'reply' && (q.releasePending || retry)
    q.releasePending = false
    q.releaseSeq = null
    const wake: WakeState = {
      task_id: p.task_id,
      workspace: p.workspace,
      origin: p.origin,
      generation: p.generation,
      seq: e.seq,
      ts: e.ts,
      events: [...p.events],
      bypass,
      retry,
      status: 'open',
      ended_ts: null,
    }
    this.wakes.set(p.task_id, wake)
    w.wakes.push(wake)
    w.generation = Math.max(w.generation, p.generation)
    const consumed: QueuedEvent[] = []
    for (const seq of p.events) {
      for (const queue of Object.values(w.queues)) {
        const ev = queue.pending.get(seq)
        if (ev) consumed.push(ev)
        queue.pending.delete(seq)
      }
    }
    if (p.origin !== 'reply') this.originals.set(p.task_id, consumed)
    return p.workspace
  }

  private ended(wake: WakeState, status: 'done' | 'failed' | 'cancelled', ts: string) {
    if (wake.status !== 'open') return
    wake.status = status
    wake.ended_ts = ts
    if (wake.origin === 'reply') return
    const q = this.workspace(wake.workspace).queues[wake.origin]
    if (status === 'failed') {
      q.failures++
      q.lastFailTs = ts
      q.lastFailedWake = wake.task_id
      // 唤醒没能处理这些事件：放回队列，供重试、自动恢复或放行时一并处理。
      for (const ev of this.originals.get(wake.task_id) ?? []) enqueue(q, ev)
    } else {
      q.failures = 0
    }
    this.originals.delete(wake.task_id)
  }

  /** 正在进行（未结束，含 blocked）的普通 / reply 唤醒。 */
  openWake(ref: string, kind: 'normal' | 'reply'): WakeState | null {
    const w = this.ws.get(ref)
    if (!w) return null
    for (let i = w.wakes.length - 1; i >= 0; i--) {
      const wake = w.wakes[i]
      if (wake?.status !== 'open') continue
      if ((wake.origin === 'reply') === (kind === 'reply')) return wake
    }
    return null
  }

  /** 从队列中移除一条已失效的事件（reply 委托失效时；与账本推出的结果一致，只是提前清掉）。 */
  forget(ref: string, queue: Queue, seq: number) {
    this.ws.get(ref)?.queues[queue].pending.delete(seq)
  }

  /** 某队列待处理的事件，按 seq 升序。 */
  pending(ref: string, queue: Queue): QueuedEvent[] {
    const q = this.ws.get(ref)?.queues[queue]
    return q ? [...q.pending.values()].sort((a, b) => a.seq - b.seq) : []
  }
}
