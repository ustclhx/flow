import type { BlockedReason, LedgerEvent, TaskOrigin, WakeOrigin } from '@flow/core'

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
  /** 已放行、尚未被唤醒消费。 */
  releasePending: boolean
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
  /** 收件箱条目的 source_ref（提问条目为提问所在的唤醒任务 id）。 */
  itemSourceRef(itemId: string): string | null
}

const newQueue = (): QueueState => ({
  pending: new Map(),
  failures: 0,
  lastFailTs: null,
  lastFailedWake: null,
  releasePending: false,
})

export class WakeProjection {
  private readonly ws = new Map<string, WorkspaceWakes>()
  /** 有 origin 的非唤醒任务（D2：origin 创建时固化）。 */
  private readonly taskOrigin = new Map<string, TaskOrigin>()
  private readonly wakes = new Map<string, WakeState>()
  private readonly blockedSeen = new Set<string>()
  /** 任务提案 id → 提交它的唤醒任务。 */
  private readonly proposals = new Map<string, string>()
  /** 普通唤醒合并的原始事件（出队时记下，失败放回队列时用）。 */
  private readonly originals = new Map<string, QueuedEvent[]>()
  private last = 0

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

  wake(taskId: string): WakeState | null {
    return this.wakes.get(taskId) ?? null
  }

  /** 唤醒会合并的事件所在队列；不是唤醒事件时为 null（D2 表、D3）。 */
  classify(e: LedgerEvent): Queue | null {
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
      case 'supervisor.answered': {
        const ref = this.lookups.itemSourceRef(e.payload.item_id)
        return this.normalOriginOf(ref === null ? undefined : ref)
      }
      case 'task_proposal.accepted':
        return 'instruction'
      case 'task_proposal.rejected':
        return this.normalOriginOf(this.proposals.get(e.payload.proposal_id))
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
      case 'supervisor.wake_started':
        return this.started(e)
      case 'supervisor.release': {
        if (e.workspace === undefined) return null
        const q = this.workspace(e.workspace).queues[e.payload.queue]
        q.releasePending = true
        q.failures = 0
        return e.workspace
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
    const queue = this.classify(e)
    if (queue !== null && e.workspace !== undefined) {
      this.workspace(e.workspace).queues[queue].pending.set(e.seq, {
        seq: e.seq,
        type: e.type,
        ts: e.ts,
        ...(e.task_id === undefined ? {} : { task_id: e.task_id }),
      })
      touched = e.workspace
    }
    return touched
  }

  private started(e: Extract<LedgerEvent, { type: 'supervisor.wake_started' }>): string {
    const p = e.payload
    const w = this.workspace(p.workspace)
    const q = w.queues[p.origin]
    const retry = p.origin !== 'reply' && q.failures === 1 && !q.releasePending
    const bypass = p.origin !== 'reply' && (q.releasePending || retry)
    q.releasePending = false
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
      for (const ev of this.originals.get(wake.task_id) ?? []) q.pending.set(ev.seq, ev)
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

  /** 某队列待处理的事件，按 seq 升序。 */
  pending(ref: string, queue: Queue): QueuedEvent[] {
    const q = this.ws.get(ref)?.queues[queue]
    return q ? [...q.pending.values()].sort((a, b) => a.seq - b.seq) : []
  }
}
