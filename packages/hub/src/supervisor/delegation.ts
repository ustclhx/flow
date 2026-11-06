import {
  type ActiveDelegation,
  DELEGABLE_BLOCKED_REASONS,
  delegationEnabled,
  delegationRequestMatches,
  type EventOf,
  fail,
  type InboxItemView,
  type IndexedPolicyRule,
  type LedgerEvent,
  observeFor,
  ok,
  type PolicyConfig,
  policyVersion,
  type ReplyEscalationReason,
  type Result,
  type Role,
  SUPERVISOR_ACTOR,
  type SupervisorObserveConfig,
  type TaskRespondData,
  type TaskRespondRequest,
} from '@raindown/core'
import type { EventInput, LedgerStore } from '../ledger/store.ts'
import { HUB_ACTOR, taskKind } from '../ledger/supervisor-checks.ts'
import { generateReplyId, type RoleLookup, type WorkspaceLookup } from '../ledger/tasks.ts'
import { approvalAuthorization } from '../policy/approval.ts'
import type { HubClock } from '../server/clock.ts'
import type { HubLogger } from '../server/maintenance.ts'
import type { WakeCaller } from '../server/wake-tokens.ts'
import type { QueuedEvent } from './projection.ts'
import type { ReplyUnavailableReason } from './scheduler.ts'

/**
 * 卡住时由 supervisor 代用户回复（add-m1-supervisor D15；tasks 3.5、4.9）。
 *
 * **委托判定**：任务进入 `blocked(question | awaiting_approval)` 时判定是否委托；**任何一项不确定都不委托**，
 * 条目照常交给用户。核对一律取自账本与投影（卡住事件、策略判定事件、任务合同与角色配置），不取自
 * supervisor 或 worker 可控的字段：
 * - workspace `delegationEnabled`（`ws/global` 恒为否）；
 * - 排除：唤醒任务自身、有效类别为 merge（或 supervisor）的任务、角色在 `reviewer_roles` 中的任务、
 *   带 `prior_reason`（node_lost 遗留）或 `no_delegate` 的卡住、已请求取消的任务、已有待送达回复的任务、
 *   条目已被用户关闭的卡住；中枢侧对 `no_delegate` 独立兜底：同一 running 区间（最近一次 `task.started`
 *   之后）出现过被节点拒收（dropped）的 supervisor 回复，之后的卡住一律不委托；角色查不到也不委托；
 * - question：只委托 worker 明确上报（basis=reported）的提问；旧事件缺省视为 inferred；
 * - awaiting_approval：卡住时节点持有租约（`lease_held`）、`decision_id` 指向本任务、由策略引擎写入、
 *   档位为 `supervisor` 的 `policy.decided`，且卡住上报的请求与判定的请求逐字一致（含工具与路径；
 *   没有命令的请求一律不委托）；"晚于上次离开 blocked"等不变量由 store 再校验一次。
 *
 * **不推送**：判定进行中与委托有效期间，条目由 `held` 挡住、不计入推送（也不计入 Decide 的提前推送阈值）。
 *
 * **转交**（`task.reply_escalated`，hub 写入）：超时（`reply_timeout_s`，时钟可注入）、唤醒不可用
 * （调度器的 `onReplyUnavailable`，以及处理它的 reply 唤醒进入 blocked）、处理它的 reply 唤醒失败
 * （`wake_failed`）或结束时仍未回复（`wake_ended`）。supervisor 已写入回复、等待送达时不再转交。
 * 用户回复、忽略条目的转交由 `tasks.replyTask` 与 `actOnInbox` 在同一次追加中写入（actor user）。
 *
 * **task_respond**：核对放在 store 的同一事务里（`AppendOptions.check`）。
 *
 * **observe**（add-harness-neutral-coordination D10）：委托照常发生、supervisor 照常被唤醒并给出判断。
 * 委托时对应项（question → `observe.replies`，awaiting_approval → `observe.approvals`）已开启的，
 * `task.reply_delegated` 带 `observe: true`；`task_respond` 时委托带 observe、或调用方传入的当前配置已开启，
 * 都按 observe 处理：只写 `task.reply_observed`（workspace 级事件，不带 task_id），**不写 `task.replied`、
 * 不建回复、不重新排队**，随后以 `task.reply_escalated{reason: observe}` 转给用户（同一事务）。
 * store 另有兜底：带 observe 的委托上 supervisor 的 `task.replied` 一律拒绝。
 *
 * 重启恢复：委托与 deadline 都由账本推出；启动时重新布置超时、补上停机期间错过的转交与判定。
 */

export interface DelegationServiceOptions {
  ledger: LedgerStore
  clock: HubClock
  workspaces: WorkspaceLookup
  roles: RoleLookup
  /** 与策略判定共用的加载器：委托前复核审批依据仍然有效。 */
  policy?: {
    load(): Promise<Result<PolicyConfig>>
    version(): string
    current(): PolicyConfig | undefined
  }
  /**
   * 唯一的 supervisor 角色（core `findSupervisorRole`，与唤醒调度器相同）：没有、多个或可写时不委托——
   * 注定唤醒不了的委托只会立即转交，不如直接交给用户。缺省不检查（由调度器按 `wake_unavailable` 转交）。
   */
  supervisorRole?: () => Promise<Result<Role | null>>
  logger?: Pick<HubLogger, 'warn'>
  newReplyId?: () => string
  /**
   * 一次委托判定（读配置等异步部分）的总时限，默认 30 秒：超时即判为不委托、放开条目，
   * 一次挂起的读取不会堵住整条串行处理链。
   */
  decisionTimeoutMs?: number
  /**
   * 条目不再被挡住时（判定为不委托、委托被转交）通知收件箱重新推送；中枢里接 `inbox.pusher.tick`。
   */
  onRelease?: () => void
}

export interface DelegationService {
  /** 订阅账本，重新布置超时，补上停机期间错过的判定与转交。 */
  start(): void
  stop(): void
  /** 等进行中的判定与转交完成（测试与停机用）。 */
  idle(): Promise<void>
  /** 收件箱推送是否暂缓该条目（判定进行中或委托有效）。 */
  held(item: Pick<InboxItemView, 'id' | 'source' | 'task_id'>): boolean
  /** 调度器的 `WakeSchedulerOptions.onReplyUnavailable`：同步写 `wake_unavailable` 转交。 */
  onReplyUnavailable(info: {
    workspace: string
    reason: ReplyUnavailableReason
    delegations: QueuedEvent[]
  }): void
  /** `task_respond`：调用方只取自鉴权中间件按唤醒绑定 token 认定的结果。 */
  respond(
    actor: string,
    caller: WakeCaller | null,
    input: TaskRespondRequest,
    opts?: RespondOptions,
  ): Result<TaskRespondData>
}

export interface RespondOptions {
  /**
   * 调用时读取的该 workspace 当前 observe 配置（D10）：与委托时记录的 observe 取并集——
   * 委托之后才打开 observe 的，判断同样不送达。
   */
  observe?: Pick<SupervisorObserveConfig, 'replies' | 'approvals'>
  /**
   * 回复时 workspace 配置无法读取（路由传入）：按失败即不送达只记录判断，但**不是 observe 模式**——
   * `task.reply_observed.forced` 与转交原因 `config_unavailable` 如实标明，report 不计入一致率。
   */
  forced?: 'config_unavailable'
}

/** 委托判定的默认总时限。 */
export const DECISION_TIMEOUT_MS = 30_000

const DELEGABLE: ReadonlySet<string> = new Set(DELEGABLE_BLOCKED_REASONS)
const TERMINAL: ReadonlySet<string> = new Set(['task.done', 'task.failed', 'task.cancelled'])
const BLOCKED_ITEM_PREFIX = 'blk.'

const UNAVAILABLE_NOTE: Record<ReplyUnavailableReason, string> = {
  unavailable: 'supervisor 当前无法唤醒（未启用、没有 supervisor 角色或配置有误）',
  quota: '今日 reply 唤醒次数已用完',
  blocked: '处理代回复的 supervisor 唤醒卡住了',
}

const notDelegated = (message: string) => fail('failure', 'not_delegated', message)
const staleBlock = (message: string) => fail('failure', 'stale_block', message)
const invalidArguments = (message: string, field: string) =>
  fail('usage', 'invalid_arguments', message, [{ field, code: 'invalid_field', message }])

type Verdict =
  | {
      delegate: true
      timeoutS: number
      policy_version: string
      evaluated_version: string
      matched_rules: IndexedPolicyRule[]
      /** 委托时该项处于 observe 模式（D10）。 */
      observe: boolean
    }
  | { delegate: false; why: string /** 判定本身超时（不是判为不委托）。 */; timedOut?: true }
const no = (why: string): Verdict => ({ delegate: false, why })

export function createDelegationService(o: DelegationServiceOptions): DelegationService {
  const { ledger, clock } = o
  const newReplyId = o.newReplyId ?? generateReplyId
  const decisionTimeoutMs = o.decisionTimeoutMs ?? DECISION_TIMEOUT_MS
  /** 判定进行中的卡住（task.blocked 的 seq）：判定完成前条目不推送。 */
  const deciding = new Set<number>()
  /** 每个任务当前委托的超时定时器（任务 id → 委托 seq 与取消函数）。 */
  const timers = new Map<string, { seq: number; cancel: () => void }>()
  let chain: Promise<void> = Promise.resolve()
  let pendingJobs = 0
  let unsubscribe: (() => void) | undefined
  let stopped = false

  const warn = (what: string, detail: unknown) => o.logger?.warn(what, detail)
  const release = () => {
    try {
      o.onRelease?.()
    } catch (err) {
      warn('代回复：通知收件箱失败', String(err))
    }
  }

  /** 串行执行异步工作；订阅回调里不同步写账本（与收件箱反应器同样的顺序约束）。 */
  function enqueue(job: () => void | Promise<void>) {
    pendingJobs++
    chain = chain
      .then(async () => {
        if (!stopped) await job()
      })
      .catch((err) => warn('代回复处理失败', String(err)))
      .finally(() => {
        pendingJobs--
      })
  }

  const eventAt = (seq: number): LedgerEvent | null => {
    const e = ledger.eventsAfter(seq - 1, {}, 1)[0]
    return e?.seq === seq ? e : null
  }

  function policyBasis(decisionId?: number, delegation?: ActiveDelegation | null) {
    const decision = decisionId === undefined ? null : eventAt(decisionId)
    const delegated = delegation ? eventAt(delegation.seq) : null
    return {
      policy_version:
        (decision?.type === 'policy.decided' ? decision.payload.policy_version : undefined) ??
        (delegated?.type === 'task.reply_delegated'
          ? delegated.payload.policy_version
          : undefined) ??
        policyVersion([]),
      matched_rules:
        decision?.type === 'policy.decided'
          ? decision.payload.matched_rules
          : delegated?.type === 'task.reply_delegated'
            ? (delegated.payload.matched_rules ?? [])
            : [],
    }
  }

  const latestBlockSeq = (taskId: string): number | null => {
    const events = ledger.taskEvents(taskId)
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e?.type === 'task.blocked') return e.seq
    }
    return null
  }

  /** 这次卡住之后是否已写入过回复（supervisor 已回复、等待送达时不再转交）。 */
  const answered = (taskId: string, blockSeq: number) =>
    ledger.taskEvents(taskId).some((e) => e.type === 'task.replied' && e.seq > blockSeq)

  /** 这次卡住是否曾经委托过（已结束的委托上 task_respond 返回 stale_block）。 */
  const everDelegated = (taskId: string, blockSeq: number) =>
    ledger
      .taskEvents(taskId)
      .some((e) => e.type === 'task.reply_delegated' && e.payload.block_seq === blockSeq)

  /**
   * 中枢侧的 `no_delegate` 兜底：最近一次 `task.started` 之后，节点拒收过 supervisor 的回复
   * （ack `dropped` 写出带 `dropped_reply_ids` 的 `task.unblocked`）。
   */
  function supervisorReplyDroppedInRun(taskId: string): boolean {
    const events = ledger.taskEvents(taskId)
    let started = 0
    for (const e of events) if (e.type === 'task.started') started = e.seq
    for (const e of events) {
      if (e.seq <= started || e.type !== 'task.unblocked') continue
      for (const id of e.payload.dropped_reply_ids ?? []) {
        if (ledger.getReply(id)?.by === SUPERVISOR_ACTOR) return true
      }
    }
    return false
  }

  // ---- 委托判定 ----

  /** 只看卡住事件本身就能排除的情况（同步，用于决定是否先挡住推送）。 */
  function candidate(e: EventOf<'task.blocked'>): boolean {
    const p = e.payload
    if (
      !DELEGABLE.has(p.reason) ||
      (p.reason === 'question' && p.basis !== 'reported') ||
      p.no_delegate === true ||
      p.prior_reason !== undefined
    ) {
      return false
    }
    return e.task_id !== undefined && ledger.wakeOf(e.task_id) === null
  }

  async function evaluate(e: EventOf<'task.blocked'>): Promise<Verdict> {
    const p = e.payload
    const taskId = e.task_id as string
    const task = ledger.getTask(taskId)
    if (!task) return no('任务不存在')
    if (ledger.wakeOf(taskId)) return no('唤醒任务自身')
    const ws = await o.workspaces(task.workspace)
    if (!ws) return no('workspace 未定义或配置无法加载')
    if (ws.ref === 'ws/global' || !delegationEnabled(ws)) return no('该 workspace 未启用代回复')
    if (ws.repos.length === 0) return no('workspace 没有登记仓库，supervisor 无法唤醒')
    if (o.supervisorRole) {
      const sup = await o.supervisorRole()
      if (!sup.ok || sup.data === null) return no('没有唯一可用的 supervisor 角色')
    }
    if (ws.supervisor.reviewer_roles.includes(task.contract.role)) return no('审查任务')
    const role = await o.roles(task.contract.role)
    if (!role.ok || role.data === null) return no('角色查不到或加载失败')
    const kind = taskKind(role.data, task.contract, { actor: task.created_by })
    if (kind === 'merge' || kind === 'supervisor') return no(`有效类别为 ${kind}`)
    let approval: EventOf<'policy.decided'> | undefined
    if (p.reason === 'awaiting_approval') {
      if (p.lease_held !== true) return no('授权请求卡住时节点没有持有租约')
      if (p.decision_id === undefined) return no('没有策略判定（decision_id）')
      const decision = eventAt(p.decision_id)
      if (
        decision?.type !== 'policy.decided' ||
        decision.task_id !== taskId ||
        decision.payload.task_id !== taskId ||
        decision.actor !== 'policy'
      ) {
        return no('decision_id 不是本任务的策略判定')
      }
      if (decision.payload.level !== 'supervisor') return no('策略判定不是 supervisor 档位')
      if (decision.seq >= e.seq) return no('策略判定晚于卡住')
      // 判定之后、卡住之前本任务又有别的策略判定：卡住的可能是后一个请求（store 同样拒绝，这里先排除，
      // 不去尝试写入）。
      if (
        ledger
          .taskEvents(taskId)
          .some((x) => x.type === 'policy.decided' && x.seq > decision.seq && x.seq < e.seq)
      ) {
        return no('策略判定之后、卡住之前还有别的策略判定')
      }
      if (!delegationRequestMatches(p.request, decision.payload.request)) {
        return no('卡住上报的请求与策略判定的请求不一致（或没有命令）')
      }
      approval = decision
    }
    const basis = policyBasis(p.reason === 'awaiting_approval' ? p.decision_id : undefined)
    let evaluatedVersion = basis.policy_version
    if (o.policy) {
      // 配置读取完成后才复核：规则可能在 policy.decided 与卡住之间被删除，此时尚无委托可供 watcher 转交。
      const loaded = await o.policy.load()
      if (!loaded.ok) return no('当前策略无法加载')
      if (approval && !approvalAuthorization(loaded.data.rules, task, approval).allowed) {
        return no('审批依据已失效或当前策略不再允许 supervisor 代批')
      }
      evaluatedVersion = loaded.data.version
      if (!approval) basis.policy_version = loaded.data.version
    }
    return {
      delegate: true,
      timeoutS: ws.supervisor.reply_timeout_s,
      evaluated_version: evaluatedVersion,
      observe: observeFor(ws.supervisor, p.reason as (typeof DELEGABLE_BLOCKED_REASONS)[number]),
      ...basis,
    }
  }

  /** 判定通过后的同步段：重新核对投影并写入（与 append 之间没有 await）。 */
  function delegateNow(
    e: EventOf<'task.blocked'>,
    verdict: Extract<Verdict, { delegate: true }>,
  ): boolean {
    if (o.policy && o.policy.version() !== verdict.evaluated_version) return false
    const taskId = e.task_id as string
    const task = ledger.getTask(taskId)
    if (task?.status !== 'blocked' || latestBlockSeq(taskId) !== e.seq) return false
    if (task.cancel_requested) return false
    if (e.payload.reason === 'awaiting_approval' && ledger.activeLease(taskId) === null)
      return false
    if (ledger.pendingReply(taskId) !== null) return false
    const item = ledger.getInboxItem(`${BLOCKED_ITEM_PREFIX}${e.seq}`)
    if (item?.state === 'closed') return false
    if (supervisorReplyDroppedInRun(taskId)) return false
    const kind = e.payload.reason as (typeof DELEGABLE_BLOCKED_REASONS)[number]
    const r = ledger.append(
      {
        type: 'task.reply_delegated',
        task_id: taskId,
        workspace: task.workspace,
        payload: {
          task_id: taskId,
          block_seq: e.seq,
          kind,
          ...(e.payload.decision_id === undefined ? {} : { decision_id: e.payload.decision_id }),
          deadline: new Date(clock.now() + verdict.timeoutS * 1000).toISOString(),
          policy_version: verdict.policy_version,
          matched_rules: verdict.matched_rules,
          ...(verdict.observe ? { observe: true as const } : {}),
        },
      },
      { actor: HUB_ACTOR },
    )
    if (!r.ok) {
      if (r.error.code !== 'not_delegable' && r.error.code !== 'duplicate_delegation') {
        warn('代回复：写入委托失败', { task_id: taskId, block_seq: e.seq, error: r.error })
      }
      return false
    }
    return true
  }

  function decide(e: EventOf<'task.blocked'>) {
    deciding.add(e.seq)
    enqueue(async () => {
      let delegated = false
      let cancelTimer = () => {}
      try {
        const timedOut = new Promise<Verdict>((resolve) => {
          cancelTimer = clock.setTimeout(
            () =>
              resolve({
                delegate: false,
                why: `委托判定超过 ${decisionTimeoutMs} 毫秒`,
                timedOut: true,
              }),
            decisionTimeoutMs,
          )
        })
        // 超时之后到达的判定结果被丢弃（race 只取先到的一个）。
        const verdict = await Promise.race([evaluate(e), timedOut])
        if (!verdict.delegate) {
          if (verdict.timedOut) {
            warn('代回复：委托判定超时，交给用户', { task_id: e.task_id, block_seq: e.seq })
          }
        } else delegated = delegateNow(e, verdict)
      } finally {
        cancelTimer()
        deciding.delete(e.seq)
        if (!delegated) release()
      }
    })
  }

  // ---- 转交 ----

  /**
   * 结束一条委托（hub 写 `task.reply_escalated`）：只在委托仍是 `delegationSeq` 且 supervisor 还没写入回复时。
   * 返回是否写入。
   */
  function escalate(
    taskId: string,
    delegationSeq: number,
    reason: Exclude<ReplyEscalationReason, 'user_replied' | 'user_dismissed'>,
    note?: string,
  ): boolean {
    const task = ledger.getTask(taskId)
    const d = ledger.activeDelegation(taskId)
    if (!task || !d || d.seq !== delegationSeq) return false
    if (answered(taskId, d.block_seq)) return false
    const r = ledger.append(
      {
        type: 'task.reply_escalated',
        task_id: taskId,
        workspace: task.workspace,
        payload: {
          reason,
          block_seq: d.block_seq,
          ...policyBasis(d.decision_id, d),
          ...(reason === 'policy_changed' && o.policy ? { to_version: o.policy.version() } : {}),
          ...(note ? { note } : {}),
        },
      },
      { actor: HUB_ACTOR },
    )
    if (!r.ok) {
      if (r.error.code !== 'not_delegated') {
        warn('代回复：写入转交失败', { task_id: taskId, reason, error: r.error })
      }
      return false
    }
    clearTimer(taskId)
    release()
    return true
  }

  function clearTimer(taskId: string) {
    timers.get(taskId)?.cancel()
    timers.delete(taskId)
  }

  function arm(taskId: string, d: ActiveDelegation) {
    const prev = timers.get(taskId)
    if (prev?.seq === d.seq) return
    prev?.cancel()
    if (stopped) return
    const delay = Math.max(0, Date.parse(d.deadline) - clock.now())
    const cancel = clock.setTimeout(() => {
      if (timers.get(taskId)?.seq === d.seq) timers.delete(taskId)
      escalate(taskId, d.seq, 'timeout', `supervisor 在期限（${d.deadline}）内没有回复`)
    }, delay)
    timers.set(taskId, { seq: d.seq, cancel })
  }

  /** reply 唤醒卡住或结束：转交它分配到、仍有效且尚未回复的委托。 */
  function settleWake(
    wakeTaskId: string,
    reason: 'wake_unavailable' | 'wake_failed' | 'wake_ended',
  ) {
    const wake = ledger.wakeOf(wakeTaskId)
    if (wake?.origin !== 'reply') return
    const note =
      reason === 'wake_unavailable'
        ? UNAVAILABLE_NOTE.blocked
        : reason === 'wake_failed'
          ? '处理代回复的 supervisor 唤醒失败了'
          : '处理代回复的 supervisor 唤醒已结束，但没有回复'
    for (const seq of wake.events) {
      const e = eventAt(seq)
      if (e?.type !== 'task.reply_delegated') continue
      escalate(e.payload.task_id, seq, reason, note)
    }
  }

  function onEvent(e: LedgerEvent) {
    if (stopped) return
    if (e.type === 'task.reply_dropped' && e.task_id !== undefined) {
      // 只清理确已结束的委托；旧回合迟到的拒收不能取消新回合的计时器或放开推送。
      if (!ledger.activeDelegation(e.task_id)) {
        clearTimer(e.task_id)
        enqueue(() => release())
      }
      return
    }
    if (e.type === 'task.reply_escalated' && e.task_id !== undefined) {
      // watcher 也可直接结束委托；立即清理旧计时器，并通知推送器重新处理条目。
      clearTimer(e.task_id)
      enqueue(() => release())
      return
    }
    if (e.type === 'task.blocked' && e.task_id !== undefined) {
      const wake = ledger.wakeOf(e.task_id)
      if (wake) {
        if (wake.origin === 'reply') {
          const id = e.task_id
          enqueue(() => settleWake(id, 'wake_unavailable'))
        }
        return
      }
      if (candidate(e)) decide(e)
      return
    }
    if (TERMINAL.has(e.type) && e.task_id !== undefined) {
      const id = e.task_id
      if (ledger.wakeOf(id)?.origin === 'reply') {
        enqueue(() => settleWake(id, e.type === 'task.failed' ? 'wake_failed' : 'wake_ended'))
      }
      clearTimer(id)
      return
    }
    if (e.type === 'task.cancel_requested' && e.task_id !== undefined) {
      // 请求取消即结束这次卡住上的委托（DELEGATION_ENDING_EVENTS，不写转交事件）：条目立即放开推送，
      // 标题由收件箱反应器恢复。
      const id = e.task_id
      const blockSeq = latestBlockSeq(id)
      if (
        blockSeq !== null &&
        ledger.getTask(id)?.status === 'blocked' &&
        everDelegated(id, blockSeq) &&
        !ledger
          .taskEvents(id)
          .some((x) => x.type === 'task.reply_escalated' && x.payload.block_seq === blockSeq)
      ) {
        clearTimer(id)
        enqueue(() => release())
      }
      return
    }
    if (e.type === 'task.reply_delegated') {
      const id = e.payload.task_id
      enqueue(() => {
        const d = ledger.activeDelegation(id)
        if (d && d.seq === e.seq) arm(id, d)
      })
    }
  }

  /** 启动时的恢复：超时、停机期间错过的转交与判定。 */
  function recover() {
    for (const task of ledger.listTasks({ status: 'blocked', limit: 100_000 })) {
      const d = ledger.activeDelegation(task.id)
      if (d) {
        if (task.blocked?.reason === 'question' && task.blocked.basis !== 'reported') {
          escalate(task.id, d.seq, 'supervisor', '终端推断的提问须由用户回答')
          continue
        }
        arm(task.id, d)
        continue
      }
      // 停机前卡住、还没来得及判定的：条目尚未推送给用户时补判定（同一次卡住只委托一次，由 store 保证）。
      const seq = latestBlockSeq(task.id)
      if (seq === null || everDelegated(task.id, seq)) continue
      const e = eventAt(seq)
      if (e?.type !== 'task.blocked' || !candidate(e)) continue
      const item = ledger.getInboxItem(`${BLOCKED_ITEM_PREFIX}${seq}`)
      if (item && (item.state !== 'open' || item.pushed_at !== null || item.channels.length > 0)) {
        continue
      }
      decide(e)
    }
    for (const e of ledger.eventsByPayload('supervisor.wake_started', 'origin', 'reply')) {
      if (e.task_id === undefined) continue
      const status = ledger.getTask(e.task_id)?.status
      const id = e.task_id
      if (status === 'failed') enqueue(() => settleWake(id, 'wake_failed'))
      else if (status === 'done' || status === 'cancelled')
        enqueue(() => settleWake(id, 'wake_ended'))
      else if (status === 'blocked') enqueue(() => settleWake(id, 'wake_unavailable'))
    }
  }

  return {
    start() {
      if (unsubscribe) return
      stopped = false
      unsubscribe = ledger.subscribe(onEvent)
      recover()
    },
    stop() {
      stopped = true
      unsubscribe?.()
      unsubscribe = undefined
      for (const t of timers.values()) t.cancel()
      timers.clear()
    },
    async idle() {
      while (pendingJobs > 0) await chain
    },
    held(item) {
      if (item.source !== 'task' || item.task_id === null) return false
      if (!item.id.startsWith(BLOCKED_ITEM_PREFIX)) return false
      const seq = Number(item.id.slice(BLOCKED_ITEM_PREFIX.length))
      if (!Number.isSafeInteger(seq)) return false
      if (deciding.has(seq)) return true
      return ledger.activeDelegation(item.task_id)?.block_seq === seq
    },
    onReplyUnavailable(info) {
      for (const q of info.delegations) {
        if (q.task_id === undefined) continue
        escalate(q.task_id, q.seq, 'wake_unavailable', UNAVAILABLE_NOTE[info.reason])
      }
    },
    respond(actor, caller, input, opts = {}) {
      if (actor !== SUPERVISOR_ACTOR) {
        return fail(
          'failure',
          'role_not_allowed',
          `只有 supervisor 能调用 task_respond，当前为 ${actor}`,
        )
      }
      if (!caller) {
        return fail(
          'failure',
          'scope_denied',
          'supervisor 只能通过唤醒绑定 token 调用 task_respond（无法确认本次唤醒）',
        )
      }
      const replyId = newReplyId()
      const task = ledger.getTask(input.task_id)
      const requeue = task !== null && ledger.activeLease(task.id) === null
      const base = { task_id: input.task_id, workspace: task?.workspace ?? caller.workspace }
      const delegation = ledger.activeDelegation(input.task_id)
      const basis = policyBasis(delegation?.decision_id, delegation)
      // observe（D10）：委托时已开启，或调用时的当前配置已开启，都只记录判断、不送达。
      // 配置无法读取（forced）时同样只记录，但如实标明不是 observe。
      const observeConfigured =
        delegation !== null &&
        (delegation.observe === true ||
          (delegation.kind === 'question'
            ? opts.observe?.replies === true
            : opts.observe?.approvals === true))
      const forced = !observeConfigured && delegation !== null ? opts.forced : undefined
      const observing = observeConfigured || forced !== undefined

      /** 全部核对：在写入的同一事务里执行（AppendOptions.check）。 */
      const check = (): Result<null> => {
        const wake = ledger.wakeOf(caller.task_id)
        if (wake?.origin !== 'reply') return notDelegated('本次唤醒不是代回复（reply）唤醒')
        const lease = ledger.getLease(caller.lease_id)
        if (
          lease?.state !== 'active' ||
          lease.task_id !== caller.task_id ||
          Date.parse(lease.expires_at) <= clock.now()
        ) {
          return notDelegated('本次唤醒没有活动租约')
        }
        if (ledger.getTask(caller.task_id)?.status !== 'running') {
          return notDelegated('本次唤醒不在运行中')
        }
        const t = ledger.getTask(input.task_id)
        if (!t) return notDelegated(`没有任务 ${input.task_id}`)
        if (t.workspace !== wake.workspace) {
          return notDelegated(`任务属于 ${t.workspace}，不是本次唤醒绑定的 ${wake.workspace}`)
        }
        if (t.status !== 'blocked') return staleBlock(`任务状态为 ${t.status}，已不在这次卡住`)
        if (latestBlockSeq(t.id) !== input.block_seq) {
          return staleBlock(`block_seq ${input.block_seq} 不是任务当前的卡住`)
        }
        const d = ledger.activeDelegation(t.id)
        if (!d || d.block_seq !== input.block_seq) {
          return everDelegated(t.id, input.block_seq)
            ? staleBlock('这次卡住的委托已结束（已转交用户、超时或用户已回复）')
            : notDelegated('这次卡住没有委托给 supervisor')
        }
        if (!wake.events.includes(d.seq)) return notDelegated('这次委托没有分配给本次唤醒')
        // 写入内容按读取时的委托决定（observe 与否）；委托在此期间被替换时拒绝，不按旧判断写入。
        if (d.seq !== delegation?.seq) return staleBlock('这次卡住的委托已变化，请重新读取')
        if (d.observe === true && !observing) {
          return staleBlock('这次委托处于 observe 模式，判断不能送达')
        }
        // observe 只记录、绝不送达：只与送达有关的前提（待送达回复、节点持有租约、当前策略仍允许代批）
        // 不再检查，判断照常记录并立即转交（D10）。
        if (!observing && ledger.pendingReply(t.id) !== null) {
          return staleBlock('该任务已有尚未送达的回复')
        }
        // 授权请求的批准必须送到仍在等待的那个 worker：节点已不持有租约时，带着批准重新排队会让
        // 下一轮执行（可能是另一个请求）拿到它，拒绝。
        if (!observing && d.kind === 'awaiting_approval' && ledger.activeLease(t.id) === null) {
          return staleBlock('节点已不持有该任务的租约，这次授权请求已不在等待')
        }
        if (!observing && d.kind === 'awaiting_approval' && o.policy) {
          const decision = d.decision_id === undefined ? null : eventAt(d.decision_id)
          const current = o.policy.current()
          if (
            !current ||
            decision?.type !== 'policy.decided' ||
            !approvalAuthorization(current.rules, t, decision).allowed
          ) {
            return staleBlock('审批依据已失效或当前策略不再允许 supervisor 代批')
          }
        }
        if (d.kind === 'question' && t.blocked?.basis !== 'reported') {
          return notDelegated('终端推断的提问须由用户回答')
        }
        if (d.kind === 'question' && (input.decision === 'approve' || input.decision === 'deny')) {
          return invalidArguments('提问只能 answer 或 escalate，不能 approve / deny', 'decision')
        }
        if (d.kind === 'awaiting_approval' && input.decision === 'answer') {
          return invalidArguments('授权请求只能 approve、deny 或 escalate，不能 answer', 'decision')
        }
        return ok(null)
      }

      let drafts: EventInput[]
      let actorOf: string
      if (observing && delegation) {
        // observe：只记录判断并转交用户，不写 task.replied、不建回复、不重新排队（D10）。
        actorOf = HUB_ACTOR
        const ws = base.workspace
        drafts = [
          {
            type: 'task.reply_observed',
            workspace: ws,
            payload: {
              task_id: input.task_id,
              block_seq: input.block_seq,
              delegation_seq: delegation.seq,
              kind: delegation.kind,
              ...(delegation.decision_id === undefined
                ? {}
                : { decision_id: delegation.decision_id }),
              decision: input.decision,
              ...(input.decision === 'answer' && input.text !== undefined
                ? { text: input.text }
                : {}),
              reason: input.reason,
              policy_version: basis.policy_version,
              ...(forced ? { forced } : {}),
            },
          },
          {
            ...base,
            type: 'task.reply_escalated',
            payload: forced
              ? {
                  reason: 'config_unavailable',
                  block_seq: input.block_seq,
                  note: '回复时无法读取该 workspace 的配置，supervisor 的判断未送达，请你来决定',
                  ...basis,
                }
              : {
                  reason: input.decision === 'escalate' ? 'supervisor' : 'observe',
                  block_seq: input.block_seq,
                  // supervisor 主动转交时附它的说明（与非 observe 相同）；observe 判断本身只在 reply_observed 中。
                  ...(input.decision === 'escalate' ? { note: input.reason } : {}),
                  ...basis,
                },
          },
        ]
      } else if (input.decision === 'escalate') {
        actorOf = HUB_ACTOR
        drafts = [
          {
            ...base,
            type: 'task.reply_escalated',
            payload: {
              reason: 'supervisor',
              block_seq: input.block_seq,
              note: input.reason,
              ...basis,
            },
          },
        ]
      } else {
        actorOf = SUPERVISOR_ACTOR
        const kind =
          input.decision === 'answer' ? 'text' : input.decision === 'approve' ? 'approve' : 'deny'
        const session = task?.blocked?.session
        drafts = [
          {
            ...base,
            type: 'task.replied',
            payload: {
              reply_id: replyId,
              kind,
              via: 'supervisor',
              ...(input.text === undefined ? {} : { text: input.text }),
              reason: input.reason,
              ...basis,
            },
          },
          ...(requeue
            ? [
                ...(task &&
                task.attempt > 0 &&
                !ledger
                  .taskEvents(task.id)
                  .some(
                    (e) => e.type === 'task.attempt_ended' && e.payload.attempt === task.attempt,
                  )
                  ? [
                      {
                        ...base,
                        type: 'task.attempt_ended' as const,
                        payload: { attempt: task.attempt, reason: 'blocked' as const },
                      },
                    ]
                  : []),
                {
                  ...base,
                  type: 'task.requeued_with_reply' as const,
                  payload: { reply_id: replyId, ...(session ? { session } : {}) },
                },
              ]
            : []),
        ]
      }
      const written = ledger.appendMany(drafts, { actor: actorOf, check })
      if (!written.ok) {
        // observe 下判断无法记录（例如判断类型与卡住不符）时不等 reply_timeout_s：委托仍有效且分配给本次唤醒，
        // 就立即转交用户（原因 observe；配置无法读取时为 config_unavailable）。
        if (observing && delegation) {
          const wake = ledger.wakeOf(caller.task_id)
          const d = ledger.activeDelegation(input.task_id)
          if (
            wake?.origin === 'reply' &&
            d?.seq === delegation.seq &&
            wake.events.includes(d.seq)
          ) {
            escalate(
              input.task_id,
              d.seq,
              forced ? 'config_unavailable' : 'observe',
              `supervisor 的判断无法记录（${written.error.code}），已转交给你`,
            )
          }
        }
        return written
      }
      if (input.decision === 'escalate' || observing) {
        clearTimer(input.task_id)
        release()
      }
      const after = ledger.getTask(input.task_id)
      if (!after) return fail('failure', 'internal_error', '任务写入后不可见')
      if (observing) {
        return ok({
          task: after,
          decision: input.decision,
          reply: null,
          requeued: false,
          observed: true as const,
        })
      }
      return ok({
        task: after,
        decision: input.decision,
        reply: input.decision === 'escalate' ? null : ledger.getReply(replyId),
        requeued: input.decision !== 'escalate' && requeue,
      })
    },
  }
}
