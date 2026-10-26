import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  type AckReplyData,
  type AcquireLeaseData,
  ackReplyRequest,
  acquireLeaseRequest,
  type CompleteLeaseData,
  type CompleteLeaseRequest,
  capabilitiesSatisfy,
  clipDiffStat,
  completeLeaseRequest,
  fail,
  type LeaseGrant,
  type LeaseSlots,
  type LedgerEvent,
  leaseSlotFor,
  type NodeView,
  ok,
  type RenewLeaseData,
  type RenewLeaseRequest,
  type ReplyView,
  type Result,
  registerNodeRequest,
  renewLeaseRequest,
  sanitizeMessage,
  sanitizeTail,
  type TaskView,
  type WakeOrigin,
} from '@flow/core'
import type { z } from 'zod'
import type { EventInput, LeaseRecord, LedgerStore } from '../ledger/store.ts'
import { fieldIssues } from '../ledger/tasks.ts'
import { type HubClock, systemClock } from '../server/clock.ts'

/**
 * 节点协议的中枢侧（tasks.md 4.1；node-protocol spec；design D4）。
 *
 * - 注册：写 `node.registered`，刷新 `last_seen_at`。
 * - 领取：同步代码里"选出第一个满足能力的 queued 任务 → 同一事务写 `task.started` + `lease.granted`"。
 *   JS 单线程、SQLite 同步 API，选择与写入之间没有 await，两个请求不会交错；即便交错，
 *   store 的校验（task.started 只接受 queued、lease.granted 拒绝第二个活动租约）也会让后者失败，
 *   这里遇到 invalid_transition 时换下一个任务重试。
 * - 执行槽（add-m1-supervisor D12）：请求带 `slots` 时只分配有可用空位的任务——普通任务只用
 *   general，普通唤醒可用 supervisor 或 general，reply 唤醒可用 reply 或 general；
 *   唤醒身份以账本 `supervisor.wake_started` 为准（`leaseSlotFor`）。不带 `slots` 的请求
 *   （旧节点、新节点的普通循环）只有普通空位；唤醒要分给普通空位前，先交给同一节点正在等待、
 *   类别匹配的预留槽领取，避免挤占普通槽。
 * - 无可领取任务时挂入内存等待队列（不进投影），`task.created` / `task.requeued` 到来时唤醒。
 * - 续约 / 提交校验租约令牌（账本只存 SHA-256）；租约已不是 active（过期或已被处理）时返回
 *   `lease_expired`。
 * - 过期扫描：按合同 retry 决定 `task.requeued(lease_expired)` 或 `task.blocked(node_lost)`，
 *   同一事务先写 `task.lease_expired`。
 *
 * 交互式执行器 blocked 期间持有租约（add-m1-executors D7a）：
 * - 续约可以带 `blocked`（写 `task.blocked`，lease_held=true，租约不释放）或 `resumed`（写 `task.unblocked`）；
 * - blocked 任务的续约响应带上最早一条待送达的回复；节点送达后调用 ack-reply，中枢在同一事务中
 *   写 `task.unblocked`（带 reply_id）并把回复标记为已送达；worker 已不在时写 `task.requeued_with_reply`；
 * - 持有租约的 blocked 任务租约过期：记 `task.lease_expired`，有待送达回复时同一事务带着回复重新排队，
 *   已请求取消时直接取消，否则保持 blocked（之后的回复会让它重新排队）。
 */

export interface NodeProtocolConfig {
  /** 租约有效期秒数（hub.yaml lease_ttl_s）。 */
  leaseTtlS: number
  /** long-poll 最长等待秒数（hub.yaml lease_wait_max_s）。 */
  leaseWaitMaxS: number
}

export interface NodeServiceOptions extends NodeProtocolConfig {
  ledger: LedgerStore
  clock?: HubClock
  newLeaseId?: () => string
  newLeaseToken?: () => string
  /**
   * 唤醒绑定 token 的签发（add-m1-supervisor D6）：领到 supervisor 唤醒任务时调用，返回值随租约下发
   * （`wake_token`）；不是唤醒任务时返回 undefined。缺省不签发。
   */
  issueWakeToken?: (grant: { lease_id: string; task_id: string }) => string | undefined
}

export interface AcquireOptions {
  /** 请求方断开或中枢停止时中止等待。 */
  signal?: AbortSignal
}

export interface NodeService {
  registerNode(body: unknown, actor: string): Result<{ node: NodeView }>
  listNodes(): Result<{ nodes: NodeView[] }>
  acquire(body: unknown, opts?: AcquireOptions): Promise<Result<AcquireLeaseData>>
  renew(leaseId: string, body: unknown): Result<RenewLeaseData>
  complete(leaseId: string, body: unknown): Result<CompleteLeaseData>
  ackReply(leaseId: string, body: unknown): Result<AckReplyData>
  /** 处理全部已到期的活动租约，返回处理的数量。 */
  expireDue(): number
  /** 当前挂起的 long-poll 数（测试与诊断）。 */
  waiting(): number
  /** 结束全部等待（返回空结果）并取消订阅。 */
  close(): void
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** `task.unblocked` 的说明：回复者与回复摘要。 */
function replyNote(reply: ReplyView): string {
  const what = reply.kind === 'approve' ? '批准' : reply.kind === 'deny' ? '拒绝' : '回复'
  const text = reply.text
    ? `：${reply.text.length > 200 ? `${reply.text.slice(0, 200)}…` : reply.text}`
    : ''
  return `${reply.by} ${what}${text}`
}

function tokenMatches(token: string, expectedHex: string): boolean {
  const a = Buffer.from(sha256(token), 'hex')
  const b = Buffer.from(expectedHex, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

const defaultLeaseId = () => `l-${randomBytes(8).toString('hex')}`
const defaultLeaseToken = () => randomBytes(32).toString('base64url')

function parse<S extends z.ZodType>(schema: S, body: unknown, what: string): Result<z.infer<S>> {
  const parsed = schema.safeParse(body)
  if (parsed.success) return ok(parsed.data as z.infer<S>)
  const fields = fieldIssues(parsed.error.issues, body)
  return fail(
    'usage',
    'invalid_arguments',
    `${what}不合法：${fields.map((f) => f.message).join('；')}`,
    fields,
  )
}

/** 持有活动租约时允许续约的任务状态；blocked 且租约仍是 active 即 lease_held（D7a）。 */
const RENEWABLE: ReadonlySet<TaskView['status']> = new Set(['running', 'verifying', 'blocked'])

/** 唤醒等待者的事件：有任务可能变为 queued。 */
const WAKING: ReadonlySet<LedgerEvent['type']> = new Set([
  'task.created',
  'task.requeued',
  'hub.rebuilt',
])

/**
 * 卡住上报中与代回复相关的可选字段（D15）：原样带入 `task.blocked`；旧节点不带时省略。
 * `diff_stat` 是自由文本，入账前由 scrub 脱敏。
 */
function delegationFields(b: {
  decision_id?: number | undefined
  diff_stat?: string | undefined
  no_delegate?: boolean | undefined
}) {
  return {
    ...(b.decision_id !== undefined ? { decision_id: b.decision_id } : {}),
    // 协议允许 8192 字符，入账前截到 2000（clipDiffStat，与 scrub 的 clipText 同一截断标记）。
    ...(b.diff_stat !== undefined ? { diff_stat: clipDiffStat(b.diff_stat) } : {}),
    ...(b.no_delegate !== undefined ? { no_delegate: b.no_delegate } : {}),
  }
}

/**
 * 提交结束对应的事件（纯函数）。
 * 任务已处于 blocked（交互式卡住期间 worker 崩溃或这一轮直接以 blocked 结束）时，
 * 写 blocked → blocked（lease_held=false）；此时若有待送达的回复，同一事务带着回复重新排队，
 * 回复不会被静默丢弃（PR #16 审查第 5 条）。末尾输出与说明入账前脱敏、限长（第 7 条）。
 */
export function completionDrafts(
  task: TaskView,
  lease: LeaseRecord,
  req: CompleteLeaseRequest,
  pendingReply: ReplyView | null = null,
): EventInput[] {
  const base = { task_id: task.id, workspace: task.workspace }
  switch (req.outcome) {
    case 'done':
      return [{ ...base, type: 'task.done', payload: { result: req.result } }]
    case 'failed':
      return [{ ...base, type: 'task.failed', payload: { result: req.result } }]
    case 'blocked': {
      const session = req.session ?? task.blocked?.session
      const blocked: EventInput = {
        ...base,
        type: 'task.blocked',
        payload: {
          reason: req.blocked_reason,
          message: sanitizeMessage(req.message),
          ...(req.tail ? { tail: sanitizeTail(req.tail) } : {}),
          ...(session ? { session } : {}),
          ...delegationFields(req),
          node_id: lease.node_id,
          lease_held: false,
        },
      }
      // 已请求取消：不论有没有回复，都以 cancelled 结束，不让重新排队覆盖取消（复核第 2 条）。
      if (task.cancel_requested) {
        return [
          {
            ...base,
            type: 'task.cancelled',
            payload: {
              reason: sanitizeMessage(`已请求取消；worker 结束：${req.message}`),
              node_id: lease.node_id,
            },
          },
        ]
      }
      if (task.status === 'blocked' && pendingReply) {
        return [
          blocked,
          {
            ...base,
            type: 'task.requeued_with_reply',
            payload: { reply_id: pendingReply.id, ...(session ? { session } : {}) },
          },
        ]
      }
      return [blocked]
    }
    case 'cancelled':
      return [
        {
          ...base,
          type: 'task.cancelled',
          payload: {
            ...(req.message ? { reason: req.message } : {}),
            ...(req.result ? { result: req.result } : {}),
            node_id: lease.node_id,
          },
        },
      ]
  }
}

/**
 * 租约过期对应的事件（纯函数；node-protocol "租约过期处理"）。
 * blocked（lease_held）任务的过期见文件头；`pendingReply` 为该任务待送达的回复。
 */
export function expiryDrafts(
  task: TaskView,
  lease: LeaseRecord,
  pendingReply: ReplyView | null = null,
): EventInput[] {
  const base = { task_id: task.id, workspace: task.workspace }
  const expired: EventInput = {
    ...base,
    type: 'task.lease_expired',
    payload: {
      lease_id: lease.lease_id,
      node_id: lease.node_id,
      expired_at: lease.expires_at,
      attempt: lease.attempt,
    },
  }
  if (task.status === 'blocked') {
    if (task.cancel_requested) {
      return [
        expired,
        {
          ...base,
          type: 'task.cancelled',
          payload: { reason: `已请求取消，节点 ${lease.node_id} 的租约在卡住期间过期` },
        },
      ]
    }
    if (pendingReply) {
      const session = task.blocked?.session
      return [
        expired,
        {
          ...base,
          type: 'task.requeued_with_reply',
          payload: { reply_id: pendingReply.id, ...(session ? { session } : {}) },
        },
      ]
    }
    // 没有待送达的回复：转为 blocked(node_lost)，让用户看到节点已掉线、worker 已不在。
    // 不按 retry 自动重新排队：任务正在等人答复，自动重跑会丢掉这个问题（PR #16 审查第 4 条）。
    // 原来的卡住原因与说明保留在 message 里，之后的文字回复会让任务带着回复重新排队。
    const was = task.blocked
    const session = was?.session
    return [
      expired,
      {
        ...base,
        type: 'task.blocked',
        payload: {
          reason: 'node_lost',
          message: sanitizeMessage(
            `节点 ${lease.node_id} 在等待回复期间掉线（租约 ${lease.expires_at} 过期）` +
              (was ? `；原卡住原因：${was.reason} — ${was.message}` : ''),
          ),
          ...(was?.tail ? { tail: was.tail } : {}),
          ...(session ? { session } : {}),
          ...(was ? { prior_reason: was.prior_reason ?? was.reason } : {}),
          node_id: lease.node_id,
          lease_held: false,
        },
      },
    ]
  }
  const maxAttempts = task.contract.retry?.max_attempts ?? 1
  if (task.attempt < maxAttempts) {
    return [
      expired,
      {
        ...base,
        type: 'task.requeued',
        payload: {
          reason: 'lease_expired',
          note: `节点 ${lease.node_id} 的租约过期，第 ${task.attempt}/${maxAttempts} 次尝试后重新排队`,
        },
      },
    ]
  }
  return [
    expired,
    {
      ...base,
      type: 'task.blocked',
      payload: {
        reason: 'node_lost',
        message: `节点 ${lease.node_id} 的租约在 ${lease.expires_at} 过期，未续约`,
        node_id: lease.node_id,
      },
    },
  ]
}

interface Waiter {
  nodeId: string
  capabilities: string[]
  slots: LeaseSlots | undefined
  resolve(grant: LeaseGrant | null): void
}

export function createNodeService(o: NodeServiceOptions): NodeService {
  const { ledger } = o
  const clock = o.clock ?? systemClock
  const newLeaseId = o.newLeaseId ?? defaultLeaseId
  const newLeaseToken = o.newLeaseToken ?? defaultLeaseToken
  const iso = (ms = clock.now()) => new Date(ms).toISOString()
  const waiters: Waiter[] = []
  let draining = false
  let closed = false

  /** 在同一事务写 `task.started` + `lease.granted`；被其他请求抢先时返回 null。 */
  function grantTask(task: TaskView, nodeId: string): LeaseGrant | null {
    // resume 只交给紧接着的这一次执行：task.started 会在投影里清空它（PR #16 审查第 1 条）。
    const resume = ledger.taskResume(task.id)
    const leaseId = newLeaseId()
    const token = newLeaseToken()
    const attempt = task.attempt + 1
    const ttl = o.leaseTtlS
    const expiresAt = iso(clock.now() + ttl * 1000)
    const base = { task_id: task.id, workspace: task.workspace }
    const written = ledger.appendMany(
      [
        {
          ...base,
          type: 'task.started',
          payload: { node_id: nodeId, lease_id: leaseId, attempt },
        },
        {
          ...base,
          type: 'lease.granted',
          payload: {
            lease_id: leaseId,
            node_id: nodeId,
            token_sha256: sha256(token),
            ttl_s: ttl,
            expires_at: expiresAt,
          },
        },
      ],
      { actor: `node:${nodeId}` },
    )
    // 被其他请求抢先（理论上不会发生，见文件头）。
    if (!written.ok) return null
    ledger.touchNode(nodeId)
    const wakeToken = o.issueWakeToken?.({ lease_id: leaseId, task_id: task.id })
    return {
      lease_id: leaseId,
      lease_token: token,
      task_id: task.id,
      workspace: task.workspace,
      contract: task.contract,
      attempt,
      ttl_s: ttl,
      expires_at: expiresAt,
      ...(resume ? { resume } : {}),
      ...(wakeToken === undefined ? {} : { wake_token: wakeToken }),
    }
  }

  /**
   * 同一节点上正在等待、能用预留槽（supervisor / reply）接这个唤醒的等待者（D12）。
   * 唤醒落到普通空位之前先交给它，避免挤占普通槽。
   */
  function reservedWaiterFor(
    task: TaskView,
    wake: WakeOrigin | null,
    nodeId: string,
    self: Waiter | undefined,
  ): Waiter | undefined {
    if (wake === null) return undefined
    return waiters.find((w) => {
      if (w === self || w.nodeId !== nodeId || !w.slots) return false
      if (!capabilitiesSatisfy(w.capabilities, task.contract)) return false
      const slot = leaseSlotFor(w.slots, wake)
      return slot === 'supervisor' || slot === 'reply'
    })
  }

  /**
   * 选出并分配第一个可领取的 queued 任务；没有时返回 null。全程同步。
   * - `slots` 只有预留空位时，按 `leaseSlotFor` 过滤（需要查唤醒身份）；
   * - 有普通空位（含旧节点不带 `slots`）时任何任务都可以接，只在同一节点另有预留槽等待者时
   *   才查唤醒身份：唤醒先交给那个等待者，本请求继续找下一个任务。
   */
  function tryGrant(
    nodeId: string,
    capabilities: readonly string[],
    slots: LeaseSlots | undefined,
    self?: Waiter,
  ): LeaseGrant | null {
    const general = !slots || slots.general > 0
    for (const task of ledger.queuedTasks()) {
      if (!capabilitiesSatisfy(capabilities, task.contract)) continue
      const hasReservedWaiter = waiters.some((w) => w !== self && w.nodeId === nodeId && w.slots)
      if (general && !hasReservedWaiter) {
        const grant = grantTask(task, nodeId)
        if (grant) return grant
        continue
      }
      const wake = ledger.wakeOrigin(task.id)
      const slot = leaseSlotFor(slots, wake)
      if (slot === null) continue
      if (slot === 'general') {
        const other = reservedWaiterFor(task, wake, nodeId, self)
        if (other) {
          const grant = grantTask(task, nodeId)
          if (grant) other.resolve(grant)
          continue
        }
      }
      const grant = grantTask(task, nodeId)
      if (grant) return grant
    }
    return null
  }

  /** 按先来后到给等待者分配任务。推迟到微任务执行，避免在账本通知回调里重入写入。 */
  function scheduleDrain() {
    if (draining || waiters.length === 0) return
    draining = true
    queueMicrotask(() => {
      draining = false
      if (closed) return
      for (const w of [...waiters]) {
        // 可能已在本轮中作为预留槽等待者被分配（见 tryGrant）。
        if (!waiters.includes(w)) continue
        const grant = tryGrant(w.nodeId, w.capabilities, w.slots, w)
        if (grant) w.resolve(grant)
      }
    })
  }

  const unsubscribe = ledger.subscribe((event) => {
    if (WAKING.has(event.type)) scheduleDrain()
  })

  /** 令牌与租约状态校验。顺序：租约不存在 → 令牌不符 → 租约已结束。 */
  function authorize(
    leaseId: string,
    token: string,
  ): Result<{ lease: LeaseRecord; task: TaskView }> {
    const lease = ledger.getLease(leaseId)
    if (!lease) return fail('failure', 'lease_not_found', `没有租约 ${leaseId}`)
    if (!tokenMatches(token, lease.token_sha256)) {
      return fail('failure', 'invalid_lease_token', '租约令牌不正确')
    }
    const task = ledger.getTask(lease.task_id)
    if (lease.state !== 'active' || !task) {
      return fail(
        'failure',
        'lease_expired',
        `租约 ${leaseId} 已${lease.state === 'expired' ? '过期' : '结束'}，任务状态为 ${task?.status ?? '未知'}`,
        { lease_state: lease.state, task_status: task?.status ?? null },
      )
    }
    return ok({ lease, task })
  }

  const notRegistered = (nodeId: string) =>
    fail('failure', 'node_not_registered', `节点 ${nodeId} 尚未注册`, { node_id: nodeId })

  return {
    registerNode(body, actor) {
      const req = parse(registerNodeRequest, body, '节点注册请求')
      if (!req.ok) return req
      const written = ledger.append(
        { type: 'node.registered', payload: req.data },
        // 未声明身份（unknown）或用 user token 未降级（user）时，记为该节点。
        { actor: actor === 'unknown' || actor === 'user' ? `node:${req.data.node_id}` : actor },
      )
      if (!written.ok) return written
      ledger.touchNode(req.data.node_id)
      const node = ledger.getNode(req.data.node_id)
      return node ? ok({ node }) : fail('failure', 'internal_error', '节点写入后不可见')
    },

    listNodes() {
      return ok({ nodes: ledger.listNodes() })
    },

    async acquire(body, opts = {}) {
      const req = parse(acquireLeaseRequest, body, '领取请求')
      if (!req.ok) return req
      const { node_id: nodeId, capabilities, slots } = req.data
      if (!ledger.touchNode(nodeId)) return notRegistered(nodeId)
      const grant = tryGrant(nodeId, capabilities, slots)
      const waitMs = Math.min(req.data.wait_s, o.leaseWaitMaxS) * 1000
      if (grant || waitMs === 0 || closed || opts.signal?.aborted) return ok({ lease: grant })

      const lease = await new Promise<LeaseGrant | null>((resolve) => {
        let cancelTimer = () => {}
        const waiter: Waiter = {
          nodeId,
          capabilities,
          slots,
          resolve: (g) => {
            const i = waiters.indexOf(waiter)
            if (i >= 0) waiters.splice(i, 1)
            cancelTimer()
            opts.signal?.removeEventListener('abort', onAbort)
            resolve(g)
          },
        }
        const onAbort = () => waiter.resolve(null)
        waiters.push(waiter)
        cancelTimer = clock.setTimeout(() => waiter.resolve(null), waitMs)
        opts.signal?.addEventListener('abort', onAbort, { once: true })
      })
      ledger.touchNode(nodeId)
      return ok({ lease })
    },

    renew(leaseId, body) {
      const req = parse(renewLeaseRequest, body, '续约请求')
      if (!req.ok) return req
      const auth = authorize(leaseId, req.data.lease_token)
      if (!auth.ok) return auth
      const { lease, task } = auth.data
      if (!RENEWABLE.has(task.status)) {
        return fail('failure', 'lease_expired', `任务状态为 ${task.status}，租约不能续约`)
      }
      const steps = renewSteps(task, lease, req.data)
      if (!steps.ok) return steps
      const expiresAt = iso(clock.now() + lease.ttl_s * 1000)
      ledger.renewLease(lease.lease_id, expiresAt)
      ledger.touchNode(lease.node_id)
      const after = ledger.getTask(task.id) ?? task
      // 已请求取消的任务不再送达回复。
      const pending =
        after.status === 'blocked' && !after.cancel_requested ? ledger.pendingReply(task.id) : null
      return ok({
        lease_id: lease.lease_id,
        expires_at: expiresAt,
        cancel_requested: after.cancel_requested,
        reply: pending
          ? {
              reply_id: pending.id,
              kind: pending.kind,
              ...(pending.text === null ? {} : { text: pending.text }),
              by: pending.by,
            }
          : null,
      })
    },

    ackReply(leaseId, body) {
      const req = parse(ackReplyRequest, body, '回复确认请求')
      if (!req.ok) return req
      const auth = authorize(leaseId, req.data.lease_token)
      if (!auth.ok) return auth
      const { lease, task } = auth.data
      const reply = ledger.getReply(req.data.reply_id)
      if (!reply || reply.task_id !== task.id) {
        return fail('failure', 'reply_not_found', `任务 ${task.id} 没有回复 ${req.data.reply_id}`)
      }
      // 重复确认（例如上一次的响应丢失）：已送达就直接返回，保证只送达一次。
      if (reply.state === 'delivered' && req.data.outcome === 'delivered') return ok({ task })
      if (reply.state !== 'pending' || task.status !== 'blocked') {
        return fail(
          'failure',
          'invalid_transition',
          `回复 ${reply.id} 状态为 ${reply.state}、任务状态为 ${task.status}，不能确认送达`,
          { from: task.status, type: 'task.unblocked' },
        )
      }
      const base = { task_id: task.id, workspace: task.workspace }
      const session = task.blocked?.session
      const draft: EventInput =
        req.data.outcome === 'not_running' && task.cancel_requested
          ? {
              // 已请求取消：worker 不在了就直接取消，不带着回复重新排队（复核第 2 条）。
              ...base,
              type: 'task.cancelled',
              payload: { reason: '已请求取消；送达回复时 worker 已不在', node_id: lease.node_id },
            }
          : req.data.outcome === 'delivered'
            ? {
                ...base,
                type: 'task.unblocked',
                payload: { reply_id: reply.id, note: replyNote(reply) },
              }
            : {
                ...base,
                type: 'task.requeued_with_reply',
                payload: { reply_id: reply.id, ...(session ? { session } : {}) },
              }
      const written = ledger.append(draft, { actor: `node:${lease.node_id}` })
      if (!written.ok) return written
      ledger.touchNode(lease.node_id)
      const after = ledger.getTask(task.id)
      return after ? ok({ task: after }) : fail('failure', 'internal_error', '任务不可见')
    },

    complete(leaseId, body) {
      const req = parse(completeLeaseRequest, body, '提交请求')
      if (!req.ok) return req
      const auth = authorize(leaseId, req.data.lease_token)
      if (!auth.ok) return auth
      const { lease, task } = auth.data
      if (req.data.outcome === 'cancelled' && !task.cancel_requested) {
        return fail(
          'failure',
          'invalid_transition',
          '任务没有被请求取消，不能提交 cancelled；执行器自行中止请提交 failed 或 blocked',
          { from: task.status, type: 'task.cancelled' },
        )
      }
      const pending = task.status === 'blocked' ? ledger.pendingReply(task.id) : null
      const written = ledger.appendMany(completionDrafts(task, lease, req.data, pending), {
        actor: `node:${lease.node_id}`,
      })
      if (!written.ok) return written
      ledger.touchNode(lease.node_id)
      const after = ledger.getTask(task.id)
      return after ? ok({ task: after }) : fail('failure', 'internal_error', '任务不可见')
    },

    expireDue() {
      const now = clock.now()
      let handled = 0
      for (const lease of ledger.activeLeases()) {
        // activeLeases 按 expires_at 升序。
        if (Date.parse(lease.expires_at) > now) break
        const task = ledger.getTask(lease.task_id)
        if (!task) continue
        const pending = task.status === 'blocked' ? ledger.pendingReply(task.id) : null
        const written = ledger.appendMany(expiryDrafts(task, lease, pending), { actor: 'hub' })
        if (written.ok) handled++
      }
      return handled
    },

    waiting: () => waiters.length,

    close() {
      if (closed) return
      closed = true
      unsubscribe()
      for (const w of [...waiters]) w.resolve(null)
    },
  }

  /** 续约附带的动作：记录活动、阶段切换、卡住与自行恢复（D7a）。各步独立。 */
  function renewSteps(task: TaskView, lease: LeaseRecord, req: RenewLeaseRequest): Result<null> {
    if (req.activity.length > 0) ledger.recordActivity(task.id, req.activity)
    const base = { task_id: task.id, workspace: task.workspace }
    const actor = { actor: `node:${lease.node_id}` }
    // 重复上报（上一次的响应丢失后重试）时任务已经处于目标状态，忽略即可。
    if (req.resumed && task.status === 'blocked') {
      // 自行恢复时尚未送达的回复会被丢弃：记下它们的 id，供收件箱通知回复者（PR #16 审查第 5 条）。
      const dropped = ledger
        .taskReplies(task.id)
        .filter((r) => r.state === 'pending')
        .map((r) => r.id)
      const written = ledger.append(
        {
          ...base,
          type: 'task.unblocked',
          payload: {
            note: req.resumed.note ?? 'worker 自行恢复',
            ...(dropped.length > 0 ? { dropped_reply_ids: dropped } : {}),
          },
        },
        actor,
      )
      if (!written.ok) return written
    }
    if (req.blocked && (task.status === 'running' || task.status === 'verifying')) {
      const written = ledger.append(
        {
          ...base,
          type: 'task.blocked',
          payload: {
            reason: req.blocked.reason,
            message: sanitizeMessage(req.blocked.message),
            ...(req.blocked.tail ? { tail: sanitizeTail(req.blocked.tail) } : {}),
            ...(req.blocked.session ? { session: req.blocked.session } : {}),
            ...delegationFields(req.blocked),
            node_id: lease.node_id,
            lease_held: true,
          },
        },
        actor,
      )
      if (!written.ok) return written
      return ok(null)
    }
    if (
      req.phase === 'verifying' &&
      (ledger.getTask(task.id)?.status ?? task.status) === 'running'
    ) {
      const written = ledger.append(
        {
          task_id: task.id,
          workspace: task.workspace,
          type: 'task.verifying',
          payload: { node_id: lease.node_id },
        },
        { actor: `node:${lease.node_id}` },
      )
      if (!written.ok) return written
    }
    return ok(null)
  }
}
