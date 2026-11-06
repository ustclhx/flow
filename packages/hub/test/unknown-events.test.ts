import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, raindownPaths } from '@raindown/core'
import {
  type EventInput,
  type LedgerStore,
  openLedger,
  type RunningHub,
  runHub,
} from '../src/index.ts'
import { createApplier } from '../src/ledger/apply.ts'
import { WakeProjection } from '../src/supervisor/projection.ts'
import { drafts, must, startTask, sys, WS } from './ledger-helpers.ts'

let home: string
let previousHome: string | undefined
let store: LedgerStore | undefined
let hub: RunningHub | undefined
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'raindown-unknown-events-'))
  mkdirSync(raindownPaths(home).state, { recursive: true })
  previousHome = process.env.RAINDOWN_HOME
  process.env.RAINDOWN_HOME = home
})
afterEach(async () => {
  await hub?.stop()
  hub = undefined
  store?.close()
  store = undefined
  if (previousHome === undefined) delete process.env.RAINDOWN_HOME
  else process.env.RAINDOWN_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

/** 模拟更新版本已写入的事件；正式写入接口仍须拒绝未知类型。 */
async function insertUnknown(path: string) {
  const db = await openDatabase(path)
  try {
    db.prepare(
      'INSERT INTO events (ts, type, workspace, task_id, actor, payload_json) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      '2026-10-24T00:00:00.000Z',
      'task.future_event',
      'ws/future',
      't1',
      'future',
      JSON.stringify({ future: { value: 1 } }),
    )
  } finally {
    db.close()
  }
}

test('未知事件可读取且不改变任何投影，重建继续处理后续事件；写入仍严格拒绝', async () => {
  const path = raindownPaths(home).ledgerDb
  store = await openLedger(path)
  must(store.append(drafts('t1')['task.created'], sys))
  startTask(store, 't1')
  must(
    store.appendMany(
      [
        {
          ...drafts('t1')['task.blocked'],
          payload: { reason: 'question', message: '确认', lease_held: true },
        },
        {
          type: 'task.replied',
          task_id: 't1',
          workspace: WS,
          payload: { reply_id: 'r-one', kind: 'text', text: '继续' },
        },
        {
          type: 'node.registered',
          payload: {
            node_id: 'n1',
            hostname: 'test',
            version: '0.1.0',
            capabilities: [],
            executors: [],
            concurrency: 1,
          },
        },
        {
          type: 'schedule.fired',
          workspace: WS,
          payload: { rule_id: 'daily', planned_at: '2026-10-24T00:00:00.000Z' },
        },
        {
          type: 'inbox.item_created',
          task_id: 't1',
          workspace: WS,
          payload: {
            item_id: 'blk.4',
            level: 'decide',
            source: 'task',
            source_ref: 't1',
            title: '确认',
            actions: [],
          },
        },
        {
          type: 'inbox.pushed',
          payload: { channel: 'test', item_ids: ['blk.4'], ref: 'message1' },
        },
      ],
      { actor: 'hub', actors: [undefined, 'user', undefined, undefined, undefined, undefined] },
    ),
  )
  const unknownSeq = store.seq() + 1
  await insertUnknown(path)
  // 未知事件甚至可以引用当前版本不能理解的 workspace 关系，不能套用旧类型的一致性规则。
  const unknown = store.eventsAfter(unknownSeq - 1)[0]
  if (!unknown) throw new Error('缺少未知事件')
  expect(unknown).toMatchObject({
    seq: unknownSeq,
    type: 'task.future_event',
    payload: { future: { value: 1 } },
  })
  expect(store.latestEvent()).toEqual(unknown)
  expect(store.taskEvents('t1').at(-1)).toEqual(unknown)
  const before = store.snapshot({ includeSoft: false })
  const db = await openDatabase(path)
  try {
    createApplier(db)(unknown)
  } finally {
    db.close()
  }
  expect(store.snapshot({ includeSoft: false })).toEqual(before)
  const rejected = store.append(
    { type: 'task.future_event', payload: {} } as unknown as EventInput,
    sys,
  )
  expect(rejected).toMatchObject({ ok: false, error: { code: 'invalid_event' } })
  expect(store.seq()).toBe(unknownSeq)
  must(store.append(drafts('t2')['task.created'], sys))
  const expected = store.snapshot({ includeSoft: false })
  expect(must(store.rebuild()).events_replayed).toBe(unknownSeq + 1)
  expect(store.snapshot({ includeSoft: false })).toEqual(expected)
  expect(store.eventsAfter(unknownSeq - 1, {}, 1)[0]).toEqual(unknown)

  const projection = new WakeProjection({ item: () => null })
  expect(projection.apply(unknown)).toBeNull()
  expect(projection.position()).toBe(unknownSeq)
  expect(projection.workspaces()).toEqual([])
})

test('中枢启动重放未知事件时收件箱和 supervisor 正常启动，不产生任务或条目', async () => {
  const paths = raindownPaths(home)
  store = await openLedger(paths.ledgerDb)
  await insertUnknown(paths.ledgerDb)
  store.close()
  store = undefined
  mkdirSync(join(paths.config, 'workspaces'), { recursive: true })
  writeFileSync(
    join(paths.config, 'workspaces', 'demo.yaml'),
    'id: demo\nkind: product\nname: Demo\ndescription: 测试\nrepos: []\n',
  )
  const logger = { info() {}, warn() {}, error() {} }
  hub = must(
    await runHub({
      home,
      port: 0,
      logger,
      secrets: { watch: false },
      inbox: { watch: false, channels: [] },
    }),
  )
  const headers = { Authorization: `Bearer ${readFileSync(paths.hubToken, 'utf8').trim()}` }
  const tasks = await (await fetch(`${hub.url}/v1/tasks`, { headers })).json()
  expect(tasks).toMatchObject({ ok: true, data: { tasks: [] } })
  const inbox = await (await fetch(`${hub.url}/v1/inbox?workspace=ws%2Ffuture`, { headers })).json()
  expect(inbox).toMatchObject({ ok: true, data: { items: [] } })
  await hub.stop()
  hub = undefined
  store = await openLedger(paths.ledgerDb)
  expect(store.eventsAfter(0)[0]?.type as string).toBe('task.future_event')
  expect(
    store.eventsAfter(0).some((event) => event.type === 'supervisor.scheduler_initialized'),
  ).toBe(true)
})
