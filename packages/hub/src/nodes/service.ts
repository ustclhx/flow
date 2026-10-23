import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  type AcquireLeaseData,
  acquireLeaseRequest,
  type CompleteLeaseData,
  type CompleteLeaseRequest,
  capabilitiesSatisfy,
  completeLeaseRequest,
  fail,
  type LeaseGrant,
  type LedgerEvent,
  type NodeView,
  ok,
  type RenewLeaseData,
  type RenewLeaseRequest,
  type Result,
  registerNodeRequest,
  renewLeaseRequest,
  type TaskView,
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
 * - 无可领取任务时挂入内存等待队列（不进投影），`task.created` / `task.requeued` 到来时唤醒。
 * - 续约 / 提交校验租约令牌（账本只存 SHA-256）；租约已不是 active（过期或已被处理）时返回
 *   `lease_expired`。
 * - 过期扫描：按合同 retry 决定 `task.requeued(lease_expired)` 或 `task.blocked(node_lost)`，
 *   同一事务先写 `task.lease_expired`。
 *
 * 为变更 ② 的 D7a（交互式执行器 blocked 期间持有租约）预留：
 * - 令牌校验（`authorize`）与"任务处于什么状态才能续约"（`RENEWABLE`）分开；
 * - 续约的各个步骤（活动、阶段、到期时间）各自独立，以后可在其中加入"续约中上报 blocked / 送达回复"；
 * - 提交结束（`completionDrafts`）与过期处理（`expiryDrafts`）都是纯函数，以后按 `lease_held` 分支即可。
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
  /** 处理全部已到期的活动租约，返回处理的数量。 */
  expireDue(): number
  /** 当前挂起的 long-poll 数（测试与诊断）。 */
  waiting(): number
  /** 结束全部等待（返回空结果）并取消订阅。 */
  close(): void
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

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

/** 持有活动租约时允许续约的任务状态。D7a 加入 lease_held 后在这里加上 blocked。 */
const RENEWABLE: ReadonlySet<TaskView['status']> = new Set(['running', 'verifying'])

/** 唤醒等待者的事件：有任务可能变为 queued。 */
const WAKING: ReadonlySet<LedgerEvent['type']> = new Set([
  'task.created',
  'task.requeued',
  'hub.rebuilt',
])

/** 提交结束对应的事件（纯函数）。 */
export function completionDrafts(
  task: TaskView,
  lease: LeaseRecord,
  req: CompleteLeaseRequest,
): EventInput[] {
  const base = { task_id: task.id, workspace: task.workspace }
  switch (req.outcome) {
    case 'done':
      return [{ ...base, type: 'task.done', payload: { result: req.result } }]
    case 'failed':
      return [{ ...base, type: 'task.failed', payload: { result: req.result } }]
    case 'blocked':
      return [
        {
          ...base,
          type: 'task.blocked',
          payload: {
            reason: req.blocked_reason,
            message: req.message,
            ...(req.tail ? { tail: req.tail } : {}),
            node_id: lease.node_id,
          },
        },
      ]
    case 'cancelled':
      return [
        {
          ...base,
          type: 'task.cancelled',
          payload: {
            ...(req.message ? { reason: req.message } : {}),
            node_id: lease.node_id,
          },
        },
      ]
  }
}

/** 租约过期对应的事件（纯函数；node-protocol "租约过期处理"）。 */
export function expiryDrafts(task: TaskView, lease: LeaseRecord): EventInput[] {
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

  /** 选出并分配第一个满足能力的 queued 任务；没有时返回 null。全程同步。 */
  function tryGrant(nodeId: string, capabilities: readonly string[]): LeaseGrant | null {
    for (const task of ledger.queuedTasks()) {
      if (!capabilitiesSatisfy(capabilities, task.contract)) continue
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
      // 被其他请求抢先（理论上不会发生，见文件头）：换下一个任务。
      if (!written.ok) continue
      ledger.touchNode(nodeId)
      return {
        lease_id: leaseId,
        lease_token: token,
        task_id: task.id,
        workspace: task.workspace,
        contract: task.contract,
        attempt,
        ttl_s: ttl,
        expires_at: expiresAt,
      }
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
        const grant = tryGrant(w.nodeId, w.capabilities)
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
        { actor: actor === 'unknown' ? `node:${req.data.node_id}` : actor },
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
      const { node_id: nodeId, capabilities } = req.data
      if (!ledger.touchNode(nodeId)) return notRegistered(nodeId)
      const grant = tryGrant(nodeId, capabilities)
      const waitMs = Math.min(req.data.wait_s, o.leaseWaitMaxS) * 1000
      if (grant || waitMs === 0 || closed || opts.signal?.aborted) return ok({ lease: grant })

      const lease = await new Promise<LeaseGrant | null>((resolve) => {
        let cancelTimer = () => {}
        const waiter: Waiter = {
          nodeId,
          capabilities,
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
      return ok({
        lease_id: lease.lease_id,
        expires_at: expiresAt,
        cancel_requested: after.cancel_requested,
      })
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
      const written = ledger.appendMany(completionDrafts(task, lease, req.data), {
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
        const written = ledger.appendMany(expiryDrafts(task, lease), { actor: 'hub' })
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

  /** 续约附带的动作：记录活动、阶段切换。各步独立，D7a 可在此追加。 */
  function renewSteps(task: TaskView, lease: LeaseRecord, req: RenewLeaseRequest): Result<null> {
    if (req.activity.length > 0) ledger.recordActivity(task.id, req.activity)
    if (req.phase === 'verifying' && task.status === 'running') {
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
