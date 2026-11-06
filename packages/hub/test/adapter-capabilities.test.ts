import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  type AdapterCapabilities,
  type ExecutorInfo,
  NO_ADAPTER_CAPABILITIES,
  openDatabase,
} from '@raindown/core'
import { createNodeProtocol } from '../src/index.ts'
import { tempLedger } from './ledger-helpers.ts'

let savedHome: string | undefined
const cleanups: Array<() => void> = []
beforeEach(() => {
  savedHome = process.env.RAINDOWN_HOME
})
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  if (savedHome === undefined) delete process.env.RAINDOWN_HOME
  else process.env.RAINDOWN_HOME = savedHome
})

async function setup() {
  const ledger = await tempLedger()
  process.env.RAINDOWN_HOME = ledger.dir
  cleanups.push(ledger.cleanup)
  const protocol = createNodeProtocol({ ledger: ledger.store, leaseTtlS: 60, leaseWaitMaxS: 30 })
  cleanups.push(() => protocol.stop())
  return { ...ledger, service: protocol.service, routes: protocol.routes }
}

const registration = {
  node_id: 'n-adapter',
  hostname: 'host',
  version: '0',
  capabilities: ['executor:custom-harness'],
}

test('注册保存任意适配器自述的能力，重放后仍可列出', async () => {
  const { store, service } = await setup()
  const capabilities: AdapterCapabilities = {
    approval_requests: 'structured',
    inject_while_running: true,
    resume_session: false,
    raindown_mcp: true,
    out_of_band_detection: false,
  }
  const executors: ExecutorInfo[] = [
    { type: 'custom-harness', mode: 'headless', adapter_capabilities: capabilities },
  ]
  const registered = service.registerNode({ ...registration, executors }, 'unknown')
  expect(registered.ok && registered.data.node.executors).toEqual(executors)
  expect(store.eventsAfter(0)[0]?.payload).toMatchObject({ executors })
  expect(store.rebuild().ok).toBe(true)
  const listed = service.listNodes()
  expect(listed.ok && listed.data.nodes[0]?.executors).toEqual(executors)
})

test('旧节点注册、旧投影与旧注册事件重放都补齐保守能力', async () => {
  const { path, store, service } = await setup()
  const oldExecutor = { type: 'codex-orca', mode: 'interactive' as const }
  const oldExecutors = [oldExecutor]
  const expected = [{ ...oldExecutor, adapter_capabilities: NO_ADAPTER_CAPABILITIES }]
  const registered = service.registerNode({ ...registration, executors: oldExecutors }, 'unknown')
  expect(registered.ok && registered.data.node.executors).toEqual(expected)

  // 模拟升级前已存在的节点投影和账本，不能靠新写入的 schema 补缺省。
  const db = await openDatabase(path)
  try {
    db.prepare('UPDATE nodes SET executors_json = ? WHERE node_id = ?').run(
      JSON.stringify(oldExecutors),
      registration.node_id,
    )
    db.prepare('INSERT INTO events (ts, type, actor, payload_json) VALUES (?, ?, ?, ?)').run(
      '2026-11-06T00:00:00.000Z',
      'node.registered',
      'node:n-adapter',
      JSON.stringify({ ...registration, executors: oldExecutors, concurrency: 1 }),
    )
  } finally {
    db.close()
  }
  expect(store.getNode(registration.node_id)?.executors).toEqual(expected)
  expect(store.rebuild().ok).toBe(true)
  expect(store.getNode(registration.node_id)?.executors).toEqual(expected)
})

test('HTTP 注册剥离未来能力键，已知能力字段类型错误仍拒绝', async () => {
  const { routes } = await setup()
  const register = (adapter_capabilities: unknown) =>
    routes.request('/v1/nodes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...registration,
        executors: [{ type: 'custom-harness', adapter_capabilities, future_metadata: true }],
      }),
    })
  const response = await register({ ...NO_ADAPTER_CAPABILITIES, future_feature: true })
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body).toHaveProperty('data.node.executors', [
    { type: 'custom-harness', adapter_capabilities: NO_ADAPTER_CAPABILITIES },
  ])
  const invalid = await register({ ...NO_ADAPTER_CAPABILITIES, resume_session: 'true' })
  expect(invalid.status).toBe(400)
})

test.each(['event', 'projection'] as const)(
  '读取 %s 的未来能力键与未知字段值时逐项降级，保留其他已知能力',
  async (source) => {
    const { path, store, service } = await setup()
    const registered = service.registerNode(
      { ...registration, executors: [{ type: 'custom-harness' }] },
      'unknown',
    )
    expect(registered.ok).toBe(true)
    const executors = [
      {
        type: 'custom-harness',
        future_metadata: true,
        adapter_capabilities: {
          approval_requests: 'future-approval-mode',
          inject_while_running: true,
          resume_session: 'unsupported',
          raindown_mcp: true,
          future_feature: true,
        },
      },
    ]
    const db = await openDatabase(path)
    try {
      if (source === 'projection') {
        db.prepare('UPDATE nodes SET executors_json = ? WHERE node_id = ?').run(
          JSON.stringify(executors),
          registration.node_id,
        )
      } else {
        db.prepare('INSERT INTO events (ts, type, actor, payload_json) VALUES (?, ?, ?, ?)').run(
          '2026-11-06T00:00:00.000Z',
          'node.registered',
          'node:n-adapter',
          JSON.stringify({ ...registration, executors, concurrency: 1 }),
        )
      }
    } finally {
      db.close()
    }
    if (source === 'event') expect(store.rebuild().ok).toBe(true)
    expect(store.getNode(registration.node_id)?.executors).toEqual([
      {
        type: 'custom-harness',
        adapter_capabilities: {
          ...NO_ADAPTER_CAPABILITIES,
          inject_while_running: true,
          raindown_mcp: true,
        },
      },
    ])
  },
)
