import { describe, expect, test } from 'bun:test'
import {
  foldTaskAttempts,
  type LedgerEvent,
  ledgerEvent,
  taskAttempt,
  taskContract,
} from '../src/index.ts'

const task = {
  id: 't_1',
  contract: taskContract.parse({
    goal: '复查 PR',
    workspace: 'ws/product-res',
    role: 'reviewer',
    executor: 'fake',
  }),
}

function event(seq: number, type: string, payload: unknown, taskId = task.id): LedgerEvent {
  return ledgerEvent.parse({
    seq,
    ts: `2026-10-24T08:00:${String(seq).padStart(2, '0')}.000Z`,
    type,
    workspace: task.contract.workspace,
    task_id: taskId,
    actor: 'hub',
    payload,
  }) as LedgerEvent
}

const started = (seq: number, attempt: number, nodeId = 'n1') =>
  event(seq, 'task.started', { node_id: nodeId, lease_id: `l${attempt}`, attempt })

describe('派工事件折叠', () => {
  test('首次派工使用创建版本，手动重试采用新版本，租约重排沿用该版本', () => {
    const versionedTask = {
      ...task,
      mandate: { created_by: 'user', origin: 'user', policy_version: '012345abcdef' },
    }
    const attempts = foldTaskAttempts(versionedTask, [
      started(1, 1),
      event(2, 'task.requeued', {
        reason: 'manual',
        requested_by: 'user',
        retry_reason: '按当前策略重试',
        policy_version: 'abcdef012345',
      }),
      started(3, 2),
      event(4, 'task.requeued', { reason: 'lease_expired' }),
      started(5, 3),
    ])
    expect(attempts.map((attempt) => attempt.policy_version)).toEqual([
      '012345abcdef',
      'abcdef012345',
      'abcdef012345',
    ])
    expect(attempts.every((attempt) => taskAttempt.safeParse(attempt).success)).toBe(true)
    expect(versionedTask.mandate.policy_version).toBe('012345abcdef')
  })

  test('旧手动重试缺少策略版本时不伪造派工版本', () => {
    const attempts = foldTaskAttempts(
      {
        ...task,
        mandate: { created_by: 'user', origin: 'user', policy_version: '012345abcdef' },
      },
      [
        started(1, 1),
        event(2, 'task.requeued', { reason: 'manual' }),
        started(3, 2),
        event(4, 'task.requeued', { reason: 'lease_expired' }),
        started(5, 3),
      ],
    )
    expect(attempts[0]?.policy_version).toBe('012345abcdef')
    expect(attempts[1]).not.toHaveProperty('policy_version')
    expect(attempts[2]).not.toHaveProperty('policy_version')
  })

  test('一次崩溃与一次重试保留同一任务的两次派工，忽略其他任务并按账本顺序返回', () => {
    const events = [
      started(1, 1),
      event(2, 'task.attempt_ended', { attempt: 1, reason: 'blocked', last_report: '执行器崩溃' }),
      event(3, 'task.blocked', { reason: 'crashed', message: '执行器退出' }),
      event(4, 'task.attempt_ended', { attempt: 1, reason: 'retry', last_report: '手动重跑' }),
      event(5, 'task.requeued', { reason: 'manual' }),
      started(6, 2, 'n2'),
      event(7, 'task.attempt_ended', { attempt: 2, reason: 'done' }),
      event(8, 'task.done', { result: { summary: '完成', executor: 'fake', node_id: 'n2' } }),
      event(9, 'task.started', { node_id: 'n3', lease_id: 'l3', attempt: 1 }, 't_other'),
    ]
    const folded = foldTaskAttempts(task, events.toReversed())
    expect(folded).toEqual([
      {
        attempt: 1,
        executor: 'fake',
        node_id: 'n1',
        started_at: '2026-10-24T08:00:01.000Z',
        ended_at: events[1]?.ts,
        reason: 'blocked',
        last_report: '执行器崩溃',
      },
      {
        attempt: 2,
        executor: 'fake',
        node_id: 'n2',
        started_at: '2026-10-24T08:00:06.000Z',
        ended_at: events[6]?.ts,
        reason: 'done',
      },
    ])
    expect(folded.every((attempt) => taskAttempt.safeParse(attempt).success)).toBe(true)
    expect(events[0]?.seq).toBe(1)
  })

  test('缺少结束事件的旧账在下一次开始或首次终态推断 unknown，活动派工不补结束', () => {
    const events = [
      started(1, 1),
      event(2, 'task.lease_expired', {
        lease_id: 'l1',
        node_id: 'n1',
        expired_at: '2026-10-24T08:00:02.000Z',
        attempt: 1,
      }),
      started(3, 2),
      event(4, 'task.failed', { message: '执行失败' }),
      event(5, 'task.requeued', { reason: 'manual' }),
      started(6, 3),
    ]
    const attempts = foldTaskAttempts(task, events)
    expect(
      attempts.map(({ attempt, ended_at, reason }) => ({ attempt, ended_at, reason })),
    ).toEqual([
      { attempt: 1, ended_at: events[2]?.ts, reason: 'unknown' },
      { attempt: 2, ended_at: events[3]?.ts, reason: 'unknown' },
      { attempt: 3, ended_at: undefined, reason: undefined },
    ])
  })

  test('显式结束补充终态后的记录，重复结束仅补齐缺失摘要', () => {
    const events = [
      started(1, 1),
      event(2, 'task.failed', { message: '失败' }),
      event(3, 'task.attempt_ended', { attempt: 1, reason: 'failed' }),
      event(4, 'task.attempt_ended', { attempt: 1, reason: 'retry', last_report: '最后上报' }),
    ]
    expect(foldTaskAttempts(task, events)[0]).toMatchObject({
      ended_at: events[2]?.ts,
      reason: 'failed',
      last_report: '最后上报',
    })
    expect(foldTaskAttempts(task, [])).toEqual([])
  })
})
