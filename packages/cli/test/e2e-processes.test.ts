import { afterAll, beforeAll, expect, test } from 'bun:test'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * add-m1-ledger-daemon 7.1：真实的中枢与节点进程，只经 CLI 交互（不在测试进程内 import 中枢或节点）。
 * 覆盖完成、卡住、取消、节点被杀后的 node_lost，以及中枢被杀后重启时账本完整。
 */

const MAIN = join(import.meta.dir, '..', 'src', 'main.ts')
const home = join(mkdtempSync(join(tmpdir(), 'flow-e2e-proc-')), 'home')
const env = { ...process.env, FLOW_HOME: home }
let hub: ChildProcess | undefined
let node: ChildProcess | undefined

function flow(...args: string[]) {
  const r = spawnSync(process.execPath, [MAIN, ...args, '--json'], { env, encoding: 'utf8' })
  const body = r.stdout.trim() ? JSON.parse(r.stdout) : null
  return { code: r.status, body }
}

const start = (...args: string[]) =>
  spawn(process.execPath, [MAIN, ...args], { env, stdio: ['ignore', 'ignore', 'pipe'] })

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
}

async function until<T>(fn: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = fn()
    if (v !== undefined) return v
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

let port = 0
const healthy = async () => {
  try {
    return (await fetch(`http://127.0.0.1:${port}/v1/health`)).ok
  } catch {
    return false
  }
}

async function startHub() {
  hub = start('hub', 'start')
  for (const deadline = Date.now() + 15_000; !(await healthy()); ) {
    if (Date.now() > deadline) throw new Error('中枢没有就绪')
    await new Promise((r) => setTimeout(r, 200))
  }
}

function createFake(goal: string, fake: Record<string, unknown>): string {
  const file = join(home, `${goal}.json`)
  writeFileSync(
    file,
    JSON.stringify({ goal, workspace: 'ws/demo', role: 'dev', executor: 'fake', inputs: { fake } }),
  )
  const r = flow('task', 'create', '--file', file)
  expect(r.code).toBe(0)
  return r.body.data.task.id as string
}

const status = (id: string) =>
  flow('task', 'show', id).body?.data?.task?.status as string | undefined
const waitStatus = (id: string, want: string, ms = 20_000) =>
  until(() => (status(id) === want ? want : undefined), ms, `${id} 变为 ${want}`)

beforeAll(async () => {
  expect(flow('init').code).toBe(0)
  writeFileSync(
    join(home, 'config', 'workspaces', 'demo.yaml'),
    'id: demo\nkind: product\nname: Demo\ndescription: 端到端\nrepos: []\n',
  )
  port = await freePort()
  // 最短的租约 TTL，让 node_lost 在十几秒内发生
  writeFileSync(join(home, 'config', 'hub.yaml'), `port: ${port}\nlease_ttl_s: 5\n`)
  await startHub()
  node = start('node', 'start')
  await until(
    () => (flow('node', 'list').body?.data?.nodes?.length ? true : undefined),
    15_000,
    '节点注册',
  )
}, 60_000)

afterAll(() => {
  node?.kill('SIGKILL')
  hub?.kill('SIGKILL')
})

test('完成、卡住、取消', async () => {
  const done = createFake('done', { outcome: 'done', delay_ms: 200 })
  await waitStatus(done, 'done')

  const blocked = createFake('blocked', {
    outcome: 'blocked',
    blocked_reason: 'question',
    message: '用方案 A 还是 B？',
    delay_ms: 200,
  })
  await waitStatus(blocked, 'blocked')
  const shown = flow('task', 'show', blocked).body.data.task
  expect(shown.blocked?.reason).toBe('question')

  const long = createFake('cancel', { outcome: 'done', delay_ms: 60_000 })
  await waitStatus(long, 'running')
  expect(flow('task', 'cancel', long).code).toBe(0)
  await waitStatus(long, 'cancelled')
}, 60_000)

test('节点被杀后任务变为 blocked(node_lost)', async () => {
  const id = createFake('orphan', { outcome: 'done', delay_ms: 120_000 })
  await waitStatus(id, 'running')
  node?.kill('SIGKILL')
  node = undefined
  // TTL 5 秒 + 过期扫描周期 5 秒
  await waitStatus(id, 'blocked', 30_000)
  const shown = flow('task', 'show', id).body.data.task
  expect(shown.blocked?.reason).toBe('node_lost')
}, 60_000)

test('中枢被 kill -9 后重启，账本完整', async () => {
  const before = flow('task', 'list')
    .body.data.tasks.map((t: { id: string }) => t.id)
    .sort()
  expect(before.length).toBeGreaterThanOrEqual(4)
  hub?.kill('SIGKILL')
  for (const deadline = Date.now() + 10_000; await healthy(); ) {
    if (Date.now() > deadline) throw new Error('中枢没有退出')
    await new Promise((r) => setTimeout(r, 200))
  }
  await startHub()
  const after = flow('task', 'list')
    .body.data.tasks.map((t: { id: string }) => t.id)
    .sort()
  expect(after).toEqual(before)
}, 60_000)
