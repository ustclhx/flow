import { afterEach, describe, expect, test } from 'bun:test'
import { taskView } from '@flow/core'
import {
  completionDrafts,
  createTaskService,
  type EventInput,
  type LedgerStore,
} from '../src/index.ts'
import {
  anyRole,
  contractInput,
  drafts,
  must,
  startTask,
  sys,
  tempLedger,
  WS,
} from './ledger-helpers.ts'

/**
 * add-m1-supervisor 1.1 / 1.6 的账本部分：origin 写入通道、代回复与唤醒事件的写入校验、
 * 分支上报、卡住的新字段与投影重建。
 */

let cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups) c()
  cleanups = []
})

async function setup() {
  const l = await tempLedger()
  cleanups.push(l.cleanup)
  let n = 0
  const tasks = createTaskService({
    ledger: l.store,
    workspaceExists: (ref) => ref === WS,
    roles: anyRole,
    newTaskId: () => `t-sup-${++n}`,
  })
  return { store: l.store, tasks }
}

const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? 'ok' : r.error?.code)
const node = { actor: 'node:n1' }

const blockedQuestion = (store: LedgerStore, id: string, extra: Record<string, unknown> = {}) =>
  must(
    store.append(
      {
        ...drafts(id)['task.blocked'],
        payload: { reason: 'question', message: '用哪个方案？', lease_held: true, ...extra },
      } as EventInput,
      node,
    ),
  )

describe('任务 origin（D2 的写入通道）', () => {
  test('中枢传入的 origin 写入投影；缺省为 null；重建后不变', async () => {
    const { store, tasks } = await setup()
    const a = must(
      await tasks.createTask(contractInput(), { actor: 'hub', origin: 'instruction' }),
    ).task
    const b = must(await tasks.createTask(contractInput(), { actor: 'user' })).task
    expect(a.origin).toBe('instruction')
    expect(b.origin).toBeNull()
    expect(taskView.parse(a)).toEqual(a as never)
    const created = store.taskEvents(a.id)[0]
    expect(created).toMatchObject({ type: 'task.created', payload: { origin: 'instruction' } })
    expect(store.taskEvents(b.id)[0]?.payload).not.toHaveProperty('origin')
    const before = store.snapshot({ includeSoft: false })
    must(store.rebuild())
    expect(store.snapshot({ includeSoft: false })).toEqual(before)
    expect(store.getTask(a.id)?.origin).toBe('instruction')
  })

  test('合同里夹带 origin 被拒（不取自调用方字段）', async () => {
    const { tasks } = await setup()
    const r = await tasks.createTask(
      { ...contractInput(), origin: 'instruction' },
      { actor: 'user' },
    )
    expect(code(r)).toBe('invalid_arguments')
  })
})

describe('task.branch_reported', () => {
  test('只接受持有活动租约的节点，每个任务一次、不可更改', async () => {
    const { store, tasks } = await setup()
    const t = must(await tasks.createTask(contractInput(), { actor: 'user' })).task
    const report = (branch: string, actor = node) =>
      store.append(
        { task_id: t.id, workspace: WS, type: 'task.branch_reported', payload: { branch } },
        actor,
      )
    // 排队中：状态机不允许
    expect(code(report('ustclhx/t-1'))).toBe('invalid_transition')
    startTask(store, t.id)
    expect(code(report('ustclhx/t-1', { actor: 'node:other' }))).toBe('invalid_lease_token')
    expect(code(report('ustclhx/t-1', { actor: 'user' }))).toBe('invalid_lease_token')
    must(report('ustclhx/t-1'))
    expect(store.getTask(t.id)?.branch).toBe('ustclhx/t-1')
    expect(code(report('ustclhx/t-2'))).toBe('invalid_transition')
    expect(store.getTask(t.id)?.branch).toBe('ustclhx/t-1')
    const before = store.snapshot({ includeSoft: false })
    must(store.rebuild())
    expect(store.snapshot({ includeSoft: false })).toEqual(before)
  })
})

describe('task.blocked 的代回复字段', () => {
  test('decision_id、diff_stat、no_delegate 进入任务视图；diff_stat 入账前脱敏', async () => {
    const { store, tasks } = await setup()
    const t = must(await tasks.createTask(contractInput(), { actor: 'user' })).task
    startTask(store, t.id)
    const fake = `ghp_${'Ab9'.repeat(12)}`
    blockedQuestion(store, t.id, {
      reason: 'awaiting_approval',
      decision_id: 7,
      diff_stat: `README.md | 2 ++\n${fake}`,
      no_delegate: true,
    })
    const view = store.getTask(t.id)
    expect(view?.blocked).toMatchObject({ decision_id: 7, no_delegate: true, lease_held: true })
    expect(view?.blocked?.diff_stat).toContain('README.md | 2 ++')
    expect(view?.blocked?.diff_stat).not.toContain(fake)
    expect(taskView.parse(view)).toEqual(view as never)
  })

  test('旧节点不带新字段：视图中没有这些键', async () => {
    const { store, tasks } = await setup()
    const t = must(await tasks.createTask(contractInput(), { actor: 'user' })).task
    startTask(store, t.id)
    blockedQuestion(store, t.id)
    const blocked = store.getTask(t.id)?.blocked
    expect(blocked).not.toHaveProperty('decision_id')
    expect(blocked).not.toHaveProperty('diff_stat')
    expect(blocked).not.toHaveProperty('no_delegate')
  })
})

describe('task.reply_delegated / task.reply_escalated', () => {
  test('block_seq 必须是当前这次卡住，kind 与卡住原因一致', async () => {
    const { store, tasks } = await setup()
    const t = must(await tasks.createTask(contractInput(), { actor: 'user' })).task
    const delegate = (block_seq: number, kind = 'question', task_id = t.id) =>
      store.append(
        {
          task_id: t.id,
          workspace: WS,
          type: 'task.reply_delegated',
          payload: { task_id, block_seq, kind, deadline: '2026-10-24T01:00:00.000Z' },
        } as EventInput,
        sys,
      )
    startTask(store, t.id)
    const blocked = blockedQuestion(store, t.id)
    expect(code(delegate(blocked.seq - 1))).toBe('invalid_event')
    expect(code(delegate(blocked.seq, 'awaiting_approval'))).toBe('invalid_event')
    expect(code(delegate(blocked.seq, 'question', 't-other'))).toBe('invalid_event')
    must(delegate(blocked.seq))
    must(
      store.append(
        {
          task_id: t.id,
          workspace: WS,
          type: 'task.reply_escalated',
          payload: { reason: 'timeout', block_seq: blocked.seq },
        },
        sys,
      ),
    )
    // 离开卡住之后不能再委托或转交
    must(store.append(drafts(t.id)['task.unblocked'], node))
    expect(code(delegate(blocked.seq))).toBe('invalid_transition')
  })
})

describe('supervisor.wake_started', () => {
  test('与信封一致、任务排队中；同一任务或同一 workspace 的同一代只记一次', async () => {
    const { store, tasks } = await setup()
    const a = must(await tasks.createTask(contractInput(), { actor: 'hub' })).task
    const b = must(await tasks.createTask(contractInput(), { actor: 'hub' })).task
    const wake = (task_id: string, generation: number, payloadTask = task_id) =>
      store.append(
        {
          task_id,
          workspace: WS,
          type: 'supervisor.wake_started',
          payload: {
            task_id: payloadTask,
            workspace: WS,
            origin: 'instruction',
            events: [1],
            generation,
          },
        },
        sys,
      )
    expect(code(wake(a.id, 1, b.id))).toBe('invalid_event')
    must(wake(a.id, 1))
    expect(code(wake(a.id, 2))).toBe('duplicate_wake')
    expect(code(wake(b.id, 1))).toBe('duplicate_wake')
    must(wake(b.id, 2))
    startTask(store, a.id)
    const c = must(await tasks.createTask(contractInput(), { actor: 'hub' })).task
    startTask(store, c.id)
    expect(code(wake(c.id, 3))).toBe('invalid_transition')
  })
})

describe('非任务的 supervisor 事件', () => {
  test('提问回答、放行、提案、回看与合并批准可写入，不影响任务投影', async () => {
    const { store } = await setup()
    const before = store.snapshot({ includeSoft: false })
    const ws = { workspace: WS }
    const events: EventInput[] = [
      { ...ws, type: 'supervisor.answered', payload: { item_id: 'sup.1', text: 'B', via: 'cli' } },
      { ...ws, type: 'supervisor.release', payload: { queue: 'instruction' } },
      {
        ...ws,
        type: 'task_proposal.created',
        payload: {
          proposal_id: 'tp-1',
          wake_task_id: 't-w',
          draft: { ...contractInput(), timeout_s: 3600, requires: [] },
        },
      },
      { ...ws, type: 'task_proposal.rejected', payload: { proposal_id: 'tp-1' } },
      {
        type: 'decision.review_due',
        payload: { path: 'decisions/2026-10-26-x.md', review_date: '2026-10-26' },
      },
      {
        ...ws,
        type: 'merge_request.approved',
        payload: { pr: 'https://github.com/o/r/pull/1', review_task: 't-r', approved_by: 'user' },
      },
    ]
    for (const e of events) must(store.append(e, sys))
    expect(store.snapshot({ includeSoft: false })).toEqual(before)
    must(store.rebuild())
    expect(store.snapshot({ includeSoft: false })).toEqual(before)
  })
})

describe('节点提交 blocked 时带上代回复字段', () => {
  test('completionDrafts 原样带入 decision_id、diff_stat、no_delegate', async () => {
    const { store, tasks } = await setup()
    const t = must(await tasks.createTask(contractInput(), { actor: 'user' })).task
    startTask(store, t.id)
    const task = store.getTask(t.id)
    const lease = store.activeLease(t.id)
    if (!task || !lease) throw new Error('缺少任务或租约')
    const [blocked] = completionDrafts(task, lease, {
      lease_token: 'x'.repeat(16),
      outcome: 'blocked',
      blocked_reason: 'awaiting_approval',
      message: '等批准',
      decision_id: 4,
      diff_stat: 'README.md | 2 ++',
      no_delegate: true,
    })
    expect(blocked?.payload).toMatchObject({
      decision_id: 4,
      diff_stat: 'README.md | 2 ++',
      no_delegate: true,
      lease_held: false,
    })
    const [legacy] = completionDrafts(task, lease, {
      lease_token: 'x'.repeat(16),
      outcome: 'blocked',
      blocked_reason: 'question',
      message: '?',
    })
    expect(legacy?.payload).not.toHaveProperty('decision_id')
  })
})
