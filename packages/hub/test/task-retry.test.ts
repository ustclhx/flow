import { afterEach, describe, expect, test } from 'bun:test'
import {
  HubClient,
  okBody,
  operations,
  retryTaskData,
  taskRetryOp,
  type WakeOrigin,
} from '@raindown/core'
import {
  createHubApp,
  createTaskRoutes,
  createTaskService,
  createWakeTokenAuthority,
} from '../src/index.ts'
import {
  anyRole,
  contractInput,
  drafts,
  must,
  result,
  startTask,
  sys,
  tempLedger,
  WS,
} from './ledger-helpers.ts'
import { testToken } from './server-fixtures.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})
const code = (r: { ok: boolean; error?: { code: string } }) => r.error?.code ?? 'ok'

async function setup() {
  const l = await tempLedger()
  cleanups.push(l.cleanup)
  let n = 0
  const tasks = createTaskService({
    ledger: l.store,
    workspaceExists: () => true,
    roles: anyRole,
    newTaskId: () => `t-retry-${++n}`,
  })
  const wake = async (origin: WakeOrigin = 'instruction', workspace = WS) => {
    const t = must(
      await tasks.createTask(contractInput({ workspace }), {
        actor: 'hub',
        ...(origin === 'reply' ? {} : { origin }),
        withCreated: (id) => [
          {
            type: 'supervisor.wake_started',
            task_id: id,
            workspace,
            payload: { task_id: id, workspace, origin, events: [], generation: ++n },
          },
        ],
      }),
    ).task
    const d = drafts(t.id, { ws: workspace })
    must(l.store.appendMany([d['task.started'], d['lease.granted']], sys))
    return t.id
  }
  const task = async (parent?: string, workspace = WS) =>
    must(
      await tasks.createTask(
        contractInput({ workspace, cwd: l.dir, ...(parent ? { parent } : {}) }),
        { actor: 'user' },
      ),
    ).task
  const block = (
    id: string,
    reason:
      | 'crashed'
      | 'node_lost'
      | 'other'
      | 'question'
      | 'awaiting_approval'
      | 'no_progress' = 'crashed',
    held = false,
  ) => {
    const d = startTask(l.store, id)
    must(
      l.store.append(
        {
          ...d['task.blocked'],
          payload: { reason, message: '等待恢复', ...(held ? { lease_held: true } : {}) },
        },
        sys,
      ),
    )
    return d
  }
  const wakeTokens = createWakeTokenAuthority({
    ledger: () => l.store,
    now: () => Date.parse('2026-10-24T00:30:00Z'),
  })
  const app = createHubApp({
    token: testToken,
    wakeTokens,
    mount: [{ path: '/', app: createTaskRoutes({ ledger: l.store, tasks }) }],
  })
  return { ...l, tasks, task, wake, block, app, wakeTokens }
}

describe('task_retry', () => {
  test('原子结束派工并重排，保留合同、工作目录、分支与 PR，释放旧租约', async () => {
    const e = await setup()
    const task = must(
      await e.tasks.createTask(
        contractInput({
          executor: 'codex-orca',
          cwd: e.dir,
          inputs: { review: { pr: 'https://github.com/o/r/pull/32' } },
        }),
        { actor: 'user' },
      ),
    ).task
    const d = startTask(e.store, task.id)
    must(
      e.store.append(
        {
          task_id: task.id,
          workspace: WS,
          type: 'task.branch_reported',
          payload: { branch: 'review-32', worktree: e.dir },
        },
        { actor: 'node:n1' },
      ),
    )
    must(
      e.store.append(
        { ...d['task.blocked'], payload: { reason: 'crashed', message: '退出', lease_held: true } },
        sys,
      ),
    )
    const lease = e.store.activeLease(task.id)
    const seen: string[] = []
    const stop = e.store.subscribe((event) => {
      if (event.type === 'task.attempt_ended') seen.push(e.store.getTask(task.id)?.status ?? '')
    })
    const retried = must(e.tasks.retryTask(task.id, { actor: 'user', reason: '再次审查 PR' })).task
    stop()
    expect(retried).toMatchObject({
      id: task.id,
      status: 'queued',
      attempt: 1,
      contract: task.contract,
      branch: 'review-32',
      worktree: e.dir,
    })
    expect(seen).toEqual(['queued'])
    expect(e.store.getLease(lease?.lease_id ?? '')?.state).toBe('released')
    expect(e.store.taskEvents(task.id).slice(-2)).toMatchObject([
      { type: 'task.attempt_ended', actor: 'user', payload: { attempt: 1, reason: 'retry' } },
      { type: 'task.requeued', actor: 'user', payload: { reason: 'manual', note: '再次审查 PR' } },
    ])
    startTask(e.store, task.id, 2)
    expect(e.store.getTask(task.id)?.attempt).toBe(2)
    expect(e.store.listTasks()).toHaveLength(1)
  })

  test('failed 可重试，清除旧结果与终态时间；其他终态与不允许的 blocked 原因拒绝', async () => {
    const e = await setup()
    const failed = await e.task()
    const d = startTask(e.store, failed.id)
    must(
      e.store.append(
        {
          ...d['task.failed'],
          payload: {
            result: {
              ...result(),
              artifacts: [{ kind: 'pr', ref: 'https://github.com/o/r/pull/32' }],
            },
          },
        },
        sys,
      ),
    )
    const before = e.store.getTask(failed.id)
    expect(before?.result?.artifacts).toHaveLength(1)
    const retried = must(e.tasks.retryTask(failed.id, { actor: 'user' })).task
    expect(retried).toMatchObject({ status: 'queued', result: null, finished_at: null })
    for (const reason of ['question', 'awaiting_approval', 'no_progress'] as const) {
      const task = await e.task()
      e.block(task.id, reason)
      const seq = e.store.seq()
      expect(code(e.tasks.retryTask(task.id, { actor: 'user' }))).toBe('invalid_transition')
      expect(e.store.seq()).toBe(seq)
    }
    const queued = await e.task()
    expect(code(e.tasks.retryTask(queued.id, { actor: 'user' }))).toBe('invalid_transition')
    must(e.tasks.cancelTask(queued.id, { actor: 'user' }))
    expect(code(e.tasks.retryTask(queued.id, { actor: 'user' }))).toBe('invalid_transition')
    expect(code(e.tasks.retryTask('t-missing', { actor: 'user' }))).toBe('not_found')
  })

  test('supervisor 后续唤醒可重试前代唤醒的后代；拒绝无关任务、跨 workspace、reply 与其他 actor', async () => {
    const e = await setup()
    const oldWake = await e.wake()
    const parent = await e.task(oldWake)
    const target = await e.task(parent.id)
    e.block(target.id)
    const newWake = await e.wake()
    const unrelated = await e.task()
    e.block(unrelated.id)
    expect(
      code(e.tasks.retryTask(unrelated.id, { actor: 'supervisor', wake: { task_id: newWake } })),
    ).toBe('scope_denied')
    expect(code(e.tasks.retryTask(target.id, { actor: 'supervisor' }))).toBe('scope_denied')
    expect(code(e.tasks.retryTask(target.id, { actor: 'codex' }))).toBe('role_not_allowed')
    expect(code(e.tasks.retryTask(target.id, { actor: 'user', wake: { task_id: newWake } }))).toBe(
      'actor_mismatch',
    )
    const reply = await e.wake('reply')
    expect(
      code(e.tasks.retryTask(target.id, { actor: 'supervisor', wake: { task_id: reply } })),
    ).toBe('reply_only_wake')
    const other = await e.wake('instruction', 'ws/other')
    expect(
      code(e.tasks.retryTask(target.id, { actor: 'supervisor', wake: { task_id: other } })),
    ).toBe('workspace_mismatch')
    const token = e.wakeTokens.issue({
      task_id: newWake,
      lease_id: e.store.activeLease(newWake)?.lease_id ?? '',
    })
    const response = await e.app.request(`/v1/tasks/${target.id}/retry`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(200)
    expect(okBody(retryTaskData).parse(await response.json()).data.task.status).toBe('queued')
  })

  test('操作由统一注册表导出；HubClient 与操作经 HTTP 校验输入及身份', async () => {
    const e = await setup()
    expect(operations.some((op) => op.name === 'task_retry' && op.cli === 'task retry')).toBe(true)
    const target = await e.task()
    e.block(target.id, 'other')
    const client = new HubClient({
      home: e.dir,
      actor: 'user',
      token: testToken,
      fetch: async (req) => e.app.fetch(req),
    })
    expect(must(await client.retryTask(target.id)).task.status).toBe('queued')
    const response = await e.app.request(`/v1/tasks/${target.id}/retry`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${testToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 123 }),
    })
    expect(response.status).toBe(400)
    expect(taskRetryOp.input.safeParse({ id: target.id, reason: '' }).success).toBe(false)
  })
})
