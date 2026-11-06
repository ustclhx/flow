import { afterEach, expect, test } from 'bun:test'
import {
  eventReadPointer,
  HubClient,
  type LedgerEvent,
  okBody,
  readOperation,
  showTaskData,
  taskReadPointer,
  taskSectionData,
} from '@raindown/core'
import { createHubApp, createTaskRoutes, createTaskService } from '../src/index.ts'
import type { WakeCaller } from '../src/server/wake-tokens.ts'
import { anyRole, drafts, must, startTask, sys, tempLedger, WS } from './ledger-helpers.ts'
import { authHeaders, testToken } from './server-fixtures.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

async function setup() {
  const l = await tempLedger()
  cleanups.push(l.cleanup)
  const tasks = createTaskService({ ledger: l.store, workspaceExists: () => true, roles: anyRole })
  const wake: WakeCaller = {
    actor: 'supervisor',
    task_id: 'wake-1',
    workspace: WS,
    lease_id: 'lease-wake',
    origin: 'instruction',
    generation: 1,
  }
  const global = must(
    l.store.append({ type: 'hub.rebuilt', payload: { events_replayed: 0, duration_ms: 0 } }, sys),
  )
  const unreferenced = must(
    l.store.append({ type: 'hub.rebuilt', payload: { events_replayed: 0, duration_ms: 0 } }, sys),
  )
  const ledger = {
    ...l.store,
    wakeOf: (id: string) =>
      id === wake.task_id
        ? {
            task_id: wake.task_id,
            workspace: WS,
            origin: 'instruction' as const,
            generation: 1,
            seq: 0,
            events: [global.seq],
          }
        : l.store.wakeOf(id),
  }
  const app = createHubApp({
    token: testToken,
    wakeTokens: { authenticate: (token) => (token === 'wake-token' ? wake : null) },
    mount: [{ path: '/', app: createTaskRoutes({ ledger, tasks }) }],
  })
  const read = (path: string, supervisor = false) =>
    app.request(path, {
      headers: supervisor ? { Authorization: 'Bearer wake-token' } : authHeaders,
    })
  return { ...l, ledger, tasks, app, read, global, unreferenced }
}

test('event_get 按精确seq读取，user可跨workspace，wake受workspace及唤醒全局事件范围限制', async () => {
  const s = await setup()
  const own = must(s.store.append(drafts('own')['task.created'], sys))
  const other = must(s.store.append(drafts('other', { ws: 'ws/other' })['task.created'], sys))
  expect((await s.read(`/v1/events/${own.seq}`, true)).status).toBe(200)
  const ai = await s.app.request(`/v1/events/${own.seq}`, {
    headers: { ...authHeaders, 'X-Raindown-Actor': 'reviewer' },
  })
  expect(ai.status).toBe(403)
  expect(await ai.json()).toMatchObject({ error: { code: 'forbidden' } })
  expect((await s.read(`/v1/events/${other.seq}`)).status).toBe(200)
  for (const seq of [other.seq, s.unreferenced.seq]) {
    const response = await s.read(`/v1/events/${seq}`, true)
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'forbidden' } })
  }
  expect((await s.read(`/v1/events/${s.global.seq}`, true)).status).toBe(200)
  expect(await (await s.read('/v1/events/9999')).json()).toMatchObject({
    error: { code: 'not_found' },
  })
  expect((await s.read('/v1/events/0')).status).toBe(400)
  expect((await s.read('/v1/tasks/other', true)).status).toBe(403)
})

test('event_get 保留未知事件，遮蔽历史内容中的疑似密钥；读取指针可经HubClient直接执行', async () => {
  const s = await setup()
  const unknown = {
    seq: 100,
    ts: '2026-10-24T00:00:00.000Z',
    type: 'future.context',
    actor: 'hub',
    workspace: WS,
    payload: { nested: { text: `旧记录 Bearer ${'a'.repeat(30)}` } },
  } as unknown as LedgerEvent
  s.ledger.eventsAfter = () => [unknown]
  const client = new HubClient({
    home: s.dir,
    actor: 'user',
    token: testToken,
    fetch: async (request) => s.app.request(new URL(request.url).pathname, request),
  })
  const pointer = eventReadPointer(100)
  expect(readOperation.safeParse(pointer.read).success).toBe(true)
  const result = must(await client.getEvent(pointer.read.args.seq))
  expect(result.event.type).toBe('future.context')
  expect(result.event.payload).toEqual({ nested: { text: '旧记录 Bearer [REDACTED:bearer]' } })
})

test('task_show 默认保持完整；分段分页可追回全部终端片段并列出关联事件、派工、回复', async () => {
  const s = await setup()
  must(s.store.append(drafts('task-1')['task.created'], sys))
  const d = startTask(s.store, 'task-1')
  const text = '终端完整片段'.repeat(70)
  must(
    s.store.append(
      { ...d['task.blocked'], payload: { ...d['task.blocked'].payload, tail: [text] } },
      sys,
    ),
  )
  const full = okBody(showTaskData).parse(await (await s.read('/v1/tasks/task-1')).json())
  expect(full.data.events.length).toBe(4)
  expect(full.data.attempts).toHaveLength(1)
  expect(full.data.task.blocked?.tail).toEqual([text])
  let reconstructed = ''
  let offset = 0
  do {
    const pointer = taskReadPointer('task-1', 'tail', offset)
    expect(readOperation.safeParse(pointer.read).success).toBe(true)
    const query = new URLSearchParams({ section: 'tail', offset: String(offset), limit: '100' })
    const { data } = okBody(taskSectionData).parse(
      await (await s.read(`/v1/tasks/task-1?${query}`)).json(),
    )
    if (data.section !== 'tail') throw new Error('应返回终端片段')
    expect(data.task.blocked?.tail).toBeUndefined()
    expect(data.total).toBe(text.length)
    reconstructed += data.tail
    offset = data.next_offset ?? text.length
  } while (offset < text.length)
  expect(reconstructed).toBe(text)
  const page = okBody(taskSectionData).parse(
    await (await s.read('/v1/tasks/task-1?section=events&offset=1&limit=2')).json(),
  )
  if (page.data.section !== 'events') throw new Error('应返回事件分页')
  expect(page.data.events.map((event) => event.type)).toEqual(['task.started', 'lease.granted'])
  expect(page.data).toMatchObject({ total: 4, has_more: true, next_offset: 3 })
  for (const section of ['summary', 'attempts', 'replies'] as const) {
    expect(
      okBody(taskSectionData).parse(
        await (await s.read(`/v1/tasks/task-1?section=${section}`)).json(),
      ).data.section,
    ).toBe(section)
  }
  expect((await s.read('/v1/tasks/task-1?section=tail&offset=-1')).status).toBe(400)
})
