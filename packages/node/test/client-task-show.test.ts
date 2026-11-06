import { expect, test } from 'bun:test'
import { type ShowTaskData, taskContract } from '@raindown/core'
import { createNodeHubClient } from '../src/client.ts'

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

function client(events: unknown[]) {
  return createNodeHubClient({
    url: 'http://hub.test',
    token: 'test',
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

test('任务详情忽略较新中枢的未知事件类型，保留已知事件', async () => {
  const response = await client([
    known,
    { ...known, seq: 2, type: 'task.future_event', payload: { future: true } },
  ]).showTask('t1')
  expect(response.ok).toBe(true)
  if (response.ok) expect(response.data.events).toEqual([known])
})

test('任务详情仍拒绝已知事件类型的非法 payload', async () => {
  const response = await client([
    { ...known, seq: 2, type: 'task.future_event', payload: {} },
    { ...known, payload: { contract: null } },
  ]).showTask('t1')
  expect(response).toMatchObject({ ok: false, error: { code: 'hub_unavailable' } })
})
