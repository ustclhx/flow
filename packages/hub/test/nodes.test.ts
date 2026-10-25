import { afterEach, describe, expect, test } from 'bun:test'
import type { TaskContractInput } from '@flow/core'
import {
  createNodeProtocol,
  createTaskService,
  EXPIRY_SWEEP_MS,
  type LedgerStore,
  type NodeProtocol,
} from '../src/index.ts'
import { anyRole, contractInput, result, tempLedger, WS } from './ledger-helpers.ts'
import { FakeClock, tick } from './server-fixtures.ts'

/** 墙钟与单调时钟分开：`sleep(ms)` 只拨动墙钟，模拟合盖睡眠。 */
class SleepyClock extends FakeClock {
  slept = 0
  monotonic = () => this.time - this.slept
  sleep(ms: number) {
    this.time += ms
    this.slept += ms
  }
}

const T0 = Date.parse('2026-10-24T08:00:00.000Z')
const TTL = 60

interface Ctx {
  ledger: LedgerStore
  clock: SleepyClock
  protocol: NodeProtocol
  create(over?: Partial<TaskContractInput>): Promise<string>
  register(nodeId: string, caps?: string[]): void
}

let cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups) c()
  cleanups = []
})

async function setup(): Promise<Ctx> {
  const clock = new SleepyClock(T0)
  const t = await tempLedger({ now: clock.now })
  const protocol = createNodeProtocol({
    ledger: t.store,
    clock,
    leaseTtlS: TTL,
    leaseWaitMaxS: 30,
  })
  cleanups.push(() => {
    protocol.stop()
    t.cleanup()
  })
  const tasks = createTaskService({
    ledger: t.store,
    workspaceExists: () => true,
    roles: anyRole,
    now: clock.now,
  })
  return {
    ledger: t.store,
    clock,
    protocol,
    async create(over = {}) {
      const r = await tasks.createTask(contractInput(over), { actor: 'user' })
      if (!r.ok) throw new Error(r.error.message)
      return r.data.task.id
    },
    register(nodeId, caps = ['executor:fake']) {
      const r = protocol.service.registerNode(
        { node_id: nodeId, hostname: 'host', version: '0.0.0', capabilities: caps },
        'unknown',
      )
      if (!r.ok) throw new Error(r.error.message)
    },
  }
}

const acquire = (ctx: Ctx, nodeId: string, caps = ['executor:fake'], wait_s = 0) =>
  ctx.protocol.service.acquire({ node_id: nodeId, capabilities: caps, wait_s })

async function grant(ctx: Ctx, nodeId = 'n1') {
  const r = await acquire(ctx, nodeId)
  if (!r.ok || !r.data.lease) throw new Error('没有领到租约')
  return r.data.lease
}

const types = (ctx: Ctx, id: string) => ctx.ledger.taskEvents(id).map((e) => e.type)

describe('注册与领取', () => {
  test('注册写 node.registered，列表含能力与最近活动', async () => {
    const ctx = await setup()
    ctx.register('n1', ['browser', 'executor:fake'])
    const nodes = ctx.protocol.service.listNodes()
    expect(nodes.ok && nodes.data.nodes).toMatchObject([
      {
        node_id: 'n1',
        capabilities: ['browser', 'executor:fake'],
        last_seen_at: expect.any(String),
      },
    ])
    expect(ctx.ledger.eventsAfter(0).map((e) => [e.type, e.actor])).toEqual([
      ['node.registered', 'node:n1'],
    ])
  })

  test('未注册的节点领取返回 node_not_registered', async () => {
    const ctx = await setup()
    const r = await acquire(ctx, 'ghost')
    expect(!r.ok && r.error.code).toBe('node_not_registered')
  })

  test('领取：同事务写 task.started + lease.granted，令牌只存摘要', async () => {
    const ctx = await setup()
    ctx.register('n1')
    const id = await ctx.create()
    const lease = await grant(ctx)
    expect(lease).toMatchObject({ task_id: id, attempt: 1, ttl_s: TTL, workspace: WS })
    expect(lease.lease_token.length).toBeGreaterThanOrEqual(16)
    const events = ctx.ledger.taskEvents(id)
    expect(events.map((e) => e.type)).toEqual(['task.created', 'task.started', 'lease.granted'])
    expect(events[1]?.seq).toBe((events[2]?.seq ?? 0) - 1)
    expect(JSON.stringify(events)).not.toContain(lease.lease_token)
    expect(ctx.ledger.getTask(id)?.status).toBe('running')
  })

  test('按创建先后分配', async () => {
    const ctx = await setup()
    ctx.register('n1')
    const first = await ctx.create({ goal: '一' })
    await ctx.create({ goal: '二' })
    expect((await grant(ctx)).task_id).toBe(first)
  })

  test('能力不匹配：等待结束后返回空结果，任务保持 queued', async () => {
    const ctx = await setup()
    ctx.register('n1')
    const id = await ctx.create({ executor: 'codex-orca' })
    const pending = acquire(ctx, 'n1', ['executor:fake'], 10)
    await tick()
    expect(ctx.protocol.service.waiting()).toBe(1)
    await ctx.clock.advance(10_000)
    const r = await pending
    expect(r.ok && r.data.lease).toBeNull()
    expect(ctx.ledger.getTask(id)?.status).toBe('queued')
    expect(ctx.protocol.service.waiting()).toBe(0)
  })

  test('等待时间按 lease_wait_max_s 截断', async () => {
    const ctx = await setup()
    ctx.register('n1')
    let done = false
    const pending = acquire(ctx, 'n1', ['executor:fake'], 300).then((r) => {
      done = true
      return r
    })
    await ctx.clock.advance(29_000)
    expect(done).toBe(false)
    await ctx.clock.advance(1_000)
    expect((await pending).ok).toBe(true)
    expect(done).toBe(true)
  })

  test('long-poll：新任务入队时唤醒等待者', async () => {
    const ctx = await setup()
    ctx.register('n1')
    const pending = acquire(ctx, 'n1', ['executor:fake'], 30)
    await tick()
    const id = await ctx.create()
    const r = await pending
    expect(r.ok && r.data.lease?.task_id).toBe(id)
  })

  test('同一任务不会被分配两次：同时领取', async () => {
    const ctx = await setup()
    ctx.register('n1')
    ctx.register('n2')
    const id = await ctx.create()
    const [a, b] = await Promise.all([acquire(ctx, 'n1'), acquire(ctx, 'n2')])
    const leases = [a, b].map((r) => (r.ok ? r.data.lease : undefined))
    expect(leases.filter((l) => l !== null)).toHaveLength(1)
    expect(types(ctx, id).filter((t) => t === 'lease.granted')).toHaveLength(1)
  })

  test('同一任务不会被分配两次：多个等待者被同一事件唤醒', async () => {
    const ctx = await setup()
    for (const n of ['n1', 'n2', 'n3']) ctx.register(n)
    const pending = ['n1', 'n2', 'n3'].map((n) => acquire(ctx, n, ['executor:fake'], 5))
    await tick()
    expect(ctx.protocol.service.waiting()).toBe(3)
    const id = await ctx.create()
    await tick()
    expect(ctx.protocol.service.waiting()).toBe(2)
    await ctx.clock.advance(5_000)
    const results = await Promise.all(pending)
    const got = results.map((r) => (r.ok ? r.data.lease?.task_id : 'error'))
    expect(got.filter((x) => x === id)).toHaveLength(1)
    expect(got.filter((x) => x === undefined)).toHaveLength(2)
    expect(types(ctx, id).filter((t) => t === 'task.started')).toHaveLength(1)
  })

  test('中止请求时移出等待队列', async () => {
    const ctx = await setup()
    ctx.register('n1')
    const ac = new AbortController()
    const pending = ctx.protocol.service.acquire(
      { node_id: 'n1', capabilities: ['executor:fake'], wait_s: 30 },
      { signal: ac.signal },
    )
    await tick()
    ac.abort()
    const r = await pending
    expect(r.ok && r.data.lease).toBeNull()
    expect(ctx.protocol.service.waiting()).toBe(0)
    // 之后入队的任务不会分给已断开的请求。
    const id = await ctx.create()
    await tick()
    expect(ctx.ledger.getTask(id)?.status).toBe('queued')
  })
})

describe('续约与提交', () => {
  test('续约：顺延到期时间、记录活动、刷新节点、返回取消标记', async () => {
    const ctx = await setup()
    ctx.register('n1')
    const id = await ctx.create()
    const lease = await grant(ctx)
    await ctx.clock.advance(20_000)
    const at = new Date(ctx.clock.now()).toISOString()
    const r = ctx.protocol.service.renew(lease.lease_id, {
      lease_token: lease.lease_token,
      activity: [{ ts: at, kind: 'output', text: 'hello' }],
    })
    expect(r.ok && r.data).toEqual({
      lease_id: lease.lease_id,
      expires_at: new Date(ctx.clock.now() + TTL * 1000).toISOString(),
      cancel_requested: false,
      reply: null,
    })
    expect(ctx.ledger.taskActivity(id).map((a) => a.text)).toEqual(['hello'])
    expect(ctx.ledger.getNode('n1')?.last_seen_at).toBe(at)
    // 续约不入账本。
    expect(types(ctx, id)).toEqual(['task.created', 'task.started', 'lease.granted'])
  })

  test('续约时得知取消，随后提交 cancelled', async () => {
    const ctx = await setup()
    ctx.register('n1')
    const id = await ctx.create()
    const lease = await grant(ctx)
    const tasks = createTaskService({
      ledger: ctx.ledger,
      workspaceExists: () => true,
      roles: anyRole,
    })
    expect(tasks.cancelTask(id, { actor: 'user' }).ok).toBe(true)
    const r = ctx.protocol.service.renew(lease.lease_id, { lease_token: lease.lease_token })
    expect(r.ok && r.data.cancel_requested).toBe(true)
    const c = ctx.protocol.service.complete(lease.lease_id, {
      lease_token: lease.lease_token,
      outcome: 'cancelled',
    })
    expect(c.ok && c.data.task.status).toBe('cancelled')
    expect(ctx.ledger.taskEvents(id).at(-1)).toMatchObject({
      type: 'task.cancelled',
      actor: 'node:n1',
      payload: { node_id: 'n1' },
    })
  })

  test('未被请求取消时不能提交 cancelled', async () => {
    const ctx = await setup()
    ctx.register('n1')
    await ctx.create()
    const lease = await grant(ctx)
    const c = ctx.protocol.service.complete(lease.lease_id, {
      lease_token: lease.lease_token,
      outcome: 'cancelled',
    })
    expect(!c.ok && c.error.code).toBe('invalid_transition')
  })

  test('phase=verifying 写 task.verifying，之后可以 done', async () => {
    const ctx = await setup()
    ctx.register('n1')
    const id = await ctx.create()
    const lease = await grant(ctx)
    const r = ctx.protocol.service.renew(lease.lease_id, {
      lease_token: lease.lease_token,
      phase: 'verifying',
    })
    expect(r.ok).toBe(true)
    expect(ctx.ledger.getTask(id)?.status).toBe('verifying')
    // 重复上报不重复写事件。
    ctx.protocol.service.renew(lease.lease_id, {
      lease_token: lease.lease_token,
      phase: 'verifying',
    })
    expect(types(ctx, id).filter((t) => t === 'task.verifying')).toHaveLength(1)
    const c = ctx.protocol.service.complete(lease.lease_id, {
      lease_token: lease.lease_token,
      outcome: 'done',
      result: result('n1'),
    })
    expect(c.ok && c.data.task.status).toBe('done')
  })

  test('blocked 提交附带原因与说明', async () => {
    const ctx = await setup()
    ctx.register('n1')
    const id = await ctx.create()
    const lease = await grant(ctx)
    const c = ctx.protocol.service.complete(lease.lease_id, {
      lease_token: lease.lease_token,
      outcome: 'blocked',
      blocked_reason: 'question',
      message: '要用哪个分支？',
      tail: ['line'],
    })
    expect(c.ok && c.data.task.blocked).toEqual({
      reason: 'question',
      message: '要用哪个分支？',
      tail: ['line'],
      lease_held: false,
    })
    expect(ctx.ledger.activeLease(id)).toBeNull()
  })

  test('令牌错误被拒绝；不存在的租约返回 lease_not_found', async () => {
    const ctx = await setup()
    ctx.register('n1')
    await ctx.create()
    const lease = await grant(ctx)
    const wrong = 'w'.repeat(43)
    const r = ctx.protocol.service.renew(lease.lease_id, { lease_token: wrong })
    expect(!r.ok && r.error.code).toBe('invalid_lease_token')
    const c = ctx.protocol.service.complete(lease.lease_id, {
      lease_token: wrong,
      outcome: 'done',
      result: result('n1'),
    })
    expect(!c.ok && c.error.code).toBe('invalid_lease_token')
    const missing = ctx.protocol.service.renew('l-missing', { lease_token: wrong })
    expect(!missing.ok && missing.error.code).toBe('lease_not_found')
  })

  test('已提交的租约再次提交返回 lease_expired', async () => {
    const ctx = await setup()
    ctx.register('n1')
    await ctx.create()
    const lease = await grant(ctx)
    const body = { lease_token: lease.lease_token, outcome: 'done', result: result('n1') }
    expect(ctx.protocol.service.complete(lease.lease_id, body).ok).toBe(true)
    const again = ctx.protocol.service.complete(lease.lease_id, body)
    expect(!again.ok && again.error.code).toBe('lease_expired')
  })
})

describe('租约过期', () => {
  test('节点掉线：默认合同 → task.lease_expired + blocked(node_lost)', async () => {
    const ctx = await setup()
    ctx.register('n1')
    const id = await ctx.create()
    const lease = await grant(ctx)
    ctx.protocol.start()
    await ctx.clock.advance(TTL * 1000 - EXPIRY_SWEEP_MS)
    expect(ctx.ledger.getTask(id)?.status).toBe('running')
    await ctx.clock.advance(EXPIRY_SWEEP_MS * 2)
    const task = ctx.ledger.getTask(id)
    expect(task?.status).toBe('blocked')
    expect(task?.blocked?.reason).toBe('node_lost')
    const events = ctx.ledger.taskEvents(id)
    expect(events.slice(-2).map((e) => e.type)).toEqual(['task.lease_expired', 'task.blocked'])
    expect(events.at(-2)?.payload).toMatchObject({ lease_id: lease.lease_id, node_id: 'n1' })
  })

  test('过期租约的迟到提交被拒绝（lease_expired），任务状态不变', async () => {
    const ctx = await setup()
    ctx.register('n1')
    const id = await ctx.create()
    const lease = await grant(ctx)
    await ctx.clock.advance(TTL * 1000 + 1)
    expect(ctx.protocol.sweep()).toBe(1)
    const before = ctx.ledger.getTask(id)
    const c = ctx.protocol.service.complete(lease.lease_id, {
      lease_token: lease.lease_token,
      outcome: 'done',
      result: result('n1'),
    })
    expect(!c.ok && c.error.code).toBe('lease_expired')
    const r = ctx.protocol.service.renew(lease.lease_id, { lease_token: lease.lease_token })
    expect(!r.ok && r.error.code).toBe('lease_expired')
    expect(ctx.ledger.getTask(id)).toEqual(before)
  })

  test('到期但尚未扫描的租约仍可续约', async () => {
    const ctx = await setup()
    ctx.register('n1')
    const id = await ctx.create()
    const lease = await grant(ctx)
    await ctx.clock.advance(TTL * 1000 + 1)
    expect(ctx.protocol.service.renew(lease.lease_id, { lease_token: lease.lease_token }).ok).toBe(
      true,
    )
    expect(ctx.protocol.sweep()).toBe(0)
    expect(ctx.ledger.getTask(id)?.status).toBe('running')
  })

  test('允许重试：过期后 requeued 并被再次领取，用完次数后 node_lost', async () => {
    const ctx = await setup()
    ctx.register('n1')
    ctx.register('n2')
    const id = await ctx.create({ retry: { max_attempts: 2 } })
    await grant(ctx, 'n1')
    await ctx.clock.advance(TTL * 1000 + 1)
    const waiting = acquire(ctx, 'n2', ['executor:fake'], 30)
    await tick()
    expect(ctx.protocol.service.waiting()).toBe(1)
    expect(ctx.protocol.sweep()).toBe(1)
    const second = await waiting
    expect(second.ok && second.data.lease).toMatchObject({ task_id: id, attempt: 2 })
    expect(types(ctx, id)).toEqual([
      'task.created',
      'task.started',
      'lease.granted',
      'task.lease_expired',
      'task.requeued',
      'task.started',
      'lease.granted',
    ])
    await ctx.clock.advance(TTL * 1000 + 1)
    ctx.protocol.sweep()
    expect(ctx.ledger.getTask(id)?.blocked?.reason).toBe('node_lost')
  })
})

describe('睡眠检测', () => {
  test('合盖一小时后打开：任务保持 running，记录 hub.resumed', async () => {
    const ctx = await setup()
    ctx.register('n1')
    const id = await ctx.create()
    const lease = await grant(ctx)
    ctx.protocol.start()
    await ctx.clock.advance(10_000)
    ctx.clock.sleep(3_600_000)
    // 唤醒后先到期的是扫描还是检测都不影响结果：扫描会先做一次睡眠检测。
    await ctx.clock.advance(EXPIRY_SWEEP_MS)
    expect(ctx.ledger.getTask(id)?.status).toBe('running')
    const resumed = ctx.ledger.eventsAfter(0).filter((e) => e.type === 'hub.resumed')
    expect(resumed).toHaveLength(1)
    expect(resumed[0]?.payload).toEqual({ slept_ms: 3_600_000, extended_leases: 1 })
    // 唤醒后节点有一个完整的 TTL 来续约。
    await ctx.clock.advance(TTL * 1000 - EXPIRY_SWEEP_MS * 2)
    expect(ctx.ledger.getTask(id)?.status).toBe('running')
    expect(ctx.protocol.service.renew(lease.lease_id, { lease_token: lease.lease_token }).ok).toBe(
      true,
    )
    // 不续约则照常过期。
    await ctx.clock.advance(TTL * 1000 + EXPIRY_SWEEP_MS)
    expect(ctx.ledger.getTask(id)?.blocked?.reason).toBe('node_lost')
  })

  test('短暂卡顿（小于阈值）不判定为睡眠', async () => {
    const ctx = await setup()
    ctx.protocol.start()
    ctx.clock.sleep(20_000)
    await ctx.clock.advance(1_000)
    expect(ctx.protocol.sleep?.check()).toBe(0)
    expect(ctx.ledger.eventsAfter(0).filter((e) => e.type === 'hub.resumed')).toHaveLength(0)
  })
})
