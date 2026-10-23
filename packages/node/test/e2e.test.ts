import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  flowPaths,
  initFlowHome,
  type LedgerEvent,
  type NodeView,
  type TaskContractInput,
  type TaskView,
} from '@flow/core'
import { type RunningHub, runHub } from '@flow/hub'
import { type RunningNode, startNode } from '../src/index.ts'

/**
 * 端到端（tasks.md 4.3）：同一进程里启动真实的 runHub（临时 home、随机端口）与 startNode，
 * 经 HTTP 创建 fake 任务。
 *
 * 为了在数秒内跑完，中枢与节点共用一个"加速 10 倍"的时钟：定时器按 1/10 的真实时间触发，
 * 墙钟与单调时钟按 10 倍前进。lease_ttl_s=5（配置下限）对应真实 0.5 秒，续约每 ~0.17 秒一次。
 * `sleep(ms)` 只拨动墙钟，模拟合盖睡眠。
 */
class FastClock {
  readonly speed = 10
  private readonly startMono = performance.now()
  private readonly startWall = Date.now()
  private offset = 0
  monotonic = () => (performance.now() - this.startMono) * this.speed
  now = () => this.startWall + this.monotonic() + this.offset
  setTimeout(callback: () => void | Promise<void>, delayMs: number) {
    const t = setTimeout(() => void callback(), delayMs / this.speed)
    return () => clearTimeout(t)
  }
  sleep(ms: number) {
    this.offset += ms
  }
}

const quiet = { info() {}, warn() {}, error() {} }
const clock = new FastClock()
let home: string
let hub: RunningHub
let node: RunningNode
let auth: Record<string, string>
const extraNodes: RunningNode[] = []

beforeAll(async () => {
  home = join(mkdtempSync(join(tmpdir(), 'flow-node-e2e-')), 'home')
  const init = await initFlowHome(home)
  if (!init.ok) throw new Error(init.error.message)
  mkdirSync(join(home, 'config', 'workspaces'), { recursive: true })
  writeFileSync(
    join(home, 'config', 'workspaces', 'demo.yaml'),
    'id: demo\nkind: product\nname: Demo\ndescription: 测试\nrepos: []\n',
  )
  writeFileSync(flowPaths(home).hubConfig, 'lease_ttl_s: 5\nlease_wait_max_s: 30\n')
  const h = await runHub({ home, port: 0, clock, logger: quiet as never })
  if (!h.ok) throw new Error(h.error.message)
  hub = h.data
  writeFileSync(flowPaths(home).nodeConfig, `hub_url: ${hub.url}\ncapabilities: [browser]\n`)
  const token = readFileSync(flowPaths(home).hubToken, 'utf8').trim()
  auth = { Authorization: `Bearer ${token}`, 'X-Flow-Actor': 'user' }
  const n = await startNode({ home, clock, logger: quiet, hostname: 'e2e-host' })
  if (!n.ok) throw new Error(n.error.message)
  node = n.data
})

afterAll(async () => {
  await Promise.all([node?.stop(), ...extraNodes.map((n) => n.stop())])
  await hub?.stop()
})

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${hub.url}${path}`, {
    method,
    headers: { ...auth, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const json = (await res.json()) as { ok: boolean; data: T; error?: unknown }
  if (!json.ok) throw new Error(`${method} ${path}: ${JSON.stringify(json.error)}`)
  return json.data
}

const create = async (over: Partial<TaskContractInput>) =>
  (
    await api<{ task: TaskView }>('POST', '/v1/tasks', {
      goal: '端到端',
      workspace: 'ws/demo',
      role: 'dev',
      executor: 'fake',
      ...over,
    })
  ).task.id

const show = (id: string) =>
  api<{ task: TaskView; events: LedgerEvent[] }>('GET', `/v1/tasks/${id}`)

/** 真实时间轮询，最多 5 秒。 */
async function until(id: string, pred: (t: TaskView) => boolean, what: string) {
  const deadline = Date.now() + 5_000
  for (;;) {
    const { task, events } = await show(id)
    if (pred(task)) return { task, events }
    if (Date.now() > deadline) {
      throw new Error(`等待 ${what} 超时：${task.status} ${events.map((e) => e.type).join(',')}`)
    }
    await new Promise((r) => setTimeout(r, 20))
  }
}

const fake = (f: Record<string, unknown>) => ({ inputs: { fake: f } })

/** 从 SSE 事件流中找出 seq > after 的第一条指定类型事件（最多等 3 秒）。 */
async function findEvent(after: number, type: string): Promise<LedgerEvent> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 3_000)
  try {
    const res = await fetch(`${hub.url}/v1/events?after=${after}`, {
      headers: auth,
      signal: ac.signal,
    })
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let text = ''
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error('SSE 提前关闭')
      text += decoder.decode(chunk.value, { stream: true })
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ')) continue
        const event = JSON.parse(line.slice(6)) as LedgerEvent
        if (event.type === type) return event
      }
    }
  } finally {
    clearTimeout(timer)
    ac.abort()
  }
}

describe('节点端到端（fake 执行器）', () => {
  test('flow node list：节点已注册，带能力与最近活动', async () => {
    const { nodes } = await api<{ nodes: NodeView[] }>('GET', '/v1/nodes')
    const me = nodes.find((n) => n.node_id === node.nodeId)
    expect(me).toMatchObject({
      hostname: 'e2e-host',
      capabilities: ['browser', 'executor:fake'],
      executors: [{ type: 'fake', mode: 'headless' }],
      concurrency: 1,
    })
    expect(me?.last_seen_at).not.toBeNull()
    expect(node.nodeId).toBe(readFileSync(flowPaths(home).nodeId, 'utf8').trim())
  })

  test('done：活动随续约上报，结果带节点 id', async () => {
    const id = await create(fake({ outcome: 'done', delay_ms: 3000, activity: ['一', '二'] }))
    const { task } = await until(id, (t) => t.status === 'done', 'done')
    expect(task.result).toMatchObject({ executor: 'fake', node_id: node.nodeId })
    expect(task.last_activity_at).not.toBeNull()
    expect(task.lease).toBeNull()
  })

  test('failed', async () => {
    const id = await create(fake({ outcome: 'failed', message: '模拟失败' }))
    const { task } = await until(id, (t) => t.status === 'failed', 'failed')
    expect(task.result?.summary).toBe('模拟失败')
  })

  test('blocked(question)：账本中能看到 fake 执行器上报的说明', async () => {
    const id = await create(
      fake({
        outcome: 'blocked',
        blocked_reason: 'question',
        message: '用哪个分支？',
        activity: ['问'],
      }),
    )
    const { task, events } = await until(id, (t) => t.status === 'blocked', 'blocked')
    expect(task.blocked).toEqual({ reason: 'question', message: '用哪个分支？', tail: ['问'] })
    expect(events.at(-1)).toMatchObject({
      type: 'task.blocked',
      actor: `node:${node.nodeId}`,
      payload: { reason: 'question', message: '用哪个分支？', node_id: node.nodeId },
    })
  })

  test('取消：续约得知 cancel_requested → 执行器取消 → 提交 cancelled', async () => {
    const id = await create(fake({ delay_ms: 3_600_000 }))
    await until(id, (t) => t.status === 'running', 'running')
    await api('POST', `/v1/tasks/${id}/cancel`, { reason: '不要了' })
    const { events } = await until(id, (t) => t.status === 'cancelled', 'cancelled')
    expect(events.map((e) => e.type).slice(-2)).toEqual(['task.cancel_requested', 'task.cancelled'])
    expect(events.at(-1)?.actor).toBe(`node:${node.nodeId}`)
  })

  test('合盖一小时后打开：任务保持 running，记录 hub.resumed', async () => {
    const id = await create(fake({ delay_ms: 3_600_000 * 3 }))
    await until(id, (t) => t.status === 'running', 'running')
    const before = (await api<{ ledger_seq: number }>('GET', '/v1/health')).ledger_seq
    clock.sleep(3_600_000)
    // 至少两轮过期扫描（真实 1 秒）。
    await new Promise((r) => setTimeout(r, 1_000))
    const { task, events } = await show(id)
    expect(task.status).toBe('running')
    expect(events.some((e) => e.type === 'task.lease_expired')).toBe(false)
    const resumed = await findEvent(before, 'hub.resumed')
    expect(resumed.payload).toMatchObject({ extended_leases: 1 })
    expect((resumed.payload as { slept_ms: number }).slept_ms).toBeGreaterThanOrEqual(3_590_000)
    await api('POST', `/v1/tasks/${id}/cancel`, {})
    await until(id, (t) => t.status === 'cancelled', 'cancelled')
  })

  test('节点被停止后租约过期 → blocked(node_lost)', async () => {
    const id = await create(fake({ delay_ms: 3_600_000 }))
    await until(id, (t) => t.status === 'running', 'running')
    await node.stop()
    const { task, events } = await until(id, (t) => t.status === 'blocked', 'node_lost')
    expect(task.blocked?.reason).toBe('node_lost')
    expect(events.map((e) => e.type).slice(-2)).toEqual(['task.lease_expired', 'task.blocked'])
  })

  test('允许重试：过期后 requeued，被另一个节点再次领取', async () => {
    const start = async (nodeId: string) => {
      const n = await startNode({ home, clock, logger: quiet, nodeId })
      if (!n.ok) throw new Error(n.error.message)
      extraNodes.push(n.data)
      return n.data
    }
    const x = await start('n-e2e-x')
    const id = await create({ ...fake({ delay_ms: 3_600_000 }), retry: { max_attempts: 2 } })
    await until(id, (t) => t.lease?.node_id === 'n-e2e-x', '节点 x 领取')
    await x.stop()
    await start('n-e2e-y')
    const { task, events } = await until(
      id,
      (t) => t.lease?.node_id === 'n-e2e-y',
      '节点 y 再次领取',
    )
    expect(task).toMatchObject({ status: 'running', attempt: 2 })
    expect(events.map((e) => e.type)).toEqual([
      'task.created',
      'task.started',
      'lease.granted',
      'task.lease_expired',
      'task.requeued',
      'task.started',
      'lease.granted',
    ])
  })
})
