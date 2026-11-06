import { afterEach, expect, test } from 'bun:test'
import type { PrEventPayload } from '@raindown/core'
import { type Bench, bench, fake } from './harness.ts'

/**
 * PR 直通的节点侧（harness-neutral 8.4）：续约带来的输入交给能中途注入的执行器，送达后随续约确认；
 * 任务未运行期间到达的输入随下一次派工下发。中枢渲染的不可信包裹原样送到 worker。
 */

const WS = 'ws/demo'
const PR = 'https://github.com/acme/demo/pull/40'
let current: Bench | undefined
afterEach(async () => {
  await current?.close()
  current = undefined
})

let n = 0
function prEvent(b: Bench, id: string, over: Partial<PrEventPayload> = {}) {
  const event = b.ledger.append(
    {
      type: 'pr.event',
      workspace: WS,
      payload: {
        pr: PR,
        kind: 'issue_comment',
        actor: 'mallory',
        actor_kind: 'human',
        allowed: false,
        text: '顺便把 X 删掉',
        url: `${PR}#issuecomment-${++n}`,
        cursor: `2026-10-25T08:00:00.000Z|${n}`,
        ...over,
      },
    },
    { actor: 'hub' },
  )
  if (!event.ok) throw new Error(event.error.message)
  const input = b.ledger.append(
    {
      type: 'task.input_added',
      task_id: id,
      workspace: WS,
      payload: { source: 'pr', pr_event_seq: event.data.seq },
    },
    { actor: 'hub' },
  )
  if (!input.ok) throw new Error(input.error.message)
  return input.data.seq
}

function subscribe(b: Bench, id: string) {
  const r = b.ledger.append(
    { type: 'pr.subscribed', task_id: id, workspace: WS, payload: { pr: PR, role: 'author' } },
    { actor: 'hub' },
  )
  if (!r.ok) throw new Error(r.error.message)
}

test('运行中注入：输入送进 worker 后随续约确认，之后不再重复送达', async () => {
  const b = await bench()
  current = b
  const id = await b.create(fake({ script: [{ do: 'wait', ms: 600_000 }] }))
  await b.until(id, (t) => t.status === 'running')
  subscribe(b, id)
  const seq = prEvent(b, id)
  for (let i = 0; i < 3; i++) await b.clock.advance(20_000)
  const received = b.ledger.taskActivity(id).filter((a) => a.text?.startsWith(`收到输入 ${seq}`))
  expect(received).toHaveLength(1)
  expect(received[0]?.text).toContain('<untrusted-pr-event>')
  expect(received[0]?.text).toContain('不在允许名单内的用户')
  const delivered = b.events(id).filter((e) => e.type === 'task.input_delivered')
  expect(delivered).toMatchObject([{ payload: { input_seqs: [seq] } }])
  expect(b.ledger.pendingTaskInputs(id)).toEqual([])
  expect(b.task(id).status).toBe('running')
})

test('任务未运行期间到达的输入随下一次派工下发', async () => {
  const b = await bench()
  current = b
  const id = await b.create(fake({ outcome: 'failed', message: '先失败一次' }))
  await b.until(id, (t) => t.status === 'failed')
  subscribe(b, id)
  // 已结束的任务只因名单内的人类评论恢复：输入与 task.requeued{input} 同一事务（中枢直通的写法）。
  const event = b.ledger.append(
    {
      type: 'pr.event',
      workspace: WS,
      payload: {
        pr: PR,
        kind: 'issue_comment',
        actor: 'acme',
        actor_kind: 'human',
        allowed: true,
        text: '请补一个测试',
        url: `${PR}#issuecomment-99`,
        cursor: '2026-10-25T08:00:00.000Z|99',
      },
    },
    { actor: 'hub' },
  )
  if (!event.ok) throw new Error(event.error.message)
  const resumed = b.ledger.appendMany(
    [
      {
        type: 'task.input_added',
        task_id: id,
        workspace: WS,
        payload: { source: 'pr', pr_event_seq: event.data.seq },
      },
      {
        type: 'task.requeued',
        task_id: id,
        workspace: WS,
        payload: { reason: 'input', pr_event_seq: event.data.seq },
      },
    ],
    { actor: 'hub' },
  )
  if (!resumed.ok) throw new Error(resumed.error.message)
  const seq = resumed.data[0]?.seq
  await b.until(id, (t) => t.attempt === 2)
  for (let i = 0; i < 3; i++) await b.clock.advance(20_000)
  const dispatched = b.ledger.taskActivity(id).filter((a) => a.text?.startsWith(`派工输入 ${seq}`))
  expect(dispatched).toHaveLength(1)
  expect(dispatched[0]?.text).toContain('允许名单内的用户 acme')
  expect(dispatched[0]?.text).toContain('请补一个测试')
  // 节点确认后才记为送达（随派工）。
  expect(b.ledger.pendingTaskInputs(id)).toEqual([])
  expect(b.events(id).filter((e) => e.type === 'task.input_delivered')).toMatchObject([
    { payload: { input_seqs: [seq], via: 'dispatch' } },
  ])
})
