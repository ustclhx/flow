import { describe, expect, test } from 'bun:test'
import {
  type ActiveDelegation,
  activeDelegation,
  isWaitingHumanStage,
  type LedgerEvent,
  ledgerEvent,
  TASK_STAGE_LABELS,
  type TaskStage,
  type TaskView,
  taskStage,
  taskStageFilter,
  taskStageSchema,
  taskView,
} from '../src/index.ts'

const baseTask = taskView.parse({
  id: 't_stage',
  workspace: 'ws/product-res',
  status: 'running',
  contract: {
    goal: '完成修改并交付审阅',
    workspace: 'ws/product-res',
    role: 'developer',
    executor: 'fake',
  },
  attempt: 1,
  created_at: '2026-10-24T08:00:00.000Z',
  updated_at: '2026-10-24T08:00:00.000Z',
  started_at: '2026-10-24T08:00:01.000Z',
  finished_at: null,
  cancel_requested: false,
  blocked: null,
  lease: null,
  result: null,
  created_by: 'user',
  origin: null,
  branch: null,
  last_activity_at: null,
})

function task(overrides: Partial<TaskView> = {}): TaskView {
  return { ...baseTask, ...overrides }
}

function blockedTask(reason: NonNullable<TaskView['blocked']>['reason']): TaskView {
  return task({ status: 'blocked', blocked: { reason, message: '等待处理', lease_held: true } })
}

function event(
  seq: number,
  type: string,
  payload: unknown,
  actor = 'hub',
  taskId = baseTask.id,
): LedgerEvent {
  return ledgerEvent.parse({
    seq,
    ts: `2026-10-24T08:00:${String(seq).padStart(2, '0')}.000Z`,
    workspace: baseTask.workspace,
    task_id: taskId,
    actor,
    type,
    payload,
  }) as LedgerEvent
}

const started = (seq = 1, attempt = 1) =>
  event(seq, 'task.started', { attempt, node_id: 'n1', lease_id: `l${attempt}` })
const ended = (seq = 3, attempt = 1) =>
  event(seq, 'task.attempt_ended', { attempt, reason: 'blocked' })
const blockedEvent = (seq = 2, reason = 'other') =>
  event(seq, 'task.blocked', { reason, message: '等待处理' })
const ready = (seq = 2, attempt = 1) =>
  event(seq, 'task.reported', {
    attempt,
    lease_id: `l${attempt}`,
    status: 'ready',
    summary: '交付审阅',
    deliverables: ['https://github.com/example/repo/pull/1'],
  })
const progress = (seq = 3, attempt = 1) =>
  event(seq, 'task.reported', {
    attempt,
    lease_id: `l${attempt}`,
    status: 'progress',
    summary: '继续',
  })
const reply = (seq = 3, actor = 'user', via?: 'cli' | 'supervisor') =>
  event(seq, 'task.replied', { reply_id: `r-${seq}`, kind: 'text', text: '继续', via }, actor)

const delegation: ActiveDelegation = {
  seq: 3,
  block_seq: 2,
  kind: 'awaiting_approval',
  deadline: '2026-10-24T09:00:00.000Z',
}

describe('任务阶段', () => {
  test('阶段 schema、中文名称与等人筛选共用同一组阶段', () => {
    expect(Object.keys(TASK_STAGE_LABELS)).toEqual(taskStageSchema.options)
    expect(taskStageFilter.parse('waiting-human')).toBe('waiting-human')
    expect(taskStageFilter.safeParse('running').success).toBe(false)
    expect(taskStageSchema.options.filter(isWaitingHumanStage)).toEqual([
      'waiting-human-approval',
      'waiting-human-answer',
      'waiting-human-review',
    ])
    expect(isWaitingHumanStage(null)).toBe(false)
  })

  test.each(['done', 'failed', 'cancelled'] as const)('终态 %s 没有阶段', (status) => {
    expect(taskStage(task({ status }), delegation, { events: [started(), ready()] })).toBeNull()
  })

  test.each([
    ['awaiting_approval', 'waiting-human-approval'],
    ['question', 'waiting-human-answer'],
    ['no_progress', 'stalled'],
    ['crashed', 'stalled'],
    ['workdir_missing', 'stalled'],
    ['node_lost', 'stalled'],
    ['other', 'stalled'],
  ] as const)('单独卡住原因 %s 派生为 %s', (reason, stage) => {
    expect(
      taskStage(blockedTask(reason), null, { events: [started(), blockedEvent(2, reason)] }),
    ).toBe(stage)
  })

  test('未委托授权与提问优先于待审交付物，进行中委托优先于待审和受阻', () => {
    const events = [started(), ready(3), blockedEvent(2)]
    expect(taskStage(blockedTask('awaiting_approval'), null, { events })).toBe(
      'waiting-human-approval',
    )
    expect(taskStage(blockedTask('question'), null, { events })).toBe('waiting-human-answer')
    for (const reason of ['awaiting_approval', 'question', 'other'] as const) {
      expect(taskStage(blockedTask(reason), delegation, { events })).toBe('waiting-supervisor')
    }
  })

  test.each(['supervisor', 'timeout', 'policy_changed'] as const)(
    '委托因 %s 转交后回到等人授权，不读取当前时钟',
    (reason) => {
      const current = blockedTask('awaiting_approval')
      const events = [
        started(),
        blockedEvent(2, 'awaiting_approval'),
        event(3, 'task.reply_delegated', {
          task_id: current.id,
          block_seq: 2,
          kind: 'awaiting_approval',
          deadline: '2020-01-01T00:00:00.000Z',
        }),
      ]
      expect(taskStage(current, activeDelegation(current, events), { events })).toBe(
        'waiting-supervisor',
      )
      events.push(event(4, 'task.reply_escalated', { reason, block_seq: 2 }))
      expect(taskStage(current, activeDelegation(current, events), { events })).toBe(
        'waiting-human-approval',
      )
    },
  )

  test('最新 ready 且有交付物时，优先于受阻及无派工排队', () => {
    const events = [started(), ready(3), ended(4), blockedEvent(2)]
    expect(taskStage(blockedTask('other'), null, { events })).toBe('waiting-human-review')
    expect(taskStage(task(), null, { events })).toBe('waiting-human-review')
    const withoutDeliverables = events.map((e) =>
      e.type === 'task.reported' ? { ...e, payload: { ...e.payload, deliverables: undefined } } : e,
    )
    expect(taskStage(task(), null, { events: withoutDeliverables })).toBe('queued')
  })

  test('只看当前任务最新上报，排序不修改传入事件', () => {
    const foreign = event(
      6,
      'task.reported',
      {
        attempt: 1,
        lease_id: 'l1',
        status: 'progress',
        summary: '其他任务',
      },
      'worker',
      't_other',
    )
    const events = [foreign, ready(4), progress(3), started()]
    const original = [...events]
    expect(taskStage(task(), null, { events })).toBe('waiting-human-review')
    expect(events).toEqual(original)
    expect(taskStage(task(), null, { events: [...events, progress(5)] })).toBe('working')
  })

  test('重排与新派工不沿用旧 ready，上报也必须属于最新派工', () => {
    const events = [started(), ready(), ended(), event(4, 'task.requeued', { reason: 'manual' })]
    expect(taskStage(task({ status: 'queued' }), null, { events })).toBe('queued')
    events.push(started(5, 2))
    expect(taskStage(task({ attempt: 2 }), null, { events })).toBe('working')
    events.push(ready(6, 1))
    expect(taskStage(task({ attempt: 2 }), null, { events })).toBe('working')
    events.push(ready(7, 2))
    expect(taskStage(task({ attempt: 2 }), null, { events })).toBe('waiting-human-review')
  })

  test.each([
    ['user', undefined],
    ['supervisor', 'supervisor'],
    ['hxlee', 'cli'],
  ] as const)('其他卡住在 %s 回复后按派工继续派生', (actor, via) => {
    expect(
      taskStage(blockedTask('other'), null, {
        events: [reply(3, actor, via), blockedEvent(), started()],
      }),
    ).toBe('working')
  })

  test('旧卡住前的回复、worker 回复与其他任务回复不解除当前受阻', () => {
    const foreignReply = { ...reply(5), task_id: 't_other' }
    const events = [started(), reply(2), blockedEvent(3), reply(4, 'worker'), foreignReply]
    expect(taskStage(blockedTask('other'), null, { events })).toBe('stalled')
    expect(
      taskStage(blockedTask('other'), null, { events: [...events, reply(6), blockedEvent(7)] }),
    ).toBe('stalled')
  })

  test('受阻优先于无活动派工的排队，回复后才排队', () => {
    const events = [started(), blockedEvent(), ended()]
    expect(taskStage(blockedTask('other'), null, { events })).toBe('stalled')
    expect(taskStage(blockedTask('other'), null, { events: [...events, reply(4)] })).toBe('queued')
  })

  test('排队、订阅空闲与工作中的边界以派工事实区分', () => {
    const cases: [TaskView, LedgerEvent[], boolean, TaskStage][] = [
      [task(), [], false, 'queued'],
      [task(), [], true, 'queued'],
      [task(), [started(), ended()], false, 'queued'],
      [task(), [started(), ended()], true, 'idle'],
      [task({ status: 'queued' }), [started(), ended()], true, 'queued'],
      [task({ status: 'queued' }), [started()], true, 'queued'],
      [task(), [started()], true, 'working'],
      [task({ status: 'verifying' }), [started()], false, 'working'],
      [task(), [started(), ended(), started(4, 2)], true, 'working'],
    ]
    for (const [view, events, hasActiveSubscription, expected] of cases) {
      expect(taskStage(view, null, { events, hasActiveSubscription })).toBe(expected)
    }
  })

  test('已请求取消：不再等人，也不等 supervisor 或审阅，按派工派生为工作中或排队', () => {
    const cancelling = (reason: NonNullable<TaskView['blocked']>['reason']) => ({
      ...blockedTask(reason),
      cancel_requested: true,
    })
    const active = [started(), blockedEvent(2, 'question')]
    const endedEvents = [...active, ended()]
    for (const reason of ['awaiting_approval', 'question', 'other'] as const) {
      expect(taskStage(cancelling(reason), null, { events: active })).toBe('working')
      expect(taskStage(cancelling(reason), null, { events: endedEvents })).toBe('queued')
      expect(taskStage(cancelling(reason), delegation, { events: active })).toBe('working')
    }
    const review = [started(), ready()]
    expect(taskStage(task({ cancel_requested: true }), null, { events: review })).toBe('working')
    expect(
      taskStage(task({ cancel_requested: true }), null, { events: [...review, ended()] }),
    ).toBe('queued')
    // 排序上不再与等人的任务并列。
    expect(isWaitingHumanStage(taskStage(cancelling('question'), null, { events: active }))).toBe(
      false,
    )
  })

  test.each([
    ['question', 'waiting-human-answer'],
    ['awaiting_approval', 'waiting-human-approval'],
  ] as const)('%s 已有用户回复（待送达或已取走）时不再等人', (reason, waiting) => {
    const events = [started(), blockedEvent(2, reason)]
    expect(taskStage(blockedTask(reason), null, { events })).toBe(waiting)
    const replied = [...events, reply(3)]
    expect(taskStage(blockedTask(reason), null, { events: replied })).toBe('working')
    const fetched = [
      ...replied,
      event(4, 'task.reply_fetched', { reply_id: 'r-3', lease_id: 'l1' }),
    ]
    expect(taskStage(blockedTask(reason), null, { events: fetched })).toBe('working')
    // 派工已结束（回复随重排送达）时排队。
    expect(taskStage(blockedTask(reason), null, { events: [...replied, ended(5)] })).toBe('queued')
    // 回复早于当前这次卡住时不算。
    expect(
      taskStage(blockedTask(reason), null, {
        events: [started(), reply(2), blockedEvent(3, reason)],
      }),
    ).toBe(waiting)
  })

  test('supervisor 委托下已代回复但尚未解除阻塞时仍是等 supervisor', () => {
    const events = [
      started(),
      blockedEvent(2, 'awaiting_approval'),
      reply(4, 'supervisor', 'supervisor'),
    ]
    expect(taskStage(blockedTask('awaiting_approval'), delegation, { events })).toBe(
      'waiting-supervisor',
    )
  })
})
