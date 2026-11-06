import { afterEach, describe, expect, test } from 'bun:test'
import {
  HubClient,
  ok,
  okBody,
  operations,
  type PolicyConfig,
  policyVersion,
  retryTaskData,
  taskRetryOp,
  type WakeOrigin,
} from '@raindown/core'
import {
  createHubApp,
  createTaskRoutes,
  createTaskService,
  createWakeTokenAuthority,
  type RoleLookup,
  type TaskServiceOptions,
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

async function setup(roles: RoleLookup = anyRole, policy?: TaskServiceOptions['policy']) {
  const l = await tempLedger()
  cleanups.push(l.cleanup)
  let n = 0
  const tasks = createTaskService({
    ledger: l.store,
    workspaceExists: () => true,
    roles,
    ...(policy ? { policy } : {}),
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
  const task = async (parent?: string, workspace = WS, actor = parent ? 'hub' : 'user') =>
    must(
      await tasks.createTask(
        contractInput({ workspace, cwd: l.dir, ...(parent ? { parent } : {}) }),
        { actor },
      ),
    ).task
  const block = (
    id: string,
    reason:
      | 'crashed'
      | 'workdir_missing'
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
  test('重试记录当前策略版本，新派工可追溯且不改写原 mandate', async () => {
    let policy: PolicyConfig = { rules: [], version: policyVersion([]), errors: [], warnings: [] }
    const e = await setup(anyRole, { load: async () => ok(policy), current: () => policy })
    const target = await e.task()
    const originalMandate = target.mandate
    expect(originalMandate?.policy_version).toBe(policy.version)
    const d = startTask(e.store, target.id)
    must(e.store.append(d['task.failed'], sys))
    const rules: PolicyConfig['rules'] = [
      { rule_index: 0, rule: { scope: '*', action: 'task.retry', level: 'draft-approve' } },
    ]
    policy = { rules, version: policyVersion(rules), errors: [], warnings: [] }

    const retried = must(
      await e.tasks.retryTask(target.id, { actor: 'user', reason: '策略更新后重试' }),
    ).task
    expect(retried.mandate).toEqual(originalMandate)
    expect(retried.mandate?.policy_version).not.toBe(policy.version)
    expect(e.store.taskEvents(target.id).at(-1)).toMatchObject({
      type: 'task.requeued',
      payload: {
        reason: 'manual',
        requested_by: 'user',
        retry_reason: '策略更新后重试',
        note: '策略更新后重试',
        policy_version: policy.version,
      },
    })
    startTask(e.store, target.id, 2)
    const shown = must(e.tasks.getTask(target.id))
    expect(shown.attempts).toMatchObject([
      { attempt: 1, policy_version: originalMandate?.policy_version },
      { attempt: 2, policy_version: policy.version },
    ])
    expect(shown.task.mandate).toEqual(originalMandate)
  })

  test('workdir_missing 在目录恢复后可重试，沿用原任务合同', async () => {
    const e = await setup()
    const target = await e.task()
    e.block(target.id, 'workdir_missing')
    const retried = must(await e.tasks.retryTask(target.id, { actor: 'user' })).task
    expect(retried).toMatchObject({ id: target.id, status: 'queued', contract: target.contract })
    expect(e.store.taskEvents(target.id).at(-1)).toMatchObject({
      type: 'task.requeued',
      payload: { reason: 'manual', requested_by: 'user' },
    })
    expect(e.store.taskEvents(target.id).at(-1)?.payload).not.toHaveProperty('retry_reason')
  })

  test('supervisor 必须提供非空 reason，拒绝时无写入；成功使用鉴权身份与脱敏理由', async () => {
    const e = await setup()
    const caller = await e.wake()
    const target = await e.task(caller)
    e.block(target.id)
    const seq = e.store.seq()
    for (const reason of [undefined, '', '   ']) {
      expect(
        await e.tasks.retryTask(target.id, {
          actor: 'supervisor',
          wake: { task_id: caller },
          ...(reason === undefined ? {} : { reason }),
        }),
      ).toMatchObject({
        ok: false,
        error: { kind: 'usage', code: 'invalid_arguments', details: { field: 'reason' } },
      })
      expect(e.store.seq()).toBe(seq)
    }
    const token = e.wakeTokens.issue({
      task_id: caller,
      lease_id: e.store.activeLease(caller)?.lease_id ?? '',
    })
    const response = await e.app.request(`/v1/tasks/${target.id}/retry`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { kind: 'usage', code: 'invalid_arguments', details: { field: 'reason' } },
    })
    expect(e.store.seq()).toBe(seq)
    const secret = `ghp_${'R1'.repeat(18)}`
    must(
      await e.tasks.retryTask(target.id, {
        actor: 'supervisor',
        wake: { task_id: caller },
        reason: `  恢复目录后重试 ${secret}  `,
      }),
    )
    const event = e.store.taskEvents(target.id).at(-1)
    expect(event).toMatchObject({
      type: 'task.requeued',
      actor: 'supervisor',
      payload: { reason: 'manual', requested_by: 'supervisor' },
    })
    expect(event?.payload).toHaveProperty('retry_reason')
    expect(JSON.stringify(event?.payload)).not.toContain(secret)
    expect(JSON.stringify(event?.payload)).toContain('恢复目录后重试')
  })

  test('原子结束派工并重排，保留合同、工作目录、分支与 PR', async () => {
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
        { ...d['task.blocked'], payload: { reason: 'crashed', message: '退出' } },
        sys,
      ),
    )
    const seen: string[] = []
    const stop = e.store.subscribe((event) => {
      if (event.type === 'task.attempt_ended') seen.push(e.store.getTask(task.id)?.status ?? '')
    })
    const retried = must(
      await e.tasks.retryTask(task.id, { actor: 'user', reason: '再次审查 PR' }),
    ).task
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
    expect(e.store.taskEvents(task.id).slice(-2)).toMatchObject([
      { type: 'task.attempt_ended', actor: 'user', payload: { attempt: 1, reason: 'retry' } },
      {
        type: 'task.requeued',
        actor: 'user',
        payload: {
          reason: 'manual',
          requested_by: 'user',
          retry_reason: '再次审查 PR',
          note: '再次审查 PR',
        },
      },
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
    const retried = must(await e.tasks.retryTask(failed.id, { actor: 'user' })).task
    expect(retried).toMatchObject({ status: 'queued', result: null, finished_at: null })
    for (const reason of ['question', 'awaiting_approval', 'no_progress'] as const) {
      const task = await e.task()
      e.block(task.id, reason)
      const seq = e.store.seq()
      expect(code(await e.tasks.retryTask(task.id, { actor: 'user' }))).toBe('invalid_transition')
      expect(e.store.seq()).toBe(seq)
    }
    const queued = await e.task()
    expect(code(await e.tasks.retryTask(queued.id, { actor: 'user' }))).toBe('invalid_transition')
    must(e.tasks.cancelTask(queued.id, { actor: 'user' }))
    expect(code(await e.tasks.retryTask(queued.id, { actor: 'user' }))).toBe('invalid_transition')
    expect(code(await e.tasks.retryTask('t-missing', { actor: 'user' }))).toBe('not_found')
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
      code(
        await e.tasks.retryTask(unrelated.id, {
          actor: 'supervisor',
          reason: '核对后重试',
          wake: { task_id: newWake },
        }),
      ),
    ).toBe('scope_denied')
    expect(
      code(await e.tasks.retryTask(target.id, { actor: 'supervisor', reason: '核对后重试' })),
    ).toBe('scope_denied')
    expect(code(await e.tasks.retryTask(target.id, { actor: 'codex' }))).toBe('role_not_allowed')
    expect(
      code(await e.tasks.retryTask(target.id, { actor: 'user', wake: { task_id: newWake } })),
    ).toBe('actor_mismatch')
    const reply = await e.wake('reply')
    expect(
      code(
        await e.tasks.retryTask(target.id, {
          actor: 'supervisor',
          reason: '核对后重试',
          wake: { task_id: reply },
        }),
      ),
    ).toBe('reply_only_wake')
    const other = await e.wake('instruction', 'ws/other')
    expect(
      code(
        await e.tasks.retryTask(target.id, {
          actor: 'supervisor',
          reason: '核对后重试',
          wake: { task_id: other },
        }),
      ),
    ).toBe('workspace_mismatch')
    const token = e.wakeTokens.issue({
      task_id: newWake,
      lease_id: e.store.activeLease(newWake)?.lease_id ?? '',
    })
    const response = await e.app.request(`/v1/tasks/${target.id}/retry`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: '核对后重试' }),
    })
    expect(response.status).toBe(200)
    expect(okBody(retryTaskData).parse(await response.json()).data.task.status).toBe('queued')
  })

  test('活动租约拒绝重试，取消请求优先返回且不改账本', async () => {
    const e = await setup()
    const target = await e.task()
    e.block(target.id, 'crashed', true)
    const lease = e.store.activeLease(target.id)
    const seq = e.store.seq()
    expect(code(await e.tasks.retryTask(target.id, { actor: 'user' }))).toBe('lease_active')
    expect(e.store.seq()).toBe(seq)
    const heldResponse = await e.app.request(`/v1/tasks/${target.id}/retry`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${testToken}` },
    })
    expect(heldResponse.status).toBe(409)
    expect(await heldResponse.json()).toMatchObject({ error: { code: 'lease_active' } })
    must(e.tasks.cancelTask(target.id, { actor: 'user' }))
    const cancelledSeq = e.store.seq()
    expect(code(await e.tasks.retryTask(target.id, { actor: 'user' }))).toBe('cancel_requested')
    expect(e.store.seq()).toBe(cancelledSeq)
    expect(e.store.getTask(target.id)?.cancel_requested).toBe(true)
    expect(e.store.activeLease(target.id)).toEqual(lease)
    const cancelledResponse = await e.app.request(`/v1/tasks/${target.id}/retry`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${testToken}` },
    })
    expect(cancelledResponse.status).toBe(409)
    expect(await cancelledResponse.json()).toMatchObject({ error: { code: 'cancel_requested' } })
  })

  test('角色加载期间的取消请求在重试写入前重新检查', async () => {
    let loading = false
    let loaded!: () => void
    let resume!: () => void
    const started = new Promise<void>((resolve) => {
      loaded = resolve
    })
    const gate = new Promise<void>((resolve) => {
      resume = resolve
    })
    const e = await setup(async (name) => {
      if (loading) {
        loaded()
        await gate
      }
      return anyRole(name)
    })
    const caller = await e.wake()
    const target = await e.task(caller)
    e.block(target.id, 'other', true)
    loading = true
    const retry = e.tasks.retryTask(target.id, {
      actor: 'supervisor',
      reason: '核对后重试',
      wake: { task_id: caller },
    })
    await started
    must(e.tasks.cancelTask(target.id, { actor: 'user' }))
    const seq = e.store.seq()
    resume()
    expect(code(await retry)).toBe('cancel_requested')
    expect(e.store.seq()).toBe(seq)
    expect(e.store.getTask(target.id)?.cancel_requested).toBe(true)
  })

  test('策略加载期间的取消请求在重试写入前重新检查', async () => {
    let loading = false
    let loaded!: () => void
    let resume!: () => void
    const started = new Promise<void>((resolve) => {
      loaded = resolve
    })
    const gate = new Promise<void>((resolve) => {
      resume = resolve
    })
    const e = await setup(anyRole, {
      load: async () => {
        if (loading) {
          loaded()
          await gate
        }
        return ok({ rules: [], version: policyVersion([]), errors: [], warnings: [] })
      },
    })
    const target = await e.task()
    e.block(target.id, 'other', true)
    loading = true
    const retry = e.tasks.retryTask(target.id, { actor: 'user' })
    await started
    must(e.tasks.cancelTask(target.id, { actor: 'user' }))
    const seq = e.store.seq()
    resume()
    expect(code(await retry)).toBe('cancel_requested')
    expect(e.store.seq()).toBe(seq)
    expect(e.store.getTask(target.id)?.cancel_requested).toBe(true)
  })

  test('已结束的当前派工重试只写 manual requeue，保留原结束事实', async () => {
    const e = await setup()
    for (const status of ['blocked', 'failed'] as const) {
      const target = await e.task()
      const d = startTask(e.store, target.id)
      must(
        e.store.appendMany(
          [
            {
              task_id: target.id,
              workspace: WS,
              type: 'task.attempt_ended',
              payload: { attempt: 1, reason: status === 'failed' ? 'failed' : 'blocked' },
            },
            status === 'failed'
              ? d['task.failed']
              : { ...d['task.blocked'], payload: { reason: 'crashed', message: '退出' } },
          ],
          sys,
        ),
      )
      const ended = e.store
        .taskEvents(target.id)
        .filter((event) => event.type === 'task.attempt_ended')
      must(await e.tasks.retryTask(target.id, { actor: 'user', reason: '恢复' }))
      expect(
        e.store.taskEvents(target.id).filter((event) => event.type === 'task.attempt_ended'),
      ).toEqual(ended)
      expect(e.store.taskEvents(target.id).at(-1)).toMatchObject({
        type: 'task.requeued',
        payload: { reason: 'manual', note: '恢复' },
      })
    }
  })

  test('用户和 supervisor 均不能直接重试唤醒；supervisor 不能重试 merge 或 supervisor 类', async () => {
    const e = await setup(async (name) =>
      ok({
        name,
        creatable_by: ['*'],
        ...(name === 'coordinator' ? { kind: 'supervisor' as const } : {}),
      }),
    )
    const caller = await e.wake()
    const targetWake = await e.wake()
    const wakeDrafts = drafts(targetWake)
    must(e.store.append(wakeDrafts['task.failed'], sys))
    for (const actor of ['user', 'supervisor']) {
      expect(
        code(
          await e.tasks.retryTask(targetWake, {
            actor,
            reason: '核对后重试',
            ...(actor === 'supervisor' ? { wake: { task_id: caller } } : {}),
          }),
        ),
      ).toBe('wake_retry_forbidden')
    }
    for (const contract of [
      { role: 'merger', executor: 'pr-merge' },
      { role: 'coordinator', executor: 'fake' },
    ]) {
      const target = must(
        await e.tasks.createTask(contractInput({ ...contract, parent: caller }), { actor: 'hub' }),
      ).task
      const d = startTask(e.store, target.id)
      must(e.store.append(d['task.failed'], sys))
      expect(
        code(
          await e.tasks.retryTask(target.id, {
            actor: 'supervisor',
            reason: '核对后重试',
            wake: { task_id: caller },
          }),
        ),
      ).toBe('role_not_allowed')
    }
  })

  test('autonomous 只能重试只读任务，instruction 可以重试写类任务', async () => {
    const e = await setup(async (name) =>
      ok({
        name,
        creatable_by: ['*'],
        ...(name === 'reader'
          ? {
              permissions: {
                setting_sources: [],
                allowedTools: ['Read', 'Grep', 'Glob'],
                disallowedTools: ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
              },
            }
          : {}),
      }),
    )
    const autonomous = await e.wake('autonomous')
    const instruction = await e.wake('instruction')
    for (const wake of [autonomous, instruction]) {
      const read = must(
        await e.tasks.createTask(
          contractInput({ role: 'reader', executor: 'claude-sdk', parent: instruction }),
          { actor: 'hub' },
        ),
      ).task
      e.block(read.id)
      expect(
        must(
          await e.tasks.retryTask(read.id, {
            actor: 'supervisor',
            reason: '核对后重试',
            wake: { task_id: wake },
          }),
        ).task.status,
      ).toBe('queued')
    }
    const write = await e.task(instruction)
    e.block(write.id)
    const seq = e.store.seq()
    expect(
      code(
        await e.tasks.retryTask(write.id, {
          actor: 'supervisor',
          reason: '核对后重试',
          wake: { task_id: autonomous },
        }),
      ),
    ).toBe('proposal_required')
    expect(e.store.seq()).toBe(seq)
    expect(
      must(
        await e.tasks.retryTask(write.id, {
          actor: 'supervisor',
          reason: '核对后重试',
          wake: { task_id: instruction },
        }),
      ).task.status,
    ).toBe('queued')
  })

  test('派生链每级必须由 hub 或 supervisor 创建，user 与 codex 子任务不能借 origin 重试', async () => {
    const e = await setup()
    const caller = await e.wake()
    const trusted = await e.task(caller)
    for (const actor of ['user', 'codex']) {
      for (const intermediate of [false, true]) {
        const child = await e.task(trusted.id, WS, actor)
        const target = intermediate ? await e.task(child.id) : child
        e.block(target.id)
        const seq = e.store.seq()
        expect(
          code(
            await e.tasks.retryTask(target.id, {
              actor: 'supervisor',
              reason: '核对后重试',
              wake: { task_id: caller },
            }),
          ),
        ).toBe('scope_denied')
        expect(e.store.seq()).toBe(seq)
      }
    }
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
    expect(taskRetryOp.input.safeParse({ id: target.id, requested_by: 'supervisor' }).success).toBe(
      false,
    )
    const spoof = await e.app.request(`/v1/tasks/${target.id}/retry`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${testToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: '恢复', requested_by: 'supervisor' }),
    })
    expect(spoof.status).toBe(400)
  })
})
