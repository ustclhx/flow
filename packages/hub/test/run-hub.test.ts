import { afterEach, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flowPaths, initFlowHome } from '@flow/core'
import { type RunningHub, runHub } from '../src/index.ts'

let hub: RunningHub | undefined
afterEach(async () => {
  await hub?.stop()
  hub = undefined
})

async function setupHome(): Promise<string> {
  const home = join(mkdtempSync(join(tmpdir(), 'flow-run-hub-')), 'home')
  const init = await initFlowHome(home)
  if (!init.ok) throw new Error(init.error.message)
  mkdirSync(join(home, 'config', 'workspaces'), { recursive: true })
  writeFileSync(
    join(home, 'config', 'workspaces', 'demo.yaml'),
    'id: demo\nkind: product\nname: Demo\ndescription: 测试\nrepos: []\n',
  )
  return home
}

const quiet = { info() {}, warn() {}, error() {} }

/** 启动时若已过当天的备份时刻，会补做一次备份并写入 hub.backup_done。 */
const backupEvents = (home: string) => {
  const dir = flowPaths(home).backups
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.db')).length : 0
}

test('runHub：打开账本、挂载任务路由、写入 hub.started，认证生效，第二个实例被拒绝', async () => {
  const home = await setupHome()
  const started = await runHub({ home, port: 0, logger: quiet as never })
  if (!started.ok) throw new Error(started.error.message)
  hub = started.data
  const token = readFileSync(flowPaths(home).hubToken, 'utf8').trim()
  const auth = { Authorization: `Bearer ${token}`, 'X-Flow-Actor': 'user' }

  expect((await fetch(`${hub.url}/v1/tasks`)).status).toBe(401)

  const created = await fetch(`${hub.url}/v1/tasks`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal: '端到端', workspace: 'ws/demo', role: 'dev', executor: 'fake' }),
  })
  expect(created.status).toBe(201)
  const { data } = (await created.json()) as { data: { task: { id: string; status: string } } }
  expect(data.task.status).toBe('queued')

  const listed = (await (await fetch(`${hub.url}/v1/tasks`, { headers: auth })).json()) as {
    data: { tasks: Array<{ id: string }> }
  }
  expect(listed.data.tasks.map((t) => t.id)).toEqual([data.task.id])

  const health = (await (await fetch(`${hub.url}/v1/health`)).json()) as {
    data: { ledger_seq: number }
  }
  // hub.started、supervisor.scheduler_initialized（首次启动）、task.created，以及可能的启动补做备份
  expect(health.data.ledger_seq).toBe(3 + backupEvents(home))

  const second = await runHub({ home, port: 0, logger: quiet as never })
  expect(second.ok).toBe(false)
  if (!second.ok) expect(second.error.code).toBe('hub_already_running')
})

test('runHub：停止后重启，账本保留并追加新的 hub.started', async () => {
  const home = await setupHome()
  const first = await runHub({ home, port: 0, logger: quiet as never })
  if (!first.ok) throw new Error(first.error.message)
  await first.data.stop()
  const second = await runHub({ home, port: 0, logger: quiet as never })
  if (!second.ok) throw new Error(second.error.message)
  hub = second.data
  const health = (await (await fetch(`${hub.url}/v1/health`)).json()) as {
    data: { ledger_seq: number }
  }
  // 两次 hub.started、一次初始化标记（只在首次启动写），加上可能的一次补做备份（同一天只做一次）
  expect(health.data.ledger_seq).toBe(3 + backupEvents(home))
})

test('runHub：停机超过一个 TTL 后重启，活动租约获得宽限，不会被立即判为 node_lost', async () => {
  const { openLedger } = await import('../src/index.ts')
  const { drafts, must, startTask, sys } = await import('./ledger-helpers.ts')
  const home = await setupHome()
  // 模拟 10 分钟前开始执行、之后中枢一直停机的任务
  const past = Date.now() - 10 * 60_000
  const old = await openLedger(flowPaths(home).ledgerDb, { now: () => past })
  must(old.append(drafts('t-grace')['task.created'], sys))
  startTask(old, 't-grace')
  const leaseId = old.activeLeases()[0]?.lease_id as string
  // 租约原定在 9 分钟前到期，此后没有任何续约
  old.renewLease(leaseId, new Date(past + 60_000).toISOString())
  expect(old.activeLeases()[0]?.expires_at.localeCompare(new Date().toISOString())).toBe(-1)
  old.close()

  const restartedAt = new Date().toISOString()
  const started = await runHub({ home, port: 0, logger: quiet as never })
  if (!started.ok) throw new Error(started.error.message)
  hub = started.data
  const token = readFileSync(flowPaths(home).hubToken, 'utf8').trim()
  const shown = (await (
    await fetch(`${hub.url}/v1/tasks/t-grace`, { headers: { Authorization: `Bearer ${token}` } })
  ).json()) as { data: { task: { status: string } } }
  expect(shown.data.task.status).toBe('running')
  await hub.stop()
  hub = undefined

  const after = await openLedger(flowPaths(home).ledgerDb)
  const lease = after.activeLeases()[0]
  after.close()
  expect(lease).toBeDefined()
  expect((lease?.expires_at ?? '') > restartedAt).toBe(true)
})
