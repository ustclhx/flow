import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, policyDecisionSchema, taskView } from '@flow/core'
import {
  completionDrafts,
  createTaskService,
  type EventInput,
  LEDGER_DDL,
  type LedgerStore,
  openLedger,
} from '../src/index.ts'
import {
  anyRole,
  contract,
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
 * 分支上报、卡住的新字段、身份白名单与投影重建。
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
  const newTask = async (over: Parameters<typeof contractInput>[0] = {}) =>
    must(await tasks.createTask(contractInput(over), { actor: 'user' })).task
  return { store: l.store, tasks, newTask }
}

const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? 'ok' : r.error?.code)
const message = (r: { ok: boolean; error?: { message: string } }) =>
  r.ok ? '' : (r.error?.message ?? '')
const node = { actor: 'node:n1' }
const hub = { actor: 'hub' }
const DEADLINE = '2026-10-24T01:00:00.000Z'

/** 写一次 task.blocked（缺省为持有租约的 question）。 */
const block = (store: LedgerStore, id: string, extra: Record<string, unknown> = {}) =>
  must(
    store.append(
      {
        ...drafts(id)['task.blocked'],
        payload: { reason: 'question', message: '用哪个方案？', lease_held: true, ...extra },
      } as EventInput,
      node,
    ),
  )

/** 写一条本任务的策略判定（level 缺省 draft-approve）。 */
const decide = (store: LedgerStore, id: string, level = 'draft-approve') =>
  must(
    store.append(
      {
        task_id: id,
        workspace: WS,
        type: 'policy.decided',
        payload: {
          task_id: id,
          request: { tool: 'Bash', actions: ['git.push'], command: 'git push origin a' },
          level,
          matched_rules: [],
          actions: [],
        },
      } as EventInput,
      { actor: 'policy' },
    ),
  )

const delegate = (store: LedgerStore, id: string, payload: Record<string, unknown>, actor = hub) =>
  store.append(
    {
      task_id: id,
      workspace: WS,
      type: 'task.reply_delegated',
      payload: { task_id: id, kind: 'question', deadline: DEADLINE, ...payload },
    } as EventInput,
    actor,
  )

const escalate = (store: LedgerStore, id: string, block_seq: number, actor = hub) =>
  store.append(
    {
      task_id: id,
      workspace: WS,
      type: 'task.reply_escalated',
      payload: { reason: 'timeout', block_seq },
    },
    actor,
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
    expect(store.taskEvents(a.id)[0]).toMatchObject({
      type: 'task.created',
      payload: { origin: 'instruction' },
    })
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

  test('inputs.wake 只能由 hub 携带', async () => {
    const { tasks } = await setup()
    const wake = { origin: 'instruction', generation: 1, events: [] }
    const input = contractInput({ inputs: { wake } as never })
    for (const actor of ['user', 'reviewer']) {
      const r = await tasks.createTask(input, { actor })
      expect(code(r)).toBe('invalid_arguments')
      expect(message(r)).toContain('inputs.wake')
    }
    expect(code(await tasks.createTask(input, { actor: 'hub' }))).toBe('ok')
  })
})

describe('task.branch_reported', () => {
  test('只接受 codex-orca 任务、持有活动租约的节点，每个任务一次、不可更改', async () => {
    const { store, newTask } = await setup()
    const t = await newTask({ executor: 'codex-orca' })
    const report = (id: string, branch: string, actor = node) =>
      store.append(
        { task_id: id, workspace: WS, type: 'task.branch_reported', payload: { branch } },
        actor,
      )
    // 排队中：状态机不允许
    expect(code(report(t.id, 'ustclhx/t-1'))).toBe('invalid_transition')
    startTask(store, t.id)
    expect(code(report(t.id, 'ustclhx/t-1', { actor: 'node:other' }))).toBe('invalid_lease_token')
    expect(code(report(t.id, 'ustclhx/t-1', { actor: 'user' }))).toBe('invalid_lease_token')
    must(report(t.id, 'ustclhx/t-1'))
    expect(store.getTask(t.id)?.branch).toBe('ustclhx/t-1')
    expect(code(report(t.id, 'ustclhx/t-2'))).toBe('invalid_transition')
    expect(store.getTask(t.id)?.branch).toBe('ustclhx/t-1')
    const before = store.snapshot({ includeSoft: false })
    must(store.rebuild())
    expect(store.snapshot({ includeSoft: false })).toEqual(before)

    // 其他执行器的任务不能上报
    const f = await newTask({ executor: 'fake' })
    startTask(store, f.id)
    const r = report(f.id, 'ustclhx/t-3')
    expect(code(r)).toBe('invalid_event')
    expect(message(r)).toContain('codex-orca')
  })
})

describe('task.blocked 的代回复字段', () => {
  test('decision_id、diff_stat、no_delegate 进入任务视图；diff_stat 入账前脱敏', async () => {
    const { store, newTask } = await setup()
    const t = await newTask()
    startTask(store, t.id)
    const d = decide(store, t.id)
    const fake = `ghp_${'Ab9'.repeat(12)}`
    block(store, t.id, {
      reason: 'awaiting_approval',
      decision_id: d.seq,
      diff_stat: `README.md | 2 ++\n${fake}`,
      no_delegate: true,
    })
    const view = store.getTask(t.id)
    expect(view?.blocked).toMatchObject({ decision_id: d.seq, no_delegate: true, lease_held: true })
    expect(view?.blocked?.diff_stat).toContain('README.md | 2 ++')
    expect(view?.blocked?.diff_stat).not.toContain(fake)
    expect(taskView.parse(view)).toEqual(view as never)
  })

  test('旧节点不带新字段：视图中没有这些键', async () => {
    const { store, newTask } = await setup()
    const t = await newTask()
    startTask(store, t.id)
    block(store, t.id)
    const blocked = store.getTask(t.id)?.blocked
    expect(blocked).not.toHaveProperty('decision_id')
    expect(blocked).not.toHaveProperty('diff_stat')
    expect(blocked).not.toHaveProperty('no_delegate')
  })

  test('节点提交 blocked：原样带入字段，diff_stat 截到 2000', async () => {
    const { store, newTask } = await setup()
    const t = await newTask()
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
      diff_stat: 'y'.repeat(8192),
      no_delegate: true,
    })
    const payload = blocked?.payload as { diff_stat: string }
    expect(blocked?.payload).toMatchObject({ decision_id: 4, no_delegate: true, lease_held: false })
    expect(payload.diff_stat).toHaveLength(2000)
    expect(payload.diff_stat.endsWith('…')).toBe(true)
    must(store.append(blocked as EventInput, node))
    const [legacy] = completionDrafts(task, lease, {
      lease_token: 'x'.repeat(16),
      outcome: 'blocked',
      blocked_reason: 'question',
      message: '?',
    })
    expect(legacy?.payload).not.toHaveProperty('decision_id')
    expect(legacy?.payload).not.toHaveProperty('diff_stat')
  })
})

describe('task.reply_delegated 的不变量', () => {
  test('question：block_seq 是当前卡住、kind 一致；离开卡住后不能委托', async () => {
    const { store, newTask } = await setup()
    const t = await newTask()
    startTask(store, t.id)
    const b = block(store, t.id)
    expect(code(delegate(store, t.id, { block_seq: b.seq - 1 }))).toBe('invalid_event')
    expect(
      code(delegate(store, t.id, { block_seq: b.seq, kind: 'awaiting_approval', decision_id: 1 })),
    ).toBe('invalid_event')
    expect(code(delegate(store, t.id, { block_seq: b.seq, task_id: 't-other' }))).toBe(
      'invalid_event',
    )
    must(delegate(store, t.id, { block_seq: b.seq }))
    must(store.append(drafts(t.id)['task.unblocked'], node))
    expect(code(delegate(store, t.id, { block_seq: b.seq }))).toBe('invalid_transition')
  })

  test('(b) 卡住带 no_delegate 时拒绝', async () => {
    const { store, newTask } = await setup()
    const t = await newTask()
    startTask(store, t.id)
    const b = block(store, t.id, { no_delegate: true })
    const r = delegate(store, t.id, { block_seq: b.seq })
    expect(code(r)).toBe('not_delegable')
    expect(message(r)).toContain('no_delegate')
  })

  test('(c) 卡住带 prior_reason 时拒绝', async () => {
    const { store, newTask } = await setup()
    const t = await newTask()
    startTask(store, t.id)
    const b = block(store, t.id, { prior_reason: 'question', lease_held: false })
    const r = delegate(store, t.id, { block_seq: b.seq })
    expect(code(r)).toBe('not_delegable')
    expect(message(r)).toContain('prior_reason')
  })

  test('(d) 同一个 block_seq 不能重复委托', async () => {
    const { store, newTask } = await setup()
    const t = await newTask()
    startTask(store, t.id)
    const b = block(store, t.id)
    must(delegate(store, t.id, { block_seq: b.seq }))
    expect(code(delegate(store, t.id, { block_seq: b.seq }))).toBe('duplicate_delegation')
  })

  test('(e) actor 必须是 hub', async () => {
    const { store, newTask } = await setup()
    const t = await newTask()
    startTask(store, t.id)
    const b = block(store, t.id)
    for (const actor of ['user', 'supervisor', 'node:n1']) {
      expect(code(delegate(store, t.id, { block_seq: b.seq }, { actor }))).toBe('actor_mismatch')
    }
  })

  describe('(a) awaiting_approval 必须绑定本次卡住的 supervisor 判定', () => {
    const approval = async () => {
      const ctx = await setup()
      const t = await ctx.newTask()
      startTask(ctx.store, t.id)
      return { ...ctx, id: t.id }
    }

    test('缺少 decision_id', async () => {
      const { store, id } = await approval()
      const d = decide(store, id)
      const b = block(store, id, { reason: 'awaiting_approval', decision_id: d.seq })
      const r = delegate(store, id, { block_seq: b.seq, kind: 'awaiting_approval' })
      expect(code(r)).toBe('invalid_event')
      expect(message(r)).toContain('必须带 decision_id')
    })

    test('decision_id 与卡住上报的不一致', async () => {
      const { store, id } = await approval()
      const d1 = decide(store, id)
      const d2 = decide(store, id)
      const b = block(store, id, { reason: 'awaiting_approval', decision_id: d2.seq })
      const r = delegate(store, id, {
        block_seq: b.seq,
        kind: 'awaiting_approval',
        decision_id: d1.seq,
      })
      expect(code(r)).toBe('invalid_event')
      expect(message(r)).toContain('与卡住上报的判定不一致')
    })

    test('decision_id 不是本任务的策略判定', async () => {
      const { store, id, newTask } = await approval()
      const other = await newTask()
      const d = decide(store, other.id)
      const b = block(store, id, { reason: 'awaiting_approval', decision_id: d.seq })
      const r = delegate(store, id, {
        block_seq: b.seq,
        kind: 'awaiting_approval',
        decision_id: d.seq,
      })
      expect(code(r)).toBe('invalid_event')
      expect(message(r)).toContain('不是本任务的策略判定')
    })

    test('判定早于上一次离开 blocked', async () => {
      const { store, id } = await approval()
      const d = decide(store, id)
      block(store, id, { reason: 'awaiting_approval', decision_id: d.seq })
      must(store.append(drafts(id)['task.unblocked'], node))
      const b = block(store, id, { reason: 'awaiting_approval', decision_id: d.seq })
      const r = delegate(store, id, {
        block_seq: b.seq,
        kind: 'awaiting_approval',
        decision_id: d.seq,
      })
      expect(code(r)).toBe('invalid_event')
      expect(message(r)).toContain('早于上一次离开 blocked')
    })

    test('卡住时没有持有租约（lease_held=false）', async () => {
      const { store, id } = await approval()
      const d = decide(store, id)
      const b = block(store, id, {
        reason: 'awaiting_approval',
        decision_id: d.seq,
        lease_held: false,
      })
      const r = delegate(store, id, {
        block_seq: b.seq,
        kind: 'awaiting_approval',
        decision_id: d.seq,
      })
      expect(code(r)).toBe('not_delegable')
      expect(message(r)).toContain('lease_held')
    })

    test('判定档位不是 supervisor', async () => {
      const { store, id } = await approval()
      const d = decide(store, id, 'draft-approve')
      const b = block(store, id, { reason: 'awaiting_approval', decision_id: d.seq })
      const r = delegate(store, id, {
        block_seq: b.seq,
        kind: 'awaiting_approval',
        decision_id: d.seq,
      })
      expect(code(r)).toBe('invalid_event')
      expect(message(r)).toContain('不是 supervisor')
    })

    // supervisor 档位由策略引擎组（G2）加入档位枚举；合入后此用例自动启用。
    const supervisorLevel = policyDecisionSchema.shape.level.safeParse('supervisor').success
    test.skipIf(!supervisorLevel)('supervisor 档位、绑定本次卡住：委托成功', async () => {
      const { store, id } = await approval()
      const d = decide(store, id, 'supervisor')
      const b = block(store, id, { reason: 'awaiting_approval', decision_id: d.seq })
      must(delegate(store, id, { block_seq: b.seq, kind: 'awaiting_approval', decision_id: d.seq }))
    })
  })
})

describe('task.reply_escalated', () => {
  test('必须有当前这次卡住上未结束的委托；actor 必须是 hub', async () => {
    const { store, newTask } = await setup()
    const t = await newTask()
    startTask(store, t.id)
    const b = block(store, t.id)
    expect(code(escalate(store, t.id, b.seq))).toBe('not_delegated')
    must(delegate(store, t.id, { block_seq: b.seq }))
    expect(code(escalate(store, t.id, b.seq - 1))).toBe('invalid_event')
    expect(code(escalate(store, t.id, b.seq, { actor: 'user' }))).toBe('actor_mismatch')
    must(escalate(store, t.id, b.seq))
    expect(code(escalate(store, t.id, b.seq))).toBe('not_delegated')
  })
})

describe('supervisor.wake_started', () => {
  const wakeDraft = (id: string, generation: number, payloadTask = id): EventInput => ({
    task_id: id,
    workspace: WS,
    type: 'supervisor.wake_started',
    payload: {
      task_id: payloadTask,
      workspace: WS,
      origin: 'instruction',
      events: [1],
      generation,
    },
  })
  const created = (id: string): EventInput => ({
    task_id: id,
    workspace: WS,
    type: 'task.created',
    payload: { contract: contract({ role: 'supervisor' }) },
  })

  test('与 task.created 同一次 appendMany 写入；actor 必须是 hub；与信封一致', async () => {
    const { store } = await setup()
    expect(code(store.appendMany([created('w1'), wakeDraft('w1', 1)], { actor: 'user' }))).toBe(
      'actor_mismatch',
    )
    expect(store.getTask('w1')).toBeNull()
    expect(code(store.appendMany([created('w1'), wakeDraft('w1', 1, 'w2')], sys))).toBe(
      'invalid_event',
    )
    must(store.appendMany([created('w1'), wakeDraft('w1', 1)], sys))
    expect(code(store.append(wakeDraft('w1', 2), sys))).toBe('duplicate_wake')
    // 已开始执行的任务不能再记为唤醒
    must(store.append(created('w9'), sys))
    startTask(store, 'w9')
    expect(code(store.append(wakeDraft('w9', 5), sys))).toBe('invalid_transition')
  })

  test('同一 workspace 的 generation 严格递增', async () => {
    const { store } = await setup()
    must(store.appendMany([created('w1'), wakeDraft('w1', 1)], sys))
    expect(code(store.appendMany([created('w2'), wakeDraft('w2', 1)], sys))).toBe('duplicate_wake')
    must(store.appendMany([created('w3'), wakeDraft('w3', 3)], sys))
    const r = store.appendMany([created('w4'), wakeDraft('w4', 2)], sys)
    expect(code(r)).toBe('duplicate_wake')
    expect(message(r)).toContain('严格递增')
  })
})

describe('新事件的身份白名单', () => {
  const ws = { workspace: WS }
  const userOnly: EventInput[] = [
    { ...ws, type: 'user.instruction', payload: { text: '看看', via: 'cli' } },
    { ...ws, type: 'supervisor.release', payload: { queue: 'instruction' } },
    {
      ...ws,
      type: 'task_proposal.accepted',
      payload: { proposal_id: 'tp-1', task_id: 't-x' },
    },
    { ...ws, type: 'task_proposal.rejected', payload: { proposal_id: 'tp-1' } },
    {
      ...ws,
      type: 'merge_request.approved',
      payload: { pr: 'https://github.com/o/r/pull/1', review_task: 't-r', approved_by: 'user' },
    },
  ]
  const hubOnly: EventInput[] = [
    {
      ...ws,
      type: 'task_proposal.created',
      payload: {
        proposal_id: 'tp-1',
        wake_task_id: 't-w',
        draft: contract(),
      },
    },
    {
      type: 'decision.review_due',
      payload: { path: 'decisions/2026-10-26-x.md', review_date: '2026-10-26' },
    },
  ]

  test.each(userOnly.map((e) => [e.type, e] as const))('%s 只接受 user', async (_t, e) => {
    const { store } = await setup()
    for (const actor of ['hub', 'supervisor', 'node:n1']) {
      expect(code(store.append(e, { actor }))).toBe('actor_mismatch')
    }
    must(store.append(e, { actor: 'user' }))
  })

  test.each(hubOnly.map((e) => [e.type, e] as const))('%s 只接受 hub', async (_t, e) => {
    const { store } = await setup()
    for (const actor of ['user', 'supervisor']) {
      expect(code(store.append(e, { actor }))).toBe('actor_mismatch')
    }
    must(store.append(e, sys))
  })

  test('supervisor.answered 接受 hub 或 user（回复路由的实际调用方）', async () => {
    const { store } = await setup()
    const e: EventInput = {
      ...ws,
      type: 'supervisor.answered',
      payload: { item_id: 'sup.1', text: 'B', via: 'cli' },
    }
    must(store.append(e, { actor: 'user' }))
    must(store.append(e, sys))
    expect(code(store.append(e, { actor: 'supervisor' }))).toBe('actor_mismatch')
  })

  test('这些事件不影响任务投影，重建一致', async () => {
    const { store } = await setup()
    const before = store.snapshot({ includeSoft: false })
    for (const e of userOnly) must(store.append(e, { actor: 'user' }))
    for (const e of hubOnly) must(store.append(e, sys))
    expect(store.snapshot({ includeSoft: false })).toEqual(before)
    must(store.rebuild())
    expect(store.snapshot({ includeSoft: false })).toEqual(before)
  })
})

describe('scrub', () => {
  test('任务提案的目标按自由文本脱敏', async () => {
    const { store } = await setup()
    const fake = `ghp_${'Ab9'.repeat(12)}`
    const created = must(
      store.append(
        {
          workspace: WS,
          type: 'task_proposal.created',
          payload: {
            proposal_id: 'tp-9',
            wake_task_id: 't-w',
            draft: contract({ goal: `用 ${fake} 推送` }),
          },
        },
        sys,
      ),
    )
    expect(JSON.stringify(created.payload)).not.toContain(fake)
    const accepted = must(
      store.append(
        {
          workspace: WS,
          type: 'task_proposal.accepted',
          payload: { proposal_id: 'tp-9', task_id: 't-x', goal: `改成 ${fake}` },
        },
        { actor: 'user' },
      ),
    )
    expect(JSON.stringify(accepted.payload)).not.toContain(fake)
  })
})

describe('旧账本迁移：origin、branch 列', () => {
  test('有 resume_json 但缺 origin、branch 的旧库打开后补列，可写入 origin 与分支', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-ledger-migrate-sup-'))
    try {
      const path = join(dir, 'flow.db')
      const db = await openDatabase(path)
      db.exec(LEDGER_DDL.replace(',\n  origin           TEXT,\n  branch           TEXT\n', '\n'))
      const cols = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]
      expect(cols.map((c) => c.name)).toContain('resume_json')
      expect(cols.map((c) => c.name)).not.toContain('origin')
      expect(cols.map((c) => c.name)).not.toContain('branch')
      db.close()
      const store = await openLedger(path)
      try {
        must(
          store.append(
            {
              task_id: 't-old',
              workspace: WS,
              type: 'task.created',
              payload: { contract: contract({ executor: 'codex-orca' }), origin: 'autonomous' },
            },
            sys,
          ),
        )
        startTask(store, 't-old')
        must(
          store.append(
            {
              task_id: 't-old',
              workspace: WS,
              type: 'task.branch_reported',
              payload: { branch: 'ustclhx/t-old' },
            },
            node,
          ),
        )
        expect(store.getTask('t-old')).toMatchObject({
          origin: 'autonomous',
          branch: 'ustclhx/t-old',
        })
      } finally {
        store.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
