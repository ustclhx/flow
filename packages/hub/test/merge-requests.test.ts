import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultSupervisorConfig,
  EMPTY_INBOX_CONFIG,
  type InboxItemView,
  type LedgerEvent,
  ok,
  prMergeRequestOp,
  type Result,
  type SupervisorConfig,
  type TaskOrigin,
  type WakeOrigin,
} from '@flow/core'
import { initTempHome, isolateHub } from '../../core/test/helpers.ts'
import {
  actOnInbox,
  approveMergeRequest,
  createHubApp,
  createInboxRoutes,
  createNodeProtocol,
  createSupervisorToolRoutes,
  createTaskRoutes,
  createTaskService,
  createWakeTokenAuthority,
  type EventInput,
  type InboxActionDeps,
  MIN_MERGER_TIMEOUT_S,
  type RoleLookup,
  rejectMergeRequest,
  type SupervisorToolsDeps,
  WakeProjection,
} from '../src/index.ts'
import type { RoleForKind } from '../src/ledger/supervisor-checks.ts'
import { must, SHA, tempLedger } from './ledger-helpers.ts'
import { FakeClock, testToken } from './server-fixtures.ts'

/**
 * 合并请求 `pr_merge_request` 与 `merge_request` 条目（add-m1-supervisor D10 第 4 步；pr-acceptance
 * "合并请求的资格""合并请求按开关分流"；tasks 4.8、2.7）：真实签发的唤醒 token → 鉴权中间件 → 路由 → 账本。
 */

const WS = 'ws/product-res'
const OTHER = 'ws/xuanxue-saas'
const PR = 'https://github.com/acme/demo/pull/7'
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
})

const readOnly = {
  setting_sources: [],
  allowedTools: ['Read', 'Grep', 'Glob'],
  disallowedTools: ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
}

const ROLES: (RoleForKind & { creatable_by: string[] })[] = [
  {
    name: 'supervisor',
    executor: 'claude-sdk',
    kind: 'supervisor',
    permissions: readOnly,
    creatable_by: ['*'],
  },
  { name: 'dev', executor: 'codex-orca', creatable_by: ['supervisor'] },
  { name: 'triage', executor: 'claude-sdk', permissions: readOnly, creatable_by: ['*'] },
  { name: 'pr-reviewer', executor: 'claude-sdk', permissions: readOnly, creatable_by: ['*'] },
  { name: 'reviewer', executor: 'claude-sdk', creatable_by: ['*'] },
  { name: 'merger', executor: 'pr-merge', kind: 'merge', creatable_by: [] },
]

const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? 'ok' : r.error?.code)

async function setup(o: { supervisor?: Partial<SupervisorConfig> } = {}) {
  const home = await initTempHome('flow-merge-req-')
  const restore = isolateHub(home)
  const repo = mkdtempSync(join(tmpdir(), 'flow-merge-repo-'))
  const clock = new FakeClock(Date.parse('2026-10-26T08:00:00.000Z'))
  const l = await tempLedger({ now: clock.now })
  const wakeTokens = createWakeTokenAuthority({ ledger: () => l.store, now: clock.now })
  const protocol = createNodeProtocol({
    ledger: l.store,
    clock,
    leaseTtlS: 600,
    leaseWaitMaxS: 0,
    issueWakeToken: (g) => wakeTokens.issue(g),
  })
  const sup: SupervisorConfig = { ...defaultSupervisorConfig(), enabled: true, ...o.supervisor }
  const config = { sup, repos: [repo] }
  const workspaces = async (ref: string) =>
    ref === WS || ref === OTHER ? { ref, repos: config.repos, supervisor: config.sup } : null
  const roleList = { roles: [...ROLES] }
  const roles: RoleLookup = async (name) => ok(roleList.roles.find((r) => r.name === name) ?? null)
  const tasks = createTaskService({
    ledger: l.store,
    workspaceExists: async (ref) => ref === WS || ref === OTHER,
    workspaces,
    roles,
    now: clock.now,
  })
  const tools: SupervisorToolsDeps = {
    ledger: l.store,
    tasks,
    home,
    workspaces,
    roles,
    verifyPolicy: async () => ok([]),
    levels: () => EMPTY_INBOX_CONFIG,
    supervisorActive: async (ws) => ws === WS || ws === OTHER,
    mergeRoles: async () => ok(roleList.roles),
    now: clock.now,
  }
  const inbox: InboxActionDeps = {
    ledger: l.store,
    tasks,
    home,
    scanProposals: async () => {},
    mergeRequests: {
      approve: (item, opts) => approveMergeRequest(tools, item, opts),
      reject: (item, opts) => rejectMergeRequest(tools, item, opts),
    },
  }
  const app = createHubApp({
    token: testToken,
    wakeTokens,
    ledger: l.store,
    mount: [
      { path: '/', app: protocol.routes },
      { path: '/', app: createSupervisorToolRoutes(tools) },
      { path: '/', app: createInboxRoutes(inbox) },
      { path: '/', app: createTaskRoutes({ ledger: l.store, tasks }) },
    ],
  })
  cleanups.push(() => {
    protocol.stop()
    l.cleanup()
    restore()
    rmSync(join(home, '..'), { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })
  must(
    protocol.service.registerNode(
      { node_id: 'nw', hostname: 'h', version: '0.0.0', capabilities: ['executor:fake', 'wake'] },
      'unknown',
    ),
  )
  let generation = 0
  /** 中枢以 hub 建唤醒任务并由节点领取，返回唤醒任务 id 与租约下发的唤醒 token。 */
  const wake = async (origin: WakeOrigin, ws = WS) => {
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
      await protocol.service.acquire(
        { node_id: 'nw', capabilities: ['executor:fake', 'wake'] },
        { actor: 'node:nw' },
      ),
    )
    const token = r.lease?.wake_token
    if (!token) throw new Error('没有下发唤醒 token')
    return { id: t.id, token }
  }

  let extId = 0
  /** 直接在账本里写一个已结束（或指定状态）的任务，用来构造 dev 与审查任务。 */
  const task = (
    contract: Record<string, unknown>,
    result: Record<string, unknown> | null,
    opts: { origin?: TaskOrigin; ws?: string; status?: 'done' | 'failed' | 'queued' } = {},
  ) => {
    clock.time += 1000
    const ws = opts.ws ?? WS
    const id = `t-ext-${String(++extId).padStart(3, '0')}`
    must(
      l.store.append(
        {
          type: 'task.created',
          task_id: id,
          workspace: ws,
          payload: {
            contract: { goal: 'g', workspace: ws, requires: [], timeout_s: 60, ...contract },
            ...(opts.origin ? { origin: opts.origin } : {}),
          },
        } as unknown as EventInput,
        { actor: 'user' },
      ),
    )
    const status = opts.status ?? 'done'
    if (status === 'queued') return id
    const base = { task_id: id, workspace: ws }
    must(
      l.store.appendMany(
        [
          {
            ...base,
            type: 'task.started',
            payload: { node_id: 'nr', lease_id: `l-${id}`, attempt: 1 },
          },
          {
            ...base,
            type: 'lease.granted',
            payload: {
              lease_id: `l-${id}`,
              node_id: 'nr',
              token_sha256: SHA,
              ttl_s: 60,
              expires_at: '2026-10-27T09:00:00.000Z',
            },
          },
          status === 'done'
            ? { ...base, type: 'task.done', payload: { result: { node_id: 'nr', ...result } } }
            : {
                ...base,
                type: 'task.failed',
                payload: { message: '失败', result: { node_id: 'nr', ...result } },
              },
        ] as EventInput[],
        { actor: 'node:nr' },
      ),
    )
    return id
  }
  /** 开出 PR 的 dev 任务（默认 origin instruction、codex-orca、cwd 为登记仓库）。 */
  const dev = (
    o: {
      origin?: TaskOrigin | undefined
      role?: string
      executor?: string
      pr?: string
      ws?: string
    } = {},
    status: 'done' | 'failed' = 'done',
  ) =>
    task(
      { role: o.role ?? 'dev', executor: o.executor ?? 'codex-orca', cwd: repo },
      {
        summary: '开了 PR',
        executor: o.executor ?? 'codex-orca',
        artifacts: [{ kind: 'pr', ref: o.pr ?? PR }],
      },
      {
        ...(o.origin === undefined && 'origin' in o ? {} : { origin: o.origin ?? 'instruction' }),
        ...(o.ws ? { ws: o.ws } : {}),
        status,
      },
    )
  /** 审查任务（默认 pr-reviewer、claude-sdk、approve）。 */
  const review = (
    o: {
      verdict?: 'approve' | 'changes_requested'
      role?: string
      pr?: string
      sha?: string
      ws?: string
      status?: 'done' | 'queued'
    } = {},
  ) => {
    const verdict = o.verdict ?? 'approve'
    return task(
      {
        role: o.role ?? 'pr-reviewer',
        executor: 'claude-sdk',
        inputs: { review: { pr: o.pr ?? PR } },
      },
      {
        summary: '审查完成',
        executor: 'claude-sdk',
        review: {
          verdict,
          blocking: verdict === 'approve' ? [] : ['有问题'],
          notes: '看过了',
          reviewed_sha: o.sha ?? SHA_A,
        },
      },
      { origin: 'instruction', ...(o.ws ? { ws: o.ws } : {}), status: o.status ?? 'done' },
    )
  }
  /** MCP 中 supervisor 的操作上下文：以唤醒 token 访问进程内的中枢应用。 */
  const ctx = (token: string) => ({
    home,
    actor: 'supervisor',
    via: 'mcp' as const,
    token,
    fetch: (req: Request) => app.fetch(req),
  })
  const post = (path: string, body: unknown, token = testToken, actor?: string) =>
    app.request(path, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(actor ? { 'X-Flow-Actor': actor } : {}),
      },
      body: JSON.stringify(body),
    })
  const request = (token: string, reviewTask: string, pr = PR) =>
    prMergeRequestOp.run({ pr, review_task: reviewTask }, ctx(token))
  const events = (type: LedgerEvent['type']) =>
    l.store.eventsAfter(0, {}, 10_000).filter((e) => e.type === type)
  return {
    home,
    repo,
    clock,
    config,
    roleList,
    ledger: l.store,
    tools,
    inbox,
    wake,
    dev,
    review,
    task,
    ctx,
    post,
    request,
    events,
  }
}

type Setup = Awaited<ReturnType<typeof setup>>

/** 走完资格核对、生成合并审批条目，返回条目。 */
async function pendingItem(s: Setup): Promise<{ item: InboxItemView; rv: string; devId: string }> {
  const devId = s.dev()
  const rv = s.review()
  const w = await s.wake('instruction')
  const r = must(await s.request(w.token, rv))
  if (!r.item) throw new Error('没有生成条目')
  return { item: r.item, rv, devId }
}

const reasonsOf = (r: Result<unknown>) =>
  r.ok ? [] : ((r.error.details as { reasons?: string[] } | undefined)?.reasons ?? [])

describe('合并请求的资格（D10 第 4 步）', () => {
  test('默认需要批准：生成 Decide 条目，展示 PR、审查结论与 reviewed_sha；未批准前不建 merger', async () => {
    const s = await setup()
    const devId = s.dev()
    const rv = s.review()
    const w = await s.wake('instruction')
    const r = must(await s.request(w.token, rv))
    expect(r.mode).toBe('approval')
    expect(r.task).toBeUndefined()
    expect(r.item).toMatchObject({
      source: 'merge_request',
      level: 'decide',
      source_ref: r.request_id,
      workspace: WS,
      actions: ['approve', 'reject'],
      state: 'open',
      created_by: 'hub',
    })
    expect(r.item?.body).toContain(PR)
    expect(r.item?.body).toContain(SHA_A)
    expect(r.item?.body).toContain('审查结论：approve')
    const [created] = s.events('merge_request.created')
    expect(created).toMatchObject({
      actor: 'hub',
      workspace: WS,
      payload: {
        request_id: r.request_id,
        wake_task_id: w.id,
        pr: PR,
        review_task: rv,
        dev_task: devId,
        reviewed_sha: SHA_A,
        auto_merge: false,
        item_id: r.item?.id,
      },
    })
    expect(s.ledger.findTaskByIdempotencyKey(`merge:${rv}`)).toBeNull()
  })

  test('巡检链上的 PR（外部贡献者、无 origin、autonomous）→ merge_not_eligible，不写事件', async () => {
    const s = await setup()
    const other = 'https://github.com/acme/demo/pull/99'
    const rv = s.review({ pr: other })
    const w = await s.wake('autonomous')
    const before = s.ledger.seq()
    // 没有任何任务产出这个 PR（外部贡献者）
    const none = await s.request(w.token, rv, other)
    expect(code(none)).toBe('merge_not_eligible')
    expect(reasonsOf(none).join()).toContain('没有任务产出该 PR')
    // 产出它的任务没有 origin（用户手动建）或是 autonomous
    s.dev({ pr: other, origin: undefined })
    s.dev({ pr: other, origin: 'autonomous' })
    const r = await s.request(w.token, rv, other)
    expect(code(r)).toBe('merge_not_eligible')
    expect(reasonsOf(r).join()).toContain('origin 为 autonomous')
    // 只有构造 dev 任务的事件，合并请求本身不写任何事件
    expect(s.events('merge_request.created')).toHaveLength(0)
    expect(s.ledger.eventsAfter(before, {}, 100).every((e) => e.task_id !== undefined)).toBe(true)
  })

  test('开出 PR 的任务必须 done、有效类别 write、角色可加载；唤醒与 merger 的产物不算', async () => {
    const s = await setup()
    const rv = s.review()
    const w = await s.wake('instruction')
    s.dev({}, 'failed')
    s.dev({ role: 'triage', executor: 'claude-sdk' }) // read
    s.dev({ role: 'ghost' }) // 角色未定义：无法确认有效类别
    s.task(
      { role: 'merger', executor: 'pr-merge', inputs: { merge: { pr: PR, review_task: rv } } },
      { summary: '合并', executor: 'pr-merge', artifacts: [{ kind: 'pr', ref: PR }] },
      { origin: 'instruction' },
    )
    const r = await s.request(w.token, rv)
    expect(code(r)).toBe('merge_not_eligible')
    const why = reasonsOf(r).join()
    expect(why).toContain('不是 done')
    expect(why).toContain('有效类别为 read')
    expect(why).toContain('角色 ghost 未定义')
    expect(why).toContain('是合并任务')
    // 补上一个合格的 dev 任务后通过
    s.dev()
    expect(code(await s.request(w.token, rv))).toBe('ok')
  })

  test('审查任务：不是 approve、角色不在 reviewer_roles、审查的是别的 PR、其他 workspace、不存在 → merge_not_eligible', async () => {
    const s = await setup()
    s.dev()
    const w = await s.wake('instruction')
    const cases: [string, string][] = [
      [s.review({ verdict: 'changes_requested' }), '审查结论为 changes_requested'],
      [s.review({ role: 'reviewer' }), '不在 supervisor.reviewer_roles'],
      [s.review({ pr: 'https://github.com/acme/demo/pull/8' }), '审查的是'],
      [s.review({ ws: OTHER }), `属于 ${OTHER}`],
      ['t-missing', '不存在'],
    ]
    for (const [rv, reason] of cases) {
      const r = await s.request(w.token, rv)
      expect(code(r)).toBe('merge_not_eligible')
      expect(reasonsOf(r).join()).toContain(reason)
    }
  })

  test('必须是该 PR 最新一次可信审查；同一 PR 有未结束的审查任务时不合格', async () => {
    const s = await setup()
    s.dev()
    const w = await s.wake('instruction')
    const old = s.review()
    const newer = s.review({ verdict: 'changes_requested', sha: SHA_B })
    const r = await s.request(w.token, old)
    expect(code(r)).toBe('merge_not_eligible')
    expect(reasonsOf(r).join()).toContain(`最新为 ${newer}`)
    // 不在 reviewer_roles 的审查不影响"最新"
    const latest = s.review({ sha: SHA_B })
    s.review({ role: 'reviewer', verdict: 'changes_requested' })
    expect(code(await s.request(w.token, latest))).toBe('ok')
    // 又排了一次审查：未结束前不合格（新的结论可能推翻）
    const s2 = await setup()
    s2.dev()
    const w2 = await s2.wake('instruction')
    const ok2 = s2.review()
    const pending = s2.review({ status: 'queued' })
    const r2 = await s2.request(w2.token, ok2)
    expect(code(r2)).toBe('merge_not_eligible')
    expect(reasonsOf(r2).join()).toContain(`未结束的审查任务 ${pending}`)
  })

  test('PR 链接按 samePrUrl 比较：www.github.com 与大小写视为同一个 PR，条目与 merger 用规范形式', async () => {
    const s = await setup()
    s.dev({ pr: 'https://github.com/Acme/Demo/pull/7' })
    const rv = s.review()
    const w = await s.wake('instruction')
    const r = must(await s.request(w.token, rv, 'https://www.github.com/ACME/demo/pull/7'))
    expect(s.events('merge_request.created')[0]?.payload).toMatchObject({ pr: PR })
    expect(r.item?.title).toContain(PR)
  })

  test('workspace 未启用 supervisor → merge_not_eligible；merger 仓库无法唯一确定 → merge_not_eligible', async () => {
    const s = await setup()
    s.dev()
    const rv = s.review()
    const w = await s.wake('instruction')
    s.config.sup = { ...s.config.sup, enabled: false }
    expect(reasonsOf(await s.request(w.token, rv)).join()).toContain('未启用 supervisor')
    s.config.sup = { ...s.config.sup, enabled: true }
    // dev 任务的 cwd 不再是登记仓库（仓库配置改了）
    s.config.repos = [mkdtempSync(join(tmpdir(), 'flow-merge-other-'))]
    cleanups.push(() => rmSync(s.config.repos[0] as string, { recursive: true, force: true }))
    const r = await s.request(w.token, rv)
    expect(code(r)).toBe('merge_not_eligible')
    expect(reasonsOf(r).join()).toContain('不在 ws/product-res 登记的仓库内')
  })
})

describe('调用方（D6、D7）', () => {
  test('只有非 reply 的 supervisor 唤醒 token：其他身份 role_not_allowed，reply 唤醒 reply_only_wake', async () => {
    const s = await setup()
    s.dev()
    const rv = s.review()
    const body = { pr: PR, review_task: rv }
    for (const actor of [undefined, 'reviewer']) {
      const res = await s.post('/v1/merge-requests', body, testToken, actor)
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ error: { code: 'role_not_allowed' } })
    }
    // 本地预检同样拒绝其他 AI 身份
    expect(code(await prMergeRequestOp.run(body, { ...s.ctx('x'), actor: 'dev' }))).toBe(
      'role_not_allowed',
    )
    const reply = await s.wake('reply')
    expect(code(await s.request(reply.token, rv))).toBe('reply_only_wake')
    // 其他 workspace 的唤醒：审查与 dev 都不在它的 workspace 内
    const foreign = await s.wake('instruction', OTHER)
    expect(code(await s.request(foreign.token, rv))).toBe('merge_not_eligible')
    expect(s.events('merge_request.created')).toHaveLength(0)
  })

  test('唤醒已结束 → scope_denied', async () => {
    const s = await setup()
    s.dev()
    const rv = s.review()
    const w = await s.wake('instruction')
    must(s.tools.tasks.cancelTask(w.id, { actor: 'user' }))
    must(
      s.ledger.append(
        { type: 'task.cancelled', task_id: w.id, workspace: WS, payload: {} },
        { actor: 'node:nw' },
      ),
    )
    expect(s.ledger.getTask(w.id)?.status).toBe('cancelled')
    const r = await s.request(w.token, rv)
    expect(['scope_denied', 'unauthorized']).toContain(code(r) as string)
    expect(s.events('merge_request.created')).toHaveLength(0)
  })

  test('merge: 幂等键是保留前缀：user 与 supervisor 都不能使用', async () => {
    const s = await setup()
    const w = await s.wake('instruction')
    const contract = {
      goal: 'x',
      workspace: WS,
      role: 'merger',
      executor: 'pr-merge',
      idempotency_key: 'Merge:t-1',
    }
    const asUser = await s.post('/v1/tasks', contract)
    expect(await asUser.json()).toMatchObject({ error: { code: 'reserved_idempotency_key' } })
    const asWake = await s.post('/v1/tasks', { ...contract, role: 'dev' }, w.token)
    expect(await asWake.json()).toMatchObject({ error: { code: 'reserved_idempotency_key' } })
  })
})

describe('批准与驳回（只有 user）', () => {
  test('用户批准：写 merge_request.approved（user），以 hub 建 merger（parent 审查、origin instruction、inputs.merge、timeout ≥ 2400、cwd 登记仓库），条目关闭', async () => {
    const s = await setup()
    const { item, rv } = await pendingItem(s)
    const r = must(
      await actOnInbox(s.inbox, item.id, { action: 'approve', via: 'telegram' }, 'user'),
    )
    expect(r.item).toMatchObject({
      state: 'closed',
      closed: { reason: 'acted', by: 'user', cause_actor: 'user' },
    })
    const [approved] = s.events('merge_request.approved')
    expect(approved).toMatchObject({
      actor: 'user',
      payload: { item_id: item.id, pr: PR, review_task: rv, approved_by: 'user', via: 'telegram' },
    })
    const merger = s.ledger.findTaskByIdempotencyKey(`merge:${rv}`)
    expect(merger).toMatchObject({
      created_by: 'hub',
      origin: 'instruction',
      workspace: WS,
      status: 'queued',
      contract: {
        role: 'merger',
        executor: 'pr-merge',
        parent: rv,
        cwd: s.repo,
        inputs: { merge: { pr: PR, review_task: rv } },
      },
    })
    expect(merger?.contract.timeout_s).toBeGreaterThanOrEqual(MIN_MERGER_TIMEOUT_S)
    expect(MIN_MERGER_TIMEOUT_S).toBe(2400)
    // 批准事件早于 merger 的创建
    expect(approved?.seq).toBeLessThan(s.events('task.created').at(-1)?.seq ?? 0)
  })

  test('supervisor 不能批准或驳回合并（2.7）：403 user_only，不建 merger', async () => {
    const s = await setup()
    const { item, rv } = await pendingItem(s)
    const w = await s.wake('instruction')
    for (const action of ['approve', 'reject']) {
      const res = await s.post(`/v1/inbox/${item.id}/act`, { action }, w.token)
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ error: { code: 'user_only' } })
    }
    // 也不能忽略（条目由 hub 写入，不是它自己的提问）
    const dismiss = await s.post(`/v1/inbox/${item.id}/act`, { action: 'dismiss' }, w.token)
    expect(dismiss.status).toBe(403)
    expect(s.ledger.findTaskByIdempotencyKey(`merge:${rv}`)).toBeNull()
    expect(s.events('merge_request.approved')).toHaveLength(0)
    expect(s.ledger.getInboxItem(item.id)?.state).toBe('open')
  })

  test('驳回：写 merge_request.rejected（user）、条目关闭，唤醒调度器把它放进 instruction 队列；之后可重新请求', async () => {
    const s = await setup()
    const { item, rv } = await pendingItem(s)
    must(
      await actOnInbox(
        s.inbox,
        item.id,
        { action: 'reject', text: '等发布窗口', via: 'web' },
        'user',
      ),
    )
    const [rejected] = s.events('merge_request.rejected')
    expect(rejected).toMatchObject({
      actor: 'user',
      workspace: WS,
      payload: { item_id: item.id, pr: PR, review_task: rv, note: '等发布窗口', via: 'web' },
    })
    expect(s.ledger.getInboxItem(item.id)).toMatchObject({
      state: 'closed',
      closed: { reason: 'acted', by: 'user', cause_actor: 'user' },
    })
    expect(s.ledger.findTaskByIdempotencyKey(`merge:${rv}`)).toBeNull()
    const p = new WakeProjection({ item: () => null })
    for (const e of s.events('supervisor.wake_started')) p.apply(e)
    expect(p.classify(rejected as LedgerEvent)).toBe('instruction')
    // 驳回后同一审查可以再请求一次
    const w = await s.wake('instruction')
    expect(code(await s.request(w.token, rv))).toBe('ok')
  })

  test('同一审查任务只能有一个未结束的合并请求', async () => {
    const s = await setup()
    const { rv } = await pendingItem(s)
    const w = await s.wake('instruction')
    const dup = await s.request(w.token, rv)
    expect(code(dup)).toBe('conflict')
    expect(s.events('merge_request.created')).toHaveLength(1)
  })

  test('批准时再核对资格：之后又有新的审查 → merge_not_eligible，条目保持打开；仍可驳回', async () => {
    const s = await setup()
    const { item, rv } = await pendingItem(s)
    s.review({ verdict: 'changes_requested', sha: SHA_B })
    const r = await actOnInbox(s.inbox, item.id, { action: 'approve' }, 'user')
    expect(code(r)).toBe('merge_not_eligible')
    expect(s.ledger.getInboxItem(item.id)?.state).toBe('open')
    expect(s.events('merge_request.approved')).toHaveLength(0)
    expect(s.ledger.findTaskByIdempotencyKey(`merge:${rv}`)).toBeNull()
    must(await actOnInbox(s.inbox, item.id, { action: 'reject' }, 'user'))
  })

  test('merger 角色按有效类别 merge 查找且唯一：没有或有多个 → merge_not_eligible；补齐后重新批准完成，不能再驳回', async () => {
    const s = await setup()
    const { item, rv } = await pendingItem(s)
    s.roleList.roles = ROLES.filter((r) => r.name !== 'merger')
    const none = await approveMergeRequest(s.tools, item, { via: 'cli' })
    expect(code(none)).toBe('merge_not_eligible')
    expect(reasonsOf(none).join()).toContain('没有有效类别为 merge 的角色')
    s.roleList.roles = [
      ...ROLES,
      { name: 'merger2', executor: 'pr-merge', creatable_by: [] }, // 按执行器推断为 merge
    ]
    expect(reasonsOf(await approveMergeRequest(s.tools, item, { via: 'cli' })).join()).toContain(
      '有多个有效类别为 merge 的角色',
    )
    // 已经批准（批准事件已写入），merger 还没建出：不能驳回，只能重新批准或忽略
    expect(code(await rejectMergeRequest(s.tools, item, { via: 'cli' }))).toBe('invalid_transition')
    s.roleList.roles = [...ROLES]
    must(await approveMergeRequest(s.tools, item, { via: 'cli' }))
    // 批准事件只写一次；merger 只有一个
    expect(s.events('merge_request.approved')).toHaveLength(1)
    expect(s.ledger.findTaskByIdempotencyKey(`merge:${rv}`)?.created_by).toBe('hub')
    expect(s.ledger.getInboxItem(item.id)?.state).toBe('closed')
  })

  test('幂等命中的 merger 不是本审查的（不可能经接口抢注，这里直接写账本模拟）→ conflict', async () => {
    const s = await setup()
    const { item, rv } = await pendingItem(s)
    must(
      s.ledger.append(
        {
          type: 'task.created',
          task_id: 't-squat',
          workspace: WS,
          payload: {
            contract: {
              goal: 'x',
              workspace: WS,
              role: 'merger',
              executor: 'pr-merge',
              requires: [],
              timeout_s: 3600,
              idempotency_key: `merge:${rv}`,
            },
          },
        } as unknown as EventInput,
        { actor: 'user' },
      ),
    )
    const r = await approveMergeRequest(s.tools, item, { via: 'cli' })
    expect(code(r)).toBe('conflict')
    expect(s.ledger.getInboxItem(item.id)?.state).toBe('open')
  })
})

describe('自动合并与收尾', () => {
  test('auto_merge: true → 资格通过后直接以 hub 建 merger，与 merge_request.created 同一事务；不生成条目', async () => {
    const s = await setup({ supervisor: { auto_merge: true } })
    const devId = s.dev()
    const rv = s.review()
    const w = await s.wake('instruction')
    const r = must(await s.request(w.token, rv))
    expect(r.mode).toBe('auto')
    expect(r.item).toBeUndefined()
    expect(r.task).toMatchObject({
      created_by: 'hub',
      origin: 'instruction',
      contract: {
        parent: rv,
        executor: 'pr-merge',
        inputs: { merge: { pr: PR, review_task: rv } },
      },
    })
    const [created] = s.events('merge_request.created')
    expect(created).toMatchObject({
      actor: 'hub',
      payload: { auto_merge: true, merger_task: r.task?.id, dev_task: devId },
    })
    const taskCreated = s.events('task.created').find((e) => e.task_id === r.task?.id)
    expect(created?.seq).toBe((taskCreated?.seq ?? 0) + 1)
    expect(s.ledger.listInboxItems({}).filter((i) => i.source === 'merge_request')).toHaveLength(0)
    // 同一审查不能再建第二个 merger
    const again = await s.request(w.token, rv)
    expect(code(again)).toBe('conflict')
    expect(s.events('merge_request.created')).toHaveLength(1)
  })

  test('merger 结束（done / failed(pr_not_open)）进 instruction 队列唤醒 supervisor', async () => {
    const s = await setup({ supervisor: { auto_merge: true } })
    s.dev()
    const rv = s.review()
    const w = await s.wake('instruction')
    const merger = must(await s.request(w.token, rv)).task
    if (!merger) throw new Error('没有 merger')
    const base = { task_id: merger.id, workspace: WS }
    must(
      s.ledger.appendMany(
        [
          {
            ...base,
            type: 'task.started',
            payload: { node_id: 'nm', lease_id: 'l-m', attempt: 1 },
          },
          {
            ...base,
            type: 'lease.granted',
            payload: {
              lease_id: 'l-m',
              node_id: 'nm',
              token_sha256: SHA,
              ttl_s: 60,
              expires_at: '2026-10-27T09:00:00.000Z',
            },
          },
          {
            ...base,
            type: 'task.failed',
            payload: {
              message: 'PR 状态为 MERGED，不是 OPEN',
              result: {
                summary: '未合并',
                executor: 'pr-merge',
                node_id: 'nm',
                reason: 'pr_not_open',
              },
            },
          },
        ] as EventInput[],
        { actor: 'node:nm' },
      ),
    )
    const p = new WakeProjection({ item: () => null })
    const all = s.ledger.eventsAfter(0, {}, 10_000)
    for (const e of all) p.apply(e)
    const failed = all.find((e) => e.type === 'task.failed' && e.task_id === merger.id)
    expect(p.classify(failed as LedgerEvent)).toBe('instruction')
    expect(
      [...p.workspace(WS).queues.instruction.pending.values()].some((q) => q.task_id === merger.id),
    ).toBe(true)
  })
})
