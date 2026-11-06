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
  return { ...ledger, service: protocol.service }
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
  const executors: ExecutorInfo[] = [{ type: 'custom-harness', mode: 'headless', capabilities }]
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
  const expected = [{ ...oldExecutor, capabilities: NO_ADAPTER_CAPABILITIES }]
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
