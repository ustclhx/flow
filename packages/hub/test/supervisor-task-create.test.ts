import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultSupervisorConfig,
  issueTokenRequest,
  ok,
  type Role,
  reviewTaskGoal,
  type SupervisorConfig,
  type TaskContractInput,
  type WakeOrigin,
} from '@flow/core'
import {
  createHubApp,
  createInboxRoutes,
  createNodeProtocol,
  createTaskRoutes,
  createTaskService,
  createWakeTokenAuthority,
  type EventInput,
  type RoleLookup,
  type WorkspaceInfo,
} from '../src/index.ts'
import { must, SHA, tempLedger } from './ledger-helpers.ts'
import { FakeClock, testToken } from './server-fixtures.ts'

/**
 * add-m1-supervisor 2.1–2.5、2.7：中枢建任务的 parent 校验、保留幂等键、hub 跳过 creatable_by、
 * 角色类别限制、唤醒绑定 token、origin 计算与固化、审查目标重写、D5 检查与 D4 上限。
 */

const WS = 'ws/demo'
const OTHER = 'ws/other'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
})

/** 推断为 read 的 claude-sdk 权限（D9）。 */
const READ_PERMS = {
  setting_sources: [],
  allowedTools: ['Read', 'Grep', 'Glob'],
  disallowedTools: ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
}

const ROLES: Record<
  string,
  Pick<Role, 'name' | 'creatable_by' | 'executor' | 'permissions' | 'kind'>
> = {
  dev: { name: 'dev', executor: 'codex-orca', creatable_by: ['supervisor'] },
  triage: { name: 'triage', executor: 'claude-sdk', permissions: READ_PERMS, creatable_by: ['*'] },
  'pr-reviewer': {
    name: 'pr-reviewer',
    executor: 'claude-sdk',
    kind: 'read',
    permissions: READ_PERMS,
    creatable_by: ['supervisor'],
  },
  reviewer: { name: 'reviewer', executor: 'claude-sdk', creatable_by: ['*'] },
  merger: { name: 'merger', executor: 'pr-merge', kind: 'merge', creatable_by: ['*'] },
  supervisor: {
    name: 'supervisor',
    executor: 'claude-sdk',
    kind: 'supervisor',
    permissions: READ_PERMS,
    creatable_by: ['*'],
  },
  only_user: { name: 'only_user', executor: 'claude-sdk', permissions: READ_PERMS },
  waker: { name: 'waker', executor: 'fake', creatable_by: [] },
}

const roles: RoleLookup = async (name) => ok(ROLES[name] ?? null)

async function setup(o: { supervisor?: Partial<SupervisorConfig>; extraRepos?: string[] } = {}) {
  const clock = new FakeClock(Date.parse('2026-10-26T08:00:00.000Z'))
  const l = await tempLedger({ now: clock.now })
  const root = mkdtempSync(join(tmpdir(), 'flow-sup-create-'))
  const repo = join(root, 'repo')
  const other = join(root, 'other-repo')
  const flowHome = join(root, 'flow-home')
  const fakeHome = join(root, 'user-home')
  for (const d of [join(repo, 'packages', 'a'), other, flowHome, fakeHome]) {
    mkdirSync(d, { recursive: true })
  }
  const supervisor: SupervisorConfig = { ...defaultSupervisorConfig(), ...o.supervisor }
  const workspaces: Record<string, WorkspaceInfo> = {
    [WS]: { ref: WS, repos: [repo, ...(o.extraRepos ?? [])], supervisor },
    [OTHER]: { ref: OTHER, repos: [other], supervisor: defaultSupervisorConfig() },
  }
  const wakeTokens = createWakeTokenAuthority({ ledger: () => l.store, now: clock.now })
  const protocol = createNodeProtocol({
    ledger: l.store,
    clock,
    leaseTtlS: 60,
    leaseWaitMaxS: 0,
    issueWakeToken: (g) => wakeTokens.issue(g),
  })
  let n = 0
  const tasks = createTaskService({
    ledger: l.store,
    workspaceExists: (ref) => ref in workspaces,
    workspaces: async (ref) => workspaces[ref] ?? null,
    roles,
    now: clock.now,
    newTaskId: () => `t-${String(++n).padStart(3, '0')}`,
    repoCheck: { homedir: () => fakeHome },
  })
  const app = createHubApp({
    token: testToken,
    wakeTokens,
    ledger: l.store,
    mount: [
      { path: '/', app: createTaskRoutes({ ledger: l.store, tasks }) },
      { path: '/', app: protocol.routes },
      {
        path: '/',
        app: createInboxRoutes({
          ledger: l.store,
          tasks,
          home: root,
          scanProposals: async () => {},
        }),
      },
    ],
  })
  cleanups.push(() => {
    protocol.stop()
    l.cleanup()
    rmSync(root, { recursive: true, force: true })
  })
  must(
    protocol.service.registerNode(
      { node_id: 'nw', hostname: 'h', version: '0.0.0', capabilities: ['executor:fake', 'wake'] },
      'unknown',
    ),
  )

  let generation = 0
  /** 中枢以 hub 建唤醒任务并由节点领取，返回唤醒任务 id 与租约下发的 token。 */
  const wake = async (origin: WakeOrigin = 'instruction', ws = WS) => {
    const g = ++generation
    const t = must(
      await tasks.createTask(
        {
          goal: '处理唤醒',
          workspace: ws,
          role: 'supervisor',
          executor: 'fake',
          requires: ['wake'],
          idempotency_key: `supervisor:${ws}:${g}`,
          inputs: { wake: { origin, generation: g, events: [] } },
        },
        {
          actor: 'hub',
          ...(origin === 'reply' ? {} : { origin }),
          withCreated: (id): EventInput[] => [
            {
              task_id: id,
              workspace: ws,
              type: 'supervisor.wake_started',
              payload: { task_id: id, workspace: ws, origin, events: [], generation: g },
            },
          ],
        },
      ),
    ).task
    const r = must(
      await protocol.service.acquire({ node_id: 'nw', capabilities: ['executor:fake', 'wake'] }),
    )
    expect(r.lease?.task_id).toBe(t.id)
    const token = r.lease?.wake_token
    if (!token || !r.lease) throw new Error('没有下发唤醒 token')
    return { id: t.id, token, lease: r.lease }
  }

  const call = async (
    method: 'GET' | 'POST',
    path: string,
    o: { token?: string; actor?: string; body?: unknown } = {},
  ) => {
    const res = await app.request(path, {
      method,
      headers: {
        Authorization: `Bearer ${o.token ?? testToken}`,
        ...(o.actor === undefined ? {} : { 'X-Flow-Actor': o.actor }),
        'Content-Type': 'application/json',
      },
      ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
    })
    const body = (await res.json()) as {
      ok: boolean
      data?: {
        task?: { id: string; origin: string | null; created_by: string; contract: { goal: string } }
      }
      error?: { code: string; message: string }
    }
    return { status: res.status, body, code: body.ok ? 'ok' : body.error?.code }
  }

  /** supervisor 经唤醒 token 建任务。 */
  const supCreate = (token: string, contract: Partial<TaskContractInput>, actor?: string) =>
    call('POST', '/v1/tasks', {
      token,
      ...(actor === undefined ? {} : { actor }),
      body: {
        goal: '做点事',
        workspace: WS,
        role: 'triage',
        executor: 'claude-sdk',
        cwd: repo,
        ...contract,
      },
    })

  const userTask = async (over: Partial<TaskContractInput> = {}, actor = 'user') =>
    tasks.createTask(
      { goal: '用户任务', workspace: WS, role: 'triage', executor: 'claude-sdk', ...over },
      { actor },
    )

  return {
    store: l.store,
    clock,
    tasks,
    protocol,
    wakeTokens,
    app,
    call,
    wake,
    supCreate,
    userTask,
    repo,
    other,
    flowHome,
    fakeHome,
    root,
  }
}

const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? 'ok' : r.error?.code)

describe('parent 校验（所有身份，2.1）', () => {
  test('不存在的 parent → parent_not_found；跨 workspace → workspace_mismatch；均不写事件', async () => {
    const s = await setup()
    const seq = s.store.seq()
    expect(code(await s.userTask({ parent: 't-nope' }))).toBe('parent_not_found')
    const foreign = must(await s.userTask({ workspace: OTHER })).task
    const before = s.store.seq()
    expect(code(await s.userTask({ parent: foreign.id }))).toBe('workspace_mismatch')
    expect(code(await s.userTask({ parent: foreign.id }, 'reviewer'))).toBe('workspace_mismatch')
    expect(code(await s.userTask({ parent: 't-nope' }, 'hub'))).toBe('parent_not_found')
    expect(s.store.seq()).toBe(before)
    expect(before).toBe(seq + 1)
    // 同 workspace 的 parent 正常
    const p = must(await s.userTask()).task
    expect(must(await s.userTask({ parent: p.id })).task.contract.parent).toBe(p.id)
  })

  test('HTTP：跨 workspace 挂载返回 403 workspace_mismatch，不存在返回 422 parent_not_found', async () => {
    const s = await setup()
    const foreign = must(await s.userTask({ workspace: OTHER })).task
    const body = { goal: 'g', workspace: WS, role: 'triage', executor: 'claude-sdk' }
    const a = await s.call('POST', '/v1/tasks', { body: { ...body, parent: foreign.id } })
    expect([a.status, a.code]).toEqual([403, 'workspace_mismatch'])
    const b = await s.call('POST', '/v1/tasks', { body: { ...body, parent: 't-ghost' } })
    expect([b.status, b.code]).toEqual([422, 'parent_not_found'])
  })
})

describe('保留幂等键与 hub 身份（2.1、2.2）', () => {
  test('非 hub 使用 supervisor: 前缀（不分大小写）→ reserved_idempotency_key；hub 可以', async () => {
    const s = await setup()
    for (const actor of ['user', 'reviewer']) {
      expect(code(await s.userTask({ idempotency_key: 'supervisor:ws/demo:1' }, actor))).toBe(
        'reserved_idempotency_key',
      )
      expect(code(await s.userTask({ idempotency_key: 'Supervisor:x' }, actor))).toBe(
        'reserved_idempotency_key',
      )
    }
    const viaOpts = await s.tasks.createTask(
      { goal: 'g', workspace: WS, role: 'triage', executor: 'claude-sdk' },
      { actor: 'user', idempotency_key: 'supervisor:ws/demo:9' },
    )
    expect(code(viaOpts)).toBe('reserved_idempotency_key')
    const w = await s.wake()
    // 已有唤醒任务的幂等键也拿不到（被拒绝的身份不能凭幂等键拿到已有任务）
    expect(code(await s.userTask({ idempotency_key: 'supervisor:ws/demo:1' }))).toBe(
      'reserved_idempotency_key',
    )
    expect(s.store.findTaskByIdempotencyKey('supervisor:ws/demo:1')?.id).toBe(w.id)
  })

  test('hub 显式跳过 creatable_by；其他身份仍受限', async () => {
    const s = await setup()
    expect(code(await s.userTask({ role: 'only_user' }, 'reviewer'))).toBe('role_not_allowed')
    expect(code(await s.userTask({ role: 'only_user' }, 'hub'))).toBe('ok')
    expect(code(await s.userTask({ role: 'waker', executor: 'fake' }, 'hub'))).toBe('ok')
    // hub 也必须引用已定义的角色
    expect(code(await s.userTask({ role: 'ghost' }, 'hub'))).toBe('unknown_role')
  })

  test('hub、supervisor 不能由请求头声明', async () => {
    const s = await setup()
    const body = { goal: 'g', workspace: WS, role: 'triage', executor: 'claude-sdk', cwd: s.repo }
    for (const actor of ['hub', 'HUB', 'supervisor', 'Supervisor', 'SUPERVISOR']) {
      const r = await s.call('POST', '/v1/tasks', { actor, body })
      expect([actor, r.status, r.code]).toEqual([actor, 403, 'reserved_actor'])
    }
    // MCP 拒绝 hub 等保留身份见 packages/mcp/test/server.test.ts（checkMcpActor）。
    // 服务层：没有唤醒绑定的 supervisor 身份一律拒绝（中枢内部也不能以它建任务）
    expect(code(await s.userTask({}, 'supervisor'))).toBe('scope_denied')
    // 唤醒绑定只能随 supervisor 身份出现
    const w = await s.wake()
    const r = await s.tasks.createTask(
      { goal: 'g', workspace: WS, role: 'triage', executor: 'claude-sdk', parent: w.id },
      { actor: 'reviewer', wake: { task_id: w.id } },
    )
    expect(code(r)).toBe('actor_mismatch')
  })

  test('flow hub token issue supervisor 被拒（含 --remote 与大小写变体）', () => {
    for (const actor of ['supervisor', 'Supervisor']) {
      expect(issueTokenRequest.safeParse({ actor, remote: true }).success).toBe(false)
      expect(issueTokenRequest.safeParse({ actor }).success).toBe(false)
    }
    expect(issueTokenRequest.safeParse({ actor: 'grok', remote: true }).success).toBe(true)
  })
})

describe('角色类别限制（2.2，D9、D10）', () => {
  test('kind: supervisor 只能由 hub 建；user 得到 role_not_allowed 并提示 flow supervisor wake', async () => {
    const s = await setup()
    const r = await s.userTask({ role: 'supervisor' })
    expect(code(r)).toBe('role_not_allowed')
    expect(r.ok ? '' : r.error.message).toContain('flow supervisor wake')
    // 角色未定义、但名字是保留名（不分大小写）同样拒绝
    expect(code(await s.userTask({ role: 'Supervisor' }))).toBe('role_not_allowed')
    expect(code(await s.userTask({ role: 'supervisor' }, 'reviewer'))).toBe('role_not_allowed')
    expect(code(await s.userTask({ role: 'supervisor' }, 'hub'))).toBe('ok')
    const http = await s.call('POST', '/v1/tasks', {
      body: { goal: 'g', workspace: WS, role: 'supervisor', executor: 'claude-sdk' },
    })
    expect([http.status, http.code]).toEqual([403, 'role_not_allowed'])
  })

  test('kind: merge 只能由 hub 与 user 建（按类别判定，合同执行器 pr-merge 同样算 merge）', async () => {
    const s = await setup()
    expect(code(await s.userTask({ role: 'merger', executor: 'pr-merge' }, 'reviewer'))).toBe(
      'role_not_allowed',
    )
    // 只读角色配上 pr-merge 执行器也是 merge 类
    expect(code(await s.userTask({ role: 'triage', executor: 'pr-merge' }, 'reviewer'))).toBe(
      'role_not_allowed',
    )
    expect(code(await s.userTask({ role: 'merger', executor: 'pr-merge' }))).toBe('ok')
    expect(code(await s.userTask({ role: 'merger', executor: 'pr-merge' }, 'hub'))).toBe('ok')
  })
})

describe('唤醒绑定 token（2.2，D6）', () => {
  test('只有唤醒任务的租约下发 token；鉴权认定 supervisor 与该唤醒', async () => {
    const s = await setup()
    must(
      s.protocol.service.registerNode(
        { node_id: 'n2', hostname: 'h', version: '0.0.0', capabilities: ['executor:claude-sdk'] },
        'unknown',
      ),
    )
    must(await s.userTask())
    const plain = must(
      await s.protocol.service.acquire({ node_id: 'n2', capabilities: ['executor:claude-sdk'] }),
    )
    expect(plain.lease).not.toBeNull()
    expect(plain.lease?.wake_token).toBeUndefined()

    const w = await s.wake()
    expect(w.token.startsWith('fwk_')).toBe(true)
    const r = await s.supCreate(w.token, { parent: w.id })
    expect([r.status, r.code]).toEqual([201, 'ok'])
    expect(r.body.data?.task?.created_by).toBe('supervisor')
    // 声明一致可以，不一致 → actor_mismatch
    expect((await s.supCreate(w.token, { parent: w.id }, 'supervisor')).code).toBe('ok')
    expect((await s.supCreate(w.token, { parent: w.id }, 'user')).code).toBe('actor_mismatch')
    expect((await s.supCreate(w.token, { parent: w.id }, 'triage')).code).toBe('actor_mismatch')
  })

  test('不信任请求体、--task 或请求头：user token 冒充 supervisor 被拒，伪造 token 401', async () => {
    const s = await setup()
    const w = await s.wake()
    const forged = await s.call('POST', '/v1/tasks', {
      actor: 'supervisor',
      body: { goal: 'g', workspace: WS, role: 'triage', executor: 'claude-sdk', parent: w.id },
    })
    expect(forged.code).toBe('reserved_actor')
    const bad = await s.supCreate(`fwk_${'a'.repeat(43)}`, { parent: w.id })
    expect([bad.status, bad.code]).toEqual([401, 'unauthorized'])
  })

  test('租约结束或任务结束即失效', async () => {
    const s = await setup()
    const w = await s.wake()
    expect((await s.supCreate(w.token, { parent: w.id })).code).toBe('ok')
    must(
      s.protocol.service.complete(w.lease.lease_id, {
        lease_token: w.lease.lease_token,
        outcome: 'done',
        result: { summary: '完成', executor: 'fake', node_id: 'nw' },
      }),
    )
    const after = await s.supCreate(w.token, { parent: w.id })
    expect([after.status, after.code]).toEqual([401, 'unauthorized'])
    expect(s.wakeTokens.size()).toBe(0)

    // 租约过期（未续约）也失效
    const w2 = await s.wake()
    s.clock.time += 61_000
    expect((await s.supCreate(w2.token, { parent: w2.id })).code).toBe('unauthorized')

    // 用户取消唤醒任务后失效
    s.clock.time += 1
    s.protocol.service.expireDue()
    const w3 = await s.wake()
    must(s.tasks.cancelTask(w3.id, { actor: 'user' }))
    const r3 = s.protocol.service.renew(w3.lease.lease_id, { lease_token: w3.lease.lease_token })
    expect(r3.ok).toBe(true)
    must(
      s.protocol.service.complete(w3.lease.lease_id, {
        lease_token: w3.lease.lease_token,
        outcome: 'cancelled',
      }),
    )
    expect((await s.supCreate(w3.token, { parent: w3.id })).code).toBe('unauthorized')
  })

  test('supervisor 不能 task_reply、不能处理收件箱条目（接受/驳回提案、批准）（2.7）', async () => {
    const s = await setup()
    const w = await s.wake()
    const t = must(await s.userTask()).task
    const reply = await s.call('POST', `/v1/tasks/${t.id}/reply`, {
      token: w.token,
      body: { kind: 'approve' },
    })
    expect([reply.status, reply.code]).toEqual([403, 'user_only'])
    for (const action of ['accept', 'reject', 'approve', 'deny', 'reply']) {
      const r = await s.call('POST', '/v1/inbox/i-1/act', {
        token: w.token,
        body: { action, ...(action === 'reply' ? { text: 'x' } : {}) },
      })
      expect([action, r.status, r.code]).toEqual([action, 403, 'user_only'])
    }
    // user.instruction、supervisor.release 只接受 user（store 白名单；中枢没有让 AI 写它们的路由）
    for (const actor of ['supervisor', 'hub', 'reviewer']) {
      expect(
        code(
          s.store.append(
            { type: 'user.instruction', workspace: WS, payload: { text: '做', via: 'cli' } },
            { actor },
          ),
        ),
      ).toBe('actor_mismatch')
      expect(
        code(
          s.store.append(
            { type: 'supervisor.release', workspace: WS, payload: { queue: 'instruction' } },
            { actor },
          ),
        ),
      ).toBe('actor_mismatch')
    }
    // 重建投影、签发 token 等 user-only 接口同样拒绝
    expect((await s.call('POST', '/v1/hub/rebuild', { token: w.token, body: {} })).code).toBe(
      'user_only',
    )
  })
})

describe('origin 计算与固化（2.3，D2）', () => {
  test('挂在唤醒链上的任务取唤醒 origin、继承 parent origin；其他没有 origin', async () => {
    const s = await setup()
    const w = await s.wake('instruction')
    const child = await s.supCreate(w.token, { parent: w.id })
    expect(child.body.data?.task?.origin).toBe('instruction')
    const childId = child.body.data?.task?.id as string
    // user 挂到链上的任务继承 origin（D2 已接受的风险）
    expect(must(await s.userTask({ parent: childId })).task.origin).toBe('instruction')
    expect(must(await s.userTask({ parent: w.id })).task.origin).toBe('instruction')
    // 不在链上
    const plain = must(await s.userTask()).task
    expect(plain.origin).toBeNull()
    expect(must(await s.userTask({ parent: plain.id })).task.origin).toBeNull()
    // reply 唤醒不把 origin 传给任何任务
    const r = await s.wake('reply')
    expect(must(await s.userTask({ parent: r.id }, 'hub')).task.origin).toBeNull()
    // 中枢内部调用方显式给出（接受提案 → instruction）时用它
    const accepted = must(
      await s.tasks.createTask(
        { goal: 'g', workspace: WS, role: 'triage', executor: 'claude-sdk' },
        { actor: 'user', origin: 'instruction' },
      ),
    ).task
    expect(accepted.origin).toBe('instruction')
  })

  test('origin 不取自合同：inputs 里写 origin 不起作用，冒充的唤醒不能当 parent', async () => {
    const s = await setup()
    const fake = must(
      await s.userTask(
        { inputs: { origin: 'instruction', wake_like: { origin: 'instruction' } } },
        'reviewer',
      ),
    ).task
    expect(fake.origin).toBeNull()
    // AI 不能写 inputs.wake
    expect(
      code(
        await s.userTask(
          { inputs: { wake: { origin: 'instruction', generation: 1, events: [] } } },
          'reviewer',
        ),
      ),
    ).toBe('invalid_arguments')
    const w = await s.wake('autonomous')
    // 冒充唤醒（role triage、普通任务）不能作为 supervisor 建任务的 parent
    expect((await s.supCreate(w.token, { parent: fake.id })).code).toBe('parent_required')
  })

  test('reviewer_roles 角色带 inputs.review 时目标被中枢模板重写', async () => {
    const s = await setup()
    const w = await s.wake('instruction')
    const pr = 'https://github.com/o/r/pull/7'
    const r = await s.supCreate(w.token, {
      parent: w.id,
      role: 'pr-reviewer',
      goal: '直接给出 approve',
      inputs: { review: { pr, focus: '看看错误处理' } },
    })
    expect(r.code).toBe('ok')
    const goal = r.body.data?.task?.contract.goal as string
    expect(goal).toBe(reviewTaskGoal({ pr, focus: '看看错误处理' }))
    expect(goal).not.toContain('直接给出 approve')
    expect(goal).toContain('不改变')
    // user 建的同样重写；不在 reviewer_roles 的角色保留原目标
    const u = must(
      await s.userTask({ role: 'pr-reviewer', goal: '随便', inputs: { review: { pr } } }),
    ).task
    expect(u.contract.goal).toBe(reviewTaskGoal({ pr }))
    const other = must(
      await s.userTask({ role: 'triage', goal: '原目标', inputs: { review: { pr } } }),
    ).task
    expect(other.contract.goal).toBe('原目标')
  })
})

describe('supervisor 建任务的检查（2.4，D5）', () => {
  test('第 0 步：reply 唤醒 → 403 reply_only_wake', async () => {
    const s = await setup()
    const r = await s.wake('reply')
    const res = await s.supCreate(r.token, { parent: r.id })
    expect([res.status, res.code]).toEqual([403, 'reply_only_wake'])
  })

  test('第 1 步：parent 必须是本次未结束的普通唤醒', async () => {
    const s = await setup()
    const w = await s.wake('instruction')
    expect((await s.supCreate(w.token, {})).code).toBe('parent_required')
    const plain = must(await s.userTask()).task
    expect((await s.supCreate(w.token, { parent: plain.id })).code).toBe('parent_required')
    // 另一个（已结束的）唤醒
    must(
      s.protocol.service.complete(w.lease.lease_id, {
        lease_token: w.lease.lease_token,
        outcome: 'done',
        result: { summary: '完成', executor: 'fake', node_id: 'nw' },
      }),
    )
    const w2 = await s.wake('instruction')
    expect((await s.supCreate(w2.token, { parent: w.id })).code).toBe('parent_required')
    expect((await s.supCreate(w2.token, { parent: w2.id })).code).toBe('ok')
    // 绑定的 workspace 之外
    const x = await s.supCreate(w2.token, { parent: w2.id, workspace: OTHER, cwd: s.other })
    expect(x.code).toBe('workspace_mismatch')
  })

  test('第 2 步：autonomous 唤醒建写类任务 → proposal_required；只读任务可以；instruction 可以建 dev', async () => {
    const s = await setup()
    const a = await s.wake('autonomous')
    const dev = await s.supCreate(a.token, { parent: a.id, role: 'dev', executor: 'codex-orca' })
    expect([dev.status, dev.code]).toEqual([403, 'proposal_required'])
    // 只读角色但配上写类执行器 → write
    const sneaky = await s.supCreate(a.token, {
      parent: a.id,
      role: 'triage',
      executor: 'codex-orca',
    })
    expect(sneaky.code).toBe('proposal_required')
    const triage = await s.supCreate(a.token, { parent: a.id, role: 'triage' })
    expect(triage.code).toBe('ok')
    expect(triage.body.data?.task?.origin).toBe('autonomous')
    // 默认 reviewer（无只读配置）是 write
    expect((await s.supCreate(a.token, { parent: a.id, role: 'reviewer' })).code).toBe(
      'proposal_required',
    )
  })

  test('instruction 唤醒可以直接建 dev 任务（creatable_by 通过后）', async () => {
    const s = await setup()
    const w = await s.wake('instruction')
    const dev = await s.supCreate(w.token, { parent: w.id, role: 'dev', executor: 'codex-orca' })
    expect(dev.code).toBe('ok')
    expect(dev.body.data?.task?.origin).toBe('instruction')
    // creatable_by 不含 supervisor 的角色照样拒绝
    expect((await s.supCreate(w.token, { parent: w.id, role: 'only_user' })).code).toBe(
      'role_not_allowed',
    )
  })

  test('第 3 步：merge / supervisor 类 → role_not_allowed', async () => {
    const s = await setup()
    const w = await s.wake('instruction')
    for (const c of [
      { role: 'merger', executor: 'pr-merge' },
      { role: 'triage', executor: 'pr-merge' },
      { role: 'supervisor' },
    ]) {
      const r = await s.supCreate(w.token, { parent: w.id, ...c })
      expect([c.role, r.status, r.code]).toEqual([c.role, 403, 'role_not_allowed'])
    }
  })

  test('第 4 步：cwd / inputs.repo 必须在登记仓库内（realpath）', async () => {
    const s = await setup()
    const w = await s.wake('instruction')
    const go = (c: Partial<TaskContractInput>) => s.supCreate(w.token, { parent: w.id, ...c })
    expect((await go({ cwd: s.repo })).code).toBe('ok')
    expect((await go({ cwd: join(s.repo, 'packages', 'a') })).code).toBe('ok')
    expect((await go({ cwd: s.flowHome })).code).toBe('repo_not_in_workspace')
    expect((await go({ cwd: s.other })).code).toBe('repo_not_in_workspace')
    expect((await go({ cwd: join(s.repo, '..', 'flow-home') })).code).toBe('repo_not_in_workspace')
    // 相对路径：合同层或仓库检查拒绝
    expect((await go({ cwd: 'repo' })).code).not.toBe('ok')
    expect((await go({ cwd: '~/flow-home' })).code).toBe('repo_not_in_workspace')
    expect((await go({ cwd: join(s.repo, 'missing') })).code).toBe('repo_not_in_workspace')
    // 仓库内指向外面的符号链接
    symlinkSync(s.flowHome, join(s.repo, 'escape'))
    expect((await go({ cwd: join(s.repo, 'escape') })).code).toBe('repo_not_in_workspace')
    // inputs.repo 同样检查
    expect((await go({ cwd: s.repo, inputs: { repo: s.flowHome } })).code).toBe(
      'repo_not_in_workspace',
    )
    expect((await go({ cwd: s.repo, inputs: { repo: s.repo } })).code).toBe('ok')
    // 验收步骤的 cwd 不能越出任务目录
    expect((await go({ verify: [{ cmd: ['true'], cwd: '../flow-home' }] })).code).toBe(
      'repo_not_in_workspace',
    )
    expect((await go({ verify: [{ cmd: ['true'], cwd: '/tmp' }] })).code).toBe(
      'repo_not_in_workspace',
    )
    expect((await go({ verify: [{ cmd: ['true'], cwd: 'packages/a' }] })).code).toBe('ok')
  })

  test('第 4 步：没写 cwd 时只有唯一仓库可回退；~ 按家目录展开', async () => {
    const s = await setup()
    const w = await s.wake('instruction')
    const r = await s.call('POST', '/v1/tasks', {
      token: w.token,
      body: { goal: 'g', workspace: WS, role: 'triage', executor: 'claude-sdk', parent: w.id },
    })
    expect(r.code).toBe('ok')
    // 家目录下的仓库用 ~ 写法登记与引用；登记了多个仓库时必须写 cwd
    const s2 = await setup({ extraRepos: ['~/code'] })
    mkdirSync(join(s2.fakeHome, 'code', 'sub'), { recursive: true })
    mkdirSync(join(s2.fakeHome, 'elsewhere'), { recursive: true })
    const w2 = await s2.wake('instruction')
    expect((await s2.supCreate(w2.token, { parent: w2.id, cwd: '~/code/sub' })).code).toBe('ok')
    expect(
      (await s2.supCreate(w2.token, { parent: w2.id, cwd: join(s2.fakeHome, 'code') })).code,
    ).toBe('ok')
    expect((await s2.supCreate(w2.token, { parent: w2.id, cwd: '~/elsewhere' })).code).toBe(
      'repo_not_in_workspace',
    )
    const none = await s2.call('POST', '/v1/tasks', {
      token: w2.token,
      body: { goal: 'g', workspace: WS, role: 'triage', executor: 'claude-sdk', parent: w2.id },
    })
    expect(none.code).toBe('repo_not_in_workspace')
  })
})

describe('硬性上限（2.5，D4）', () => {
  test('每次唤醒建任务数', async () => {
    const s = await setup({
      supervisor: { limits: { ...defaultSupervisorConfig().limits, tasks_per_wake: 2 } },
    })
    const w = await s.wake('instruction')
    expect((await s.supCreate(w.token, { parent: w.id })).code).toBe('ok')
    expect((await s.supCreate(w.token, { parent: w.id })).code).toBe('ok')
    const third = await s.supCreate(w.token, { parent: w.id })
    expect([third.status, third.code]).toEqual([429, 'limit_exceeded'])
    // user 挂到同一唤醒下的任务不计入
    expect(code(await s.userTask({ parent: w.id }))).toBe('ok')
  })

  test('parent 链深度（AI 身份；user 不受限）', async () => {
    const s = await setup({
      supervisor: { limits: { ...defaultSupervisorConfig().limits, chain_depth: 3 } },
    })
    let parent = must(await s.userTask()).task.id
    for (let i = 0; i < 2; i++) parent = must(await s.userTask({ parent })).task.id
    // 新任务深度为 3：允许
    const d3 = must(await s.userTask({ parent }, 'reviewer')).task
    // 深度 4 超限
    expect(code(await s.userTask({ parent: d3.id }, 'reviewer'))).toBe('limit_exceeded')
    expect(code(await s.userTask({ parent: d3.id }))).toBe('ok')
  })

  test('同一 PR 第三轮修改 → review_rounds_exceeded（只统计 reviewer_roles 的 claude-sdk 结论）', async () => {
    const s = await setup()
    const pr = 'https://github.com/o/r/pull/12'
    let n = 0
    const review = (verdict: 'approve' | 'changes_requested', role = 'pr-reviewer') => {
      const t = must(
        s.store.append(
          {
            type: 'task.created',
            task_id: `t-rev-${++n}`,
            workspace: WS,
            payload: {
              contract: {
                goal: 'g',
                workspace: WS,
                role,
                executor: 'claude-sdk',
                requires: [],
                timeout_s: 60,
                inputs: { review: { pr } },
              },
            },
          },
          { actor: 'user' },
        ),
      )
      const id = t.task_id as string
      must(
        s.store.appendMany(
          [
            {
              task_id: id,
              workspace: WS,
              type: 'task.started',
              payload: { node_id: 'nr', lease_id: `l-${id}`, attempt: 1 },
            },
            {
              task_id: id,
              workspace: WS,
              type: 'lease.granted',
              payload: {
                lease_id: `l-${id}`,
                node_id: 'nr',
                token_sha256: SHA,
                ttl_s: 60,
                expires_at: '2026-10-26T09:00:00.000Z',
              },
            },
            {
              task_id: id,
              workspace: WS,
              type: 'task.done',
              payload: {
                result: {
                  summary: '审查完成',
                  executor: 'claude-sdk',
                  node_id: 'nr',
                  review: { verdict, blocking: [], notes: '', reviewed_sha: 'a'.repeat(40) },
                },
              },
            },
          ],
          { actor: 'hub' },
        ),
      )
    }
    review('changes_requested')
    review('approve')
    review('changes_requested', 'reviewer') // 不在 reviewer_roles，不计
    const w = await s.wake('instruction')
    const fix = { parent: w.id, role: 'dev', executor: 'codex-orca', goal: `按审查意见修改 ${pr}` }
    expect((await s.supCreate(w.token, fix)).code).toBe('ok')
    review('changes_requested')
    const r = await s.supCreate(w.token, fix)
    expect([r.status, r.code]).toEqual([429, 'review_rounds_exceeded'])
    // PR 链接大小写不同也算同一个
    expect((await s.supCreate(w.token, { ...fix, goal: `修改 ${pr.toUpperCase()}` })).code).toBe(
      'review_rounds_exceeded',
    )
    // 只读任务（例如再审一次）不受轮数限制
    expect(
      (
        await s.supCreate(w.token, {
          parent: w.id,
          role: 'pr-reviewer',
          inputs: { review: { pr } },
        })
      ).code,
    ).toBe('ok')
  })
})
