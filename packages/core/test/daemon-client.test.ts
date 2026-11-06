import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HubClient } from '../src/daemon/client.ts'
import type { ShowTaskData } from '../src/ledger/protocol.ts'
import { taskContract } from '../src/ledger/task.ts'

const keys = [
  'RAINDOWN_HUB_TOKEN',
  'FLOW_HUB_TOKEN',
  'RAINDOWN_HUB_TOKEN_FILE',
  'FLOW_HUB_TOKEN_FILE',
] as const
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
const roots: string[] = []
afterEach(async () => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

test('HubClient token 新名优先、空白回退旧名，只发送新身份头', async () => {
  const home = await mkdtemp(join(tmpdir(), 'raindown-client-'))
  roots.push(home)
  for (const key of keys) delete process.env[key]
  let received: Headers | undefined
  const client = new HubClient({
    home,
    actor: 'codex',
    fetch: async (request) => {
      received = request.headers
      return Response.json({
        ok: false,
        error: { kind: 'failure', code: 'fixture', message: 'fixture' },
      })
    },
  })
  process.env.FLOW_HUB_TOKEN = 'legacy'
  process.env.RAINDOWN_HUB_TOKEN = 'new'
  await client.listTasks()
  expect(received?.get('authorization')).toBe('Bearer new')
  expect(received?.get('x-raindown-actor')).toBe('codex')
  expect(received?.has('x-flow-actor')).toBe(false)
  process.env.RAINDOWN_HUB_TOKEN = ' '
  await client.listTasks()
  expect(received?.get('authorization')).toBe('Bearer legacy')
  const file = join(home, 'legacy.token')
  await writeFile(file, 'file-token')
  process.env.FLOW_HUB_TOKEN_FILE = file
  process.env.RAINDOWN_HUB_TOKEN_FILE = ' '
  await client.listTasks()
  expect(received?.get('authorization')).toBe('Bearer file-token')
  process.env.RAINDOWN_HUB_TOKEN_FILE = join(home, 'missing.token')
  expect(await client.listTasks()).toMatchObject({
    ok: false,
    error: { code: 'token_file_missing' },
  })
})

const timestamp = '2026-10-24T00:00:00.000Z'
const contract = taskContract.parse({
  goal: '读取任务',
  workspace: 'ws/demo',
  role: 'developer',
  executor: 'fake',
})
const known = {
  seq: 1,
  ts: timestamp,
  type: 'task.created',
  task_id: 't1',
  workspace: 'ws/demo',
  actor: 'hub',
  payload: { contract },
} satisfies ShowTaskData['events'][number]

async function taskClient(events: unknown[]) {
  const home = await mkdtemp(join(tmpdir(), 'raindown-client-show-'))
  roots.push(home)
  return new HubClient({
    home,
    actor: 'user',
    token: 'fixture',
    fetch: async () =>
      Response.json({
        ok: true,
        data: {
          task: {
            id: 't1',
            workspace: 'ws/demo',
            status: 'queued',
            contract,
            attempt: 0,
            created_at: timestamp,
            updated_at: timestamp,
            started_at: null,
            finished_at: null,
            cancel_requested: false,
            blocked: null,
            lease: null,
            result: null,
            created_by: 'hub',
            origin: null,
            branch: null,
            last_activity_at: null,
          },
          events,
          replies: [],
        },
      }),
  })
}

test('CLI HubClient 任务详情忽略未知事件，保留已知事件', async () => {
  const client = await taskClient([
    known,
    { ...known, seq: 2, type: 'task.future_event', payload: { future: true } },
  ])
  const response = await client.showTask('t1')
  expect(response.ok).toBe(true)
  if (response.ok) expect(response.data.events).toEqual([known])
})

test('CLI HubClient 任务详情仍拒绝已知事件的错误载荷', async () => {
  const client = await taskClient([
    { ...known, seq: 2, type: 'task.future_event', payload: {} },
    { ...known, payload: { contract: null } },
  ])
  expect(await client.showTask('t1')).toMatchObject({
    ok: false,
    error: { code: 'invalid_hub_response' },
  })
})
