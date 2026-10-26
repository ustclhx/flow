import {
  clipText,
  fail,
  type InboxVia,
  type LedgerEvent,
  MANUAL_WAKE_TEXT,
  ok,
  type Result,
  type Role,
  type SupervisorStatusData,
  type SupervisorWakeData,
  type SupervisorWorkspaceStatus,
  type TaskContractInput,
  type TaskOrigin,
  WAKE_EVENT_SUMMARY_MAX,
  WAKE_EVENTS_MAX,
  type WakeEventInput,
  type WakeOrigin,
  type WakeSummary,
} from '@flow/core'
import type { EventInput, LedgerStore } from '../ledger/store.ts'
import type { TaskService, WorkspaceInfo, WorkspaceLookup } from '../ledger/tasks.ts'
import type { HubClock } from '../server/clock.ts'
import { consoleLogger, type HubLogger } from '../server/maintenance.ts'
import {
  NORMAL_QUEUES,
  type Queue,
  type QueuedEvent,
  WakeProjection,
  type WakeState,
} from './projection.ts'

/**
 * supervisor 唤醒调度器（add-m1-supervisor D1、D3、D4、D15；tasks 3.1–3.3）。
 *
 * - 订阅账本，把唤醒事件折叠进 `WakeProjection`（workspace × instruction / autonomous / reply 三条队列）；
 * - 同一 workspace 同时最多一个未结束（含 blocked）的普通唤醒，空闲时先处理 instruction；另可并行一个
 *   reply 唤醒；一次唤醒只合并同一条队列的事件；
 * - 唤醒任务以 hub 身份创建，幂等键 `supervisor:<ws>:<generation>`，`task.created` 与
 *   `supervisor.wake_started` 同一次 append（`withCreated`）；
 * - 每日上限（普通唤醒总数与 autonomous 分别计；放行与失败后的重试不计入）：超出时事件留在队列，
 *   收件箱出现一条 Decide；
 * - 普通唤醒失败：立即重试一次；仍失败则进收件箱（Interrupt）并暂停该队列，满 1 小时自动恢复一次，
 *   再失败退避翻倍（最长 24 小时）；`supervisor.release` 或取消唤醒即放行；
 * - reply 唤醒：开始前剔除已失效的委托（`activeDelegation`），全部失效不唤醒；失败不重试、不暂停、
 *   不能放行。委托的判定与转交属于 3.5，这里只留 `onReplyUnavailable` 钩子。
 */

/** 暂停的首次退避与上限（D3）。 */
export const PAUSE_BASE_MS = 60 * 60 * 1000
export const PAUSE_MAX_MS = 24 * 60 * 60 * 1000

/** 普通唤醒的合同重试次数（租约过期时重新排队一次）。 */
const WAKE_MAX_ATTEMPTS = 2
const TAIL_LINES = 40
const FIELD_MAX = 2000

export type ReplyUnavailableReason = 'unavailable' | 'quota' | 'blocked'

export interface WakeSchedulerOptions {
  ledger: LedgerStore
  tasks: Pick<TaskService, 'createTask'>
  clock: HubClock
  workspaces: WorkspaceLookup
  /** 全部 workspace（status 不指定 workspace 时列出）。 */
  listWorkspaces: () => Promise<WorkspaceInfo[]>
  /** 唯一的 supervisor 角色（core `findSupervisorRole`）：没有为 null，多个或可写时失败。 */
  supervisorRole: () => Promise<Result<Role | null>>
  /** 计"今天"用的日期（YYYY-MM-DD），默认中枢本地时区。 */
  dayKey?: (ms: number) => string
  /** 下一个日期边界（毫秒），默认本地时区的下一个午夜。 */
  nextDay?: (ms: number) => number
  logger?: Pick<HubLogger, 'warn'>
  /**
   * reply 唤醒无法开始（3.5 据此以 `wake_unavailable` 转交委托）：未启用、reply 配额用尽，或当前 reply
   * 唤醒处于 blocked。每次调度都可能再次调用，实现必须幂等。
   */
  onReplyUnavailable?: (info: {
    workspace: string
    reason: ReplyUnavailableReason
    delegations: QueuedEvent[]
  }) => void
}

export interface WakeScheduler {
  /** 重放账本并订阅；随后为所有有待处理事件的 workspace 调度一次。 */
  start(): void
  stop(): void
  /** 等到进行中的调度全部完成（测试与停机用）。 */
  idle(): Promise<void>
  /** 立即为某 workspace 调度一次（等待完成）。 */
  pump(workspace: string): Promise<void>
  /** `flow ask` / `/ask` / `flow supervisor wake <ws> [<说明>]`：写 user.instruction 并调度。 */
  instruct(
    workspace: string,
    text: string | undefined,
    via: InboxVia,
  ): Promise<Result<SupervisorWakeData>>
  /** `flow supervisor wake <ws> --release <queue>`。 */
  release(workspace: string, queue: TaskOrigin): Promise<Result<SupervisorWakeData>>
  status(workspace?: string): Promise<Result<SupervisorStatusData>>
  /** 投影（测试与诊断）。 */
  projection(): WakeProjection
}

type Availability =
  | { ok: true; ws: WorkspaceInfo; role: Role }
  | { ok: false; code: 'unknown_workspace' | 'supervisor_disabled'; reason: string }

const pad = (n: number) => String(n).padStart(2, '0')
export const localDayKey = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
export const localNextDay = (ms: number) => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
}

/** 第 failures 次连续失败后的暂停时长（failures ≥ 2）。 */
export const pauseMs = (failures: number) =>
  Math.min(PAUSE_MAX_MS, PAUSE_BASE_MS * 2 ** Math.max(0, failures - 2))

const wsId = (ref: string) => ref.replace(/^ws\//, '')
const clip = (s: string | undefined, max = FIELD_MAX) =>
  s === undefined ? undefined : clipText(s, max)

const STATUS_LABEL: Record<string, string> = {
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
}

export function createWakeScheduler(o: WakeSchedulerOptions): WakeScheduler {
  const { ledger, clock } = o
  const logger = o.logger ?? consoleLogger
  const dayKey = o.dayKey ?? localDayKey
  const nextDay = o.nextDay ?? localNextDay
  const projection = new WakeProjection({
    itemSourceRef: (id) => ledger.getInboxItem(id)?.source_ref ?? null,
  })
  let unsubscribe: (() => void) | undefined
  let stopped = false
  /** 每个 workspace 的调度串行执行；`dirty` 表示执行期间又有新事件，结束后再跑一次。 */
  const chains = new Map<string, { running: Promise<void>; dirty: boolean; busy: boolean }>()
  const timers = new Map<string, () => void>()

  const summaryOf = (w: WakeState): WakeSummary => {
    const task = ledger.getTask(w.task_id)
    return {
      task_id: w.task_id,
      origin: w.origin,
      generation: w.generation,
      status: task?.status ?? (w.status === 'open' ? 'queued' : w.status),
      events: w.events.length,
      started_at: w.ts,
      finished_at: w.ended_ts,
    }
  }

  async function availability(ref: string): Promise<Availability> {
    const ws = await o.workspaces(ref)
    if (!ws) return { ok: false, code: 'unknown_workspace', reason: `workspace ${ref} 未定义` }
    const off = (reason: string): Availability => ({
      ok: false,
      code: 'supervisor_disabled',
      reason,
    })
    if (ref === 'ws/global') return off('global 不启用 supervisor')
    if (!ws.supervisor.enabled) return off(`${ref} 未启用 supervisor（supervisor.enabled: false）`)
    const role = await o.supervisorRole()
    if (!role.ok) return off(`supervisor 角色不可用：${role.error.message}`)
    if (!role.data) return off('没有 kind: supervisor 角色（运行 flow init 补齐角色模板）')
    if (ws.repos.length === 0) return off(`${ref} 没有登记仓库，supervisor 唤醒没有工作目录`)
    return { ok: true, ws, role: role.data }
  }

  // ---- 计数 ----

  const todayWakes = (ref: string, now: number) => {
    const today = dayKey(now)
    let wakes = 0
    let autonomous = 0
    let reply = 0
    for (const w of projection.workspace(ref).wakes) {
      if (dayKey(Date.parse(w.ts)) !== today) continue
      if (w.origin === 'reply') reply++
      else if (!w.bypass) {
        wakes++
        if (w.origin === 'autonomous') autonomous++
      }
    }
    return { date: today, wakes, autonomous, reply }
  }

  const pauseOf = (ref: string, queue: TaskOrigin) => {
    const q = projection.workspace(ref).queues[queue]
    if (q.failures < 2 || q.lastFailTs === null) return null
    return { failures: q.failures, until: Date.parse(q.lastFailTs) + pauseMs(q.failures) }
  }

  // ---- 收件箱条目（幂等：id 由来源确定） ----

  function ensureItem(input: Extract<EventInput, { type: 'inbox.item_created' }>) {
    if (ledger.getInboxItem(input.payload.item_id)) return
    const r = ledger.append(input, { actor: 'hub' })
    if (!r.ok && r.error.code !== 'duplicate_item') {
      logger.warn('supervisor 收件箱条目写入失败', r.error)
    }
  }

  function limitItem(ref: string, kind: 'total' | 'autonomous', max: number, date: string) {
    const id = wsId(ref)
    const what = kind === 'total' ? '普通唤醒' : '自主（巡检、回看）唤醒'
    const key = kind === 'total' ? 'wakes_per_day' : 'autonomous_wakes_per_day'
    const queue = kind === 'total' ? 'instruction' : 'autonomous'
    ensureItem({
      type: 'inbox.item_created',
      workspace: ref,
      payload: {
        item_id: `wake.${kind === 'total' ? 'limit' : 'alimit'}.${id}.${date}`,
        level: 'decide',
        source: 'supervisor',
        source_ref: ref,
        reason: 'wake_limit',
        title: `${ref} 今日唤醒已达上限`,
        body: [
          `今天的${what}已达 ${max} 次（supervisor.limits.${key}），新事件留在队列中，明天自动继续。`,
          `需要现在处理：flow supervisor wake ${id} --release ${queue}（放行一次，不计入上限）。`,
        ].join('\n'),
        actions: [],
      },
    })
  }

  function pausedItem(
    ref: string,
    queue: TaskOrigin,
    wakeId: string,
    failures: number,
    until: number,
  ) {
    const id = wsId(ref)
    const task = ledger.getTask(wakeId)
    const why = task?.result?.summary ?? ''
    ensureItem({
      type: 'inbox.item_created',
      workspace: ref,
      task_id: wakeId,
      payload: {
        item_id: `wake.fail.${wakeId}`,
        level: 'interrupt',
        source: 'supervisor',
        source_ref: wakeId,
        reason: 'wake_failed',
        title: `${ref} 的 supervisor 唤醒连续失败，${queue} 队列已暂停`,
        body: clipText(
          [
            `唤醒任务 ${wakeId} 失败（连续第 ${failures} 次）${why ? `：${why}` : ''}。`,
            `${queue} 队列已暂停：新事件继续排队，${new Date(until).toLocaleString()} 自动恢复一次。`,
            `立即放行：flow supervisor wake ${id} --release ${queue}`,
          ].join('\n'),
          4000,
        ),
        actions: [],
      },
    })
  }

  // ---- 唤醒内容（只供提示词，D1） ----

  const eventAt = (seq: number): LedgerEvent | null => ledger.eventsAfter(seq - 1, {}, 1)[0] ?? null

  function describe(ev: LedgerEvent): Omit<WakeEventInput, 'seq' | 'type' | 'ts'> {
    const task = ev.task_id === undefined ? null : ledger.getTask(ev.task_id)
    const who = task ? `任务 ${task.id}（${task.contract.role}）` : `任务 ${ev.task_id ?? '?'}`
    const base = ev.task_id === undefined ? {} : { task_id: ev.task_id }
    switch (ev.type) {
      case 'user.instruction':
        return {
          summary: clip(ev.payload.text, WAKE_EVENT_SUMMARY_MAX),
          data: { via: ev.payload.via },
        }
      case 'schedule.fired':
        return {
          summary: `定时巡检（规则 ${ev.payload.rule_id}，计划 ${ev.payload.planned_at}${ev.payload.missed ? '，补发' : ''}）`,
        }
      case 'decision.review_due':
        return {
          summary: `决策到了回看日期：${ev.payload.path}（${ev.payload.review_date}）`,
          data: { path: ev.payload.path, review_date: ev.payload.review_date },
        }
      case 'task.done':
      case 'task.failed':
      case 'task.cancelled': {
        const result = ev.type === 'task.done' ? ev.payload.result : ev.payload.result
        const message =
          ev.type === 'task.failed'
            ? (ev.payload.message ?? result?.summary)
            : ev.type === 'task.cancelled'
              ? (ev.payload.reason ?? result?.summary)
              : result?.summary
        const prs = (result?.artifacts ?? []).filter((a) => a.kind === 'pr').map((a) => a.ref)
        return {
          ...base,
          summary: clip(
            `${who}${STATUS_LABEL[ev.type.slice(5)] ?? ev.type}${message ? `：${message}` : ''}`,
            WAKE_EVENT_SUMMARY_MAX,
          ),
          data: {
            status: ev.type.slice(5),
            ...(task ? { goal: clip(task.contract.goal, 500) } : {}),
            ...(result?.reason ? { reason: result.reason } : {}),
            ...(prs.length ? { prs } : {}),
            ...(result?.review ? { review: result.review } : {}),
          },
        }
      }
      case 'task.blocked':
        return {
          ...base,
          summary: clip(
            `${who}卡住（${ev.payload.reason}）：${ev.payload.message}`,
            WAKE_EVENT_SUMMARY_MAX,
          ),
          data: { reason: ev.payload.reason, tail: (ev.payload.tail ?? []).slice(-TAIL_LINES) },
        }
      case 'supervisor.answered':
        return {
          summary: clip(
            `用户回答了提问 ${ev.payload.item_id}：${ev.payload.text}`,
            WAKE_EVENT_SUMMARY_MAX,
          ),
          data: { item_id: ev.payload.item_id },
        }
      case 'task_proposal.accepted':
        return {
          summary: `任务提案 ${ev.payload.proposal_id} 已被接受，建了任务 ${ev.payload.task_id}`,
          data: { proposal_id: ev.payload.proposal_id, task_id: ev.payload.task_id },
        }
      case 'task_proposal.rejected':
        return {
          summary: clip(
            `任务提案 ${ev.payload.proposal_id} 被驳回${ev.payload.note ? `：${ev.payload.note}` : ''}`,
            WAKE_EVENT_SUMMARY_MAX,
          ),
          data: { proposal_id: ev.payload.proposal_id },
        }
      case 'task.reply_delegated':
        return { ...base, ...describeDelegation(ev) }
      default:
        return base
    }
  }

  /** D15 "上下文"：卡住说明、终端末尾、请求的命令与理由、任务目标与角色、diff_stat。 */
  function describeDelegation(ev: Extract<LedgerEvent, { type: 'task.reply_delegated' }>) {
    const p = ev.payload
    const task = ledger.getTask(p.task_id)
    const blocked = eventAt(p.block_seq)
    const b = blocked?.type === 'task.blocked' ? blocked.payload : null
    const decision = p.decision_id === undefined ? null : eventAt(p.decision_id)
    const request = decision?.type === 'policy.decided' ? decision.payload.request : null
    const kind = p.kind === 'question' ? '提问' : '授权请求'
    return {
      summary: clip(
        `任务 ${p.task_id}（${task?.contract.role ?? '?'}）的${kind}委托给你代回复：${b?.message ?? ''}`,
        WAKE_EVENT_SUMMARY_MAX,
      ),
      data: {
        block_seq: p.block_seq,
        kind: p.kind,
        deadline: p.deadline,
        ...(p.decision_id === undefined ? {} : { decision_id: p.decision_id }),
        ...(b ? { message: clip(b.message), tail: (b.tail ?? []).slice(-TAIL_LINES) } : {}),
        ...(b?.diff_stat ? { diff_stat: b.diff_stat } : {}),
        ...(request
          ? {
              request: {
                tool: request.tool,
                actions: request.actions,
                ...(request.command === undefined ? {} : { command: clip(request.command) }),
              },
            }
          : {}),
        ...(task ? { goal: clip(task.contract.goal), role: task.contract.role } : {}),
      },
    }
  }

  function wakeEvents(events: readonly QueuedEvent[], bare: boolean): WakeEventInput[] {
    return events.map((q) => {
      const ev = eventAt(q.seq)
      const head = {
        seq: q.seq,
        type: ev?.type ?? q.type,
        ts: ev?.ts ?? q.ts,
        ...(q.task_id === undefined ? {} : { task_id: q.task_id }),
      }
      return bare || !ev ? head : { ...head, ...describe(ev) }
    })
  }

  // ---- 创建唤醒 ----

  async function createWake(
    a: Extract<Availability, { ok: true }>,
    origin: Queue,
    events: QueuedEvent[],
    note?: string,
  ): Promise<WakeState | null> {
    const ref = a.ws.ref
    const generation = projection.workspace(ref).generation + 1
    const seqs = events.map((e) => e.seq)
    const contract = (bare: boolean): TaskContractInput => ({
      goal:
        origin === 'reply'
          ? `supervisor 代回复唤醒（第 ${generation} 代）：只处理 inputs.wake 中委托给你的 ${events.length} 次卡住，只能用 task_respond 与只读操作。`
          : `supervisor 唤醒（${origin}，第 ${generation} 代，${events.length} 个事件）：先读 ws_brief，再按 inputs.wake 处理。`,
      workspace: ref,
      role: a.role.name,
      executor: 'claude-sdk',
      cwd: a.ws.repos[0] as string,
      ...(origin === 'reply' ? {} : { retry: { max_attempts: WAKE_MAX_ATTEMPTS } }),
      inputs: {
        wake: {
          origin,
          generation,
          events: wakeEvents(events, bare),
          ...(note ? { note } : {}),
        },
      },
    })
    const create = (bare: boolean) =>
      o.tasks.createTask(contract(bare), {
        actor: 'hub',
        idempotency_key: `supervisor:${ref}:${generation}`,
        ...(origin === 'reply' ? {} : { origin }),
        withCreated: (taskId) => [
          {
            type: 'supervisor.wake_started',
            task_id: taskId,
            workspace: ref,
            payload: { task_id: taskId, workspace: ref, origin, events: seqs, generation },
          },
        ],
      })
    let r = await create(false)
    // 事件说明里有疑似密钥时退回只带事件引用（seq、类型、任务），唤醒照常进行。
    if (!r.ok && r.error.code === 'secret_suspected') r = await create(true)
    if (!r.ok) {
      logger.warn('supervisor 唤醒创建失败', { workspace: ref, origin, error: r.error })
      return null
    }
    return projection.wake(r.data.task.id)
  }

  // ---- 调度 ----

  function arm(ref: string, at: number | null) {
    timers.get(ref)?.()
    timers.delete(ref)
    if (at === null || stopped) return
    timers.set(
      ref,
      clock.setTimeout(
        () => {
          timers.delete(ref)
          schedule(ref)
        },
        Math.max(0, at - clock.now()),
      ),
    )
  }

  async function pumpOnce(ref: string) {
    const a = await availability(ref)
    if (stopped) return
    const now = clock.now()
    const replyPending = () =>
      projection.pending(ref, 'reply').filter((q) => {
        if (q.task_id === undefined) return false
        const d = ledger.activeDelegation(q.task_id)
        return d !== null && d.seq === q.seq
      })
    if (!a.ok) {
      const delegations = replyPending()
      if (delegations.length)
        o.onReplyUnavailable?.({ workspace: ref, reason: 'unavailable', delegations })
      arm(ref, null)
      return
    }
    const limits = a.ws.supervisor.limits
    let wakeAt: number | null = null
    const later = (t: number) => {
      wakeAt = wakeAt === null ? t : Math.min(wakeAt, t)
    }

    // 普通唤醒。
    if (!projection.openWake(ref, 'normal')) {
      const ws = projection.workspace(ref)
      const order: TaskOrigin[] = [
        ...NORMAL_QUEUES.filter((q) => ws.queues[q].releasePending),
        ...NORMAL_QUEUES.filter((q) => !ws.queues[q].releasePending),
      ]
      for (const queue of order) {
        const q = ws.queues[queue]
        const pause = pauseOf(ref, queue)
        if (pause && !q.releasePending && q.lastFailedWake) {
          pausedItem(ref, queue, q.lastFailedWake, pause.failures, pause.until)
        }
        const pending = projection.pending(ref, queue)
        if (pending.length === 0) continue
        const bypass = q.releasePending || q.failures === 1
        if (!bypass) {
          if (pause && now < pause.until) {
            later(pause.until)
            continue
          }
          const today = todayWakes(ref, now)
          if (today.wakes >= limits.wakes_per_day) {
            limitItem(ref, 'total', limits.wakes_per_day, today.date)
            later(nextDay(now))
            continue
          }
          if (queue === 'autonomous' && today.autonomous >= limits.autonomous_wakes_per_day) {
            limitItem(ref, 'autonomous', limits.autonomous_wakes_per_day, today.date)
            later(nextDay(now))
            continue
          }
        }
        const note = q.releasePending
          ? '用户手动放行了这条队列'
          : q.failures === 1
            ? '上一次唤醒失败，这是重试'
            : pause
              ? '队列暂停后自动恢复'
              : undefined
        await createWake(a, queue, pending.slice(0, WAKE_EVENTS_MAX), note)
        break
      }
    }

    // reply 唤醒（D15）。
    const delegations = replyPending()
    if (delegations.length > 0) {
      const open = projection.openWake(ref, 'reply')
      if (open) {
        if (ledger.getTask(open.task_id)?.status === 'blocked') {
          o.onReplyUnavailable?.({ workspace: ref, reason: 'blocked', delegations })
        }
      } else if (todayWakes(ref, now).reply >= limits.reply_wakes_per_day) {
        o.onReplyUnavailable?.({ workspace: ref, reason: 'quota', delegations })
      } else {
        await createWake(a, 'reply', delegations.slice(0, WAKE_EVENTS_MAX))
      }
    }
    arm(ref, wakeAt)
  }

  function schedule(ref: string): Promise<void> {
    let c = chains.get(ref)
    if (c?.busy) {
      c.dirty = true
      return c.running
    }
    const entry = { running: Promise.resolve(), dirty: false, busy: true }
    entry.running = (async () => {
      try {
        do {
          entry.dirty = false
          if (stopped) break
          try {
            await pumpOnce(ref)
          } catch (err) {
            logger.warn('supervisor 唤醒调度失败', { workspace: ref, error: String(err) })
          }
        } while (entry.dirty)
      } finally {
        entry.busy = false
      }
    })()
    c = entry
    chains.set(ref, c)
    return c.running
  }

  function onEvent(event: LedgerEvent) {
    const ref = projection.apply(event)
    if (ref !== null && !stopped) queueMicrotask(() => void schedule(ref))
  }

  // ---- 用户接口 ----

  async function placement(
    ref: string,
    seqField: { instruction_seq?: number; release_seq?: number },
    seq: number,
    queue: TaskOrigin,
  ): Promise<Result<SupervisorWakeData>> {
    await schedule(ref)
    const ws = projection.workspace(ref)
    const base = { workspace: ref, ...seqField }
    // 本次请求之后创建、包含该事件（指令）或属于该队列（放行）的唤醒。
    const started = ws.wakes.find(
      (w) =>
        w.seq > seq &&
        (w.events.includes(seq) || (seqField.release_seq !== undefined && w.origin === queue)),
    )
    if (started) {
      const s = summaryOf(started)
      return ok({
        ...base,
        state: 'started',
        wake: s,
        message: `已唤醒 supervisor，任务 ${s.task_id}`,
      })
    }
    const pending = projection.pending(ref, queue)
    if (seqField.release_seq !== undefined && pending.length === 0) {
      return ok({
        ...base,
        state: 'empty',
        message: `${queue} 队列没有待处理事件；暂停与今日上限已解除，下一个事件到达即唤醒`,
      })
    }
    const open = projection.openWake(ref, 'normal')
    if (open) {
      const s = summaryOf(open)
      return ok({
        ...base,
        state: 'queued',
        reason: 'busy',
        running: s,
        message: `已排队，前面有一次唤醒在运行（${s.task_id}，${s.status}）`,
      })
    }
    const pause = pauseOf(ref, queue)
    if (pause && clock.now() < pause.until) {
      return ok({
        ...base,
        state: 'queued',
        reason: 'paused',
        message: `已排队；${queue} 队列因连续失败暂停到 ${new Date(pause.until).toLocaleString()}，可用 --release ${queue} 放行`,
      })
    }
    const a = await availability(ref)
    if (a.ok) {
      const limits = a.ws.supervisor.limits
      const today = todayWakes(ref, clock.now())
      if (
        today.wakes >= limits.wakes_per_day ||
        (queue === 'autonomous' && today.autonomous >= limits.autonomous_wakes_per_day)
      ) {
        return ok({
          ...base,
          state: 'queued',
          reason: 'daily_limit',
          message: `已排队；今日唤醒已达上限，明天继续，或用 --release ${queue} 放行一次`,
        })
      }
    }
    return ok({
      ...base,
      state: 'queued',
      reason: 'unavailable',
      message: '已排队，暂时无法唤醒（见 flow supervisor status）',
    })
  }

  async function userWrite(ref: string, draft: EventInput) {
    const a = await availability(ref)
    if (!a.ok) return fail('failure', a.code, a.reason, { workspace: ref })
    return ledger.append(draft, { actor: 'user' })
  }

  return {
    start() {
      stopped = false
      for (let after = projection.position(); ; ) {
        const batch = ledger.eventsAfter(after, {}, 1000)
        if (batch.length === 0) break
        for (const e of batch) projection.apply(e)
        after = batch[batch.length - 1]?.seq ?? after
      }
      unsubscribe = ledger.subscribe(onEvent)
      for (const ref of projection.workspaces()) void schedule(ref)
    },
    stop() {
      stopped = true
      unsubscribe?.()
      unsubscribe = undefined
      for (const cancel of timers.values()) cancel()
      timers.clear()
    },
    async idle() {
      for (;;) {
        await new Promise<void>((r) => queueMicrotask(r))
        const running = [...chains.values()].filter((c) => c.busy).map((c) => c.running)
        if (running.length === 0) return
        await Promise.all(running)
      }
    },
    pump: (ref) => schedule(ref),
    async instruct(ref, text, via) {
      const r = await userWrite(ref, {
        type: 'user.instruction',
        workspace: ref,
        payload: { text: text ?? MANUAL_WAKE_TEXT, via },
      })
      if (!r.ok) return r
      return placement(ref, { instruction_seq: r.data.seq }, r.data.seq, 'instruction')
    },
    async release(ref, queue) {
      const r = await userWrite(ref, {
        type: 'supervisor.release',
        workspace: ref,
        payload: { queue },
      })
      if (!r.ok) return r
      return placement(ref, { release_seq: r.data.seq }, r.data.seq, queue)
    },
    async status(ref) {
      let list: WorkspaceInfo[]
      if (ref !== undefined) {
        const ws = await o.workspaces(ref)
        if (!ws) return fail('failure', 'unknown_workspace', `workspace ${ref} 未定义`)
        list = [ws]
      } else {
        list = await o.listWorkspaces()
      }
      const now = clock.now()
      const out: SupervisorWorkspaceStatus[] = []
      for (const ws of list) {
        const a = await availability(ws.ref)
        const w = projection.workspace(ws.ref)
        const today = todayWakes(ws.ref, now)
        const current = projection.openWake(ws.ref, 'normal')
        const reply = projection.openWake(ws.ref, 'reply')
        const last = [...w.wakes].reverse().find((x) => x.status !== 'open')
        const paused = (q: TaskOrigin) => {
          const p = pauseOf(ws.ref, q)
          return p && now < p.until && !w.queues[q].releasePending
            ? { failures: p.failures, until: new Date(p.until).toISOString() }
            : null
        }
        const limits = ws.supervisor.limits
        out.push({
          workspace: ws.ref,
          enabled: a.ok,
          reason: a.ok ? null : a.reason,
          current: current ? summaryOf(current) : null,
          reply: reply ? summaryOf(reply) : null,
          queues: {
            instruction: projection.pending(ws.ref, 'instruction').length,
            autonomous: projection.pending(ws.ref, 'autonomous').length,
            reply: projection.pending(ws.ref, 'reply').length,
          },
          paused: { instruction: paused('instruction'), autonomous: paused('autonomous') },
          release_pending: NORMAL_QUEUES.filter((q) => w.queues[q].releasePending),
          today: {
            ...today,
            wakes_per_day: limits.wakes_per_day,
            autonomous_wakes_per_day: limits.autonomous_wakes_per_day,
            reply_wakes_per_day: limits.reply_wakes_per_day,
          },
          last: last ? summaryOf(last) : null,
        })
      }
      return ok({ workspaces: out })
    },
    projection: () => projection,
  }
}

export type { WakeOrigin }
