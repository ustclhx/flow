import { afterEach, expect, test } from 'bun:test'
import {
  hasActivePrSubscription,
  type TaskView,
  taskShowOp,
  taskUnsubscribeOp,
} from '@raindown/core'
import { readTaskStage } from '../src/ledger/task-stage.ts'
import { createTaskService } from '../src/ledger/tasks.ts'
import { createPrSubscriptionReactor } from '../src/pr/subscriptions.ts'
import { anyRole, contract, must, WS } from './ledger-helpers.ts'
import { PR, prSetup } from './pr-fixtures.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})
async function setup(o: Parameters<typeof prSetup>[0] = {}) {
  const s = await prSetup(o)
  cleanups.push(s.cleanup)
  const tasks = createTaskService({
    ledger: s.store,
    workspaceExists: () => true,
    roles: anyRole,
  })
  return { ...s, tasks }
}

test('开出 PR 即订阅：task show 显示这条订阅', async () => {
  const s = await setup()
  s.reactor.start()
  s.branch()
  s.reportPr()
  await s.reactor.idle()
  expect(s.store.prSubscriptions('dev')).toMatchObject([
    { task_id: 'dev', pr: PR, role: 'author', active: true, ended_at: null, reason: null },
  ])
  const shown = must(s.tasks.getTask('dev'))
  expect(shown.subscriptions).toHaveLength(1)
  const text = taskShowOp.human?.(shown as never) ?? ''
  expect(text).toContain(`- ${PR}（开出`)
  expect(text).toContain('有效')
})

test('github.watch 缺省时不写任何订阅事件（行为与之前一致）', async () => {
  const s = await setup({ github: undefined })
  s.reactor.start()
  s.branch()
  s.reportPr()
  await s.reactor.idle()
  expect(s.store.prSubscriptions('dev')).toEqual([])
  expect(s.store.taskEvents('dev').some((e) => e.type.startsWith('pr.'))).toBe(false)
  expect(must(s.tasks.getTask('dev')).subscriptions).toEqual([])
})

test('没有上报任务分支的任务不订阅它报告的 PR', async () => {
  const s = await setup()
  s.reactor.start()
  s.reportPr()
  await s.reactor.idle()
  expect(s.store.prSubscriptions('dev')).toEqual([])
})

test('分支在 PR 之后才上报时补上订阅；结果里的 PR 不重复订阅', async () => {
  const s = await setup()
  s.reactor.start()
  s.reportPr()
  s.branch()
  await s.reactor.idle()
  expect(s.store.prSubscriptions('dev')).toHaveLength(1)
  must(
    s.store.append(
      {
        type: 'task.done',
        task_id: 'dev',
        workspace: WS,
        payload: {
          result: {
            summary: '完成',
            executor: 'codex-orca',
            node_id: 'n1',
            artifacts: [{ kind: 'pr', ref: `${PR.replace('acme', 'ACME')}` }],
          },
        },
      },
      { actor: 'node:n1' },
    ),
  )
  await s.reactor.idle()
  // 规范化后是同一个 PR；订阅在任务结束后保留。
  expect(s.store.prSubscriptions('dev')).toMatchObject([{ pr: PR, active: true }])
  expect(s.store.getTask('dev')?.status).toBe('done')
})

test('审查任务创建时订阅它审查的 PR', async () => {
  const s = await setup()
  s.reactor.start()
  must(
    s.store.append(
      {
        type: 'task.created',
        task_id: 'rev',
        workspace: WS,
        payload: {
          contract: contract({
            role: 'pr-reviewer',
            executor: 'claude-sdk',
            inputs: { review: { pr: PR } },
          }),
        },
      },
      { actor: 'hub' },
    ),
  )
  await s.reactor.idle()
  expect(s.store.prSubscriptions('rev')).toMatchObject([{ pr: PR, role: 'reviewer', active: true }])
})

test('启动时补订近期任务已记录的 PR（例如刚打开 github.watch）', async () => {
  const s = await setup()
  s.branch()
  s.reportPr()
  const late = createPrSubscriptionReactor({
    ledger: s.store,
    workspaces: async () => s.workspace,
  })
  late.start(s.clock.now())
  await late.idle()
  await late.stop()
  expect(s.store.prSubscriptions('dev')).toMatchObject([{ pr: PR, active: true }])
})

test('用户取消订阅：只限用户；取消后不会被自动重新订阅', async () => {
  const s = await setup()
  s.reactor.start()
  s.branch()
  s.reportPr()
  await s.reactor.idle()
  expect(s.tasks.unsubscribeTask('dev', { pr: PR }, { actor: 'supervisor' })).toMatchObject({
    ok: false,
    error: { code: 'user_only' },
  })
  const r = must(s.tasks.unsubscribeTask('dev', { pr: PR }, { actor: 'user' }))
  expect(r).toMatchObject({ changed: true, subscription: { active: false, reason: 'user' } })
  expect(taskUnsubscribeOp.human?.(r)).toContain('已取消订阅')
  // 再取消一次：幂等。
  expect(must(s.tasks.unsubscribeTask('dev', { pr: PR }, { actor: 'user' })).changed).toBe(false)
  s.reportPr()
  await s.reactor.idle()
  expect(s.store.prSubscriptions('dev')).toMatchObject([{ active: false }])
  expect(
    s.tasks.unsubscribeTask(
      'dev',
      { pr: 'https://github.com/acme/demo/pull/99' },
      { actor: 'user' },
    ),
  ).toMatchObject({ ok: false, error: { code: 'not_subscribed' } })
})

test('CLI 取消订阅只接受 user 经 CLI；MCP 调用一律拒绝', async () => {
  const r = await taskUnsubscribeOp.run(
    { id: 'dev', pr: PR },
    { home: '/nonexistent', actor: 'user', via: 'mcp' },
  )
  expect(r).toMatchObject({ ok: false, error: { code: 'user_only' } })
})

test('账本只接受中枢写订阅；用户只能以 user 原因取消；投影可重建', async () => {
  const s = await setup()
  const sub = { type: 'pr.subscribed' as const, task_id: 'dev', workspace: WS }
  expect(
    s.store.append({ ...sub, payload: { pr: PR, role: 'author' } }, { actor: 'supervisor' }),
  ).toMatchObject({ ok: false, error: { code: 'actor_mismatch' } })
  expect(
    s.store.append(
      { ...sub, payload: { pr: 'https://GitHub.com/acme/demo/pull/40', role: 'author' } },
      { actor: 'hub' },
    ),
  ).toMatchObject({ ok: false, error: { code: 'invalid_event' } })
  must(s.store.append({ ...sub, payload: { pr: PR, role: 'author' } }, { actor: 'hub' }))
  expect(
    s.store.append({ ...sub, payload: { pr: PR, role: 'author' } }, { actor: 'hub' }),
  ).toMatchObject({ ok: false, error: { code: 'duplicate_subscription' } })
  const unsub = { type: 'pr.unsubscribed' as const, task_id: 'dev', workspace: WS }
  expect(
    s.store.append({ ...unsub, payload: { pr: PR, reason: 'pr_closed' } }, { actor: 'user' }),
  ).toMatchObject({ ok: false, error: { code: 'actor_mismatch' } })
  expect(
    s.store.append({ ...unsub, payload: { pr: PR, reason: 'user' } }, { actor: 'hub' }),
  ).toMatchObject({ ok: false, error: { code: 'actor_mismatch' } })
  must(s.store.append({ ...unsub, payload: { pr: PR, reason: 'pr_closed' } }, { actor: 'hub' }))
  must(
    s.store.append(
      {
        type: 'pr.event',
        workspace: WS,
        payload: {
          pr: PR,
          kind: 'issue_comment',
          actor: 'acme',
          actor_kind: 'human',
          allowed: true,
          text: '好的',
          url: `${PR}#issuecomment-1`,
          cursor: '2026-10-24T00:01:00.000Z|1',
        },
      },
      { actor: 'hub' },
    ),
  )
  const before = s.store.snapshot({ includeSoft: false })
  must(s.store.rebuild())
  expect(s.store.snapshot({ includeSoft: false })).toEqual(before)
  expect(s.store.prCursors(WS, PR)).toEqual({ issue_comment: '2026-10-24T00:01:00.000Z|1' })
})

test('任务阶段：派工已结束且有活跃订阅时为空闲，取消订阅后回到排队', async () => {
  const s = await setup()
  must(
    s.store.append(
      {
        type: 'task.attempt_ended',
        task_id: 'dev',
        workspace: WS,
        payload: { attempt: 1, reason: 'lease_expired' },
      },
      { actor: 'hub' },
    ),
  )
  const stage = () => readTaskStage(s.store, s.store.getTask('dev') as TaskView)
  expect(stage()).toBe('queued')
  must(
    s.store.append(
      { type: 'pr.subscribed', task_id: 'dev', workspace: WS, payload: { pr: PR, role: 'author' } },
      { actor: 'hub' },
    ),
  )
  expect(stage()).toBe('idle')
  must(s.tasks.unsubscribeTask('dev', { pr: PR }, { actor: 'user' }))
  expect(stage()).toBe('queued')
  expect(hasActivePrSubscription(s.store.taskEvents('dev'))).toBe(false)
})
