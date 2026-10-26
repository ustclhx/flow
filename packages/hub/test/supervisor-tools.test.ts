import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  askUserOp,
  decisionReviewOp,
  defaultSupervisorConfig,
  EMPTY_INBOX_CONFIG,
  localDate,
  ok,
  parseFrontmatter,
  renderEntry,
  taskProposeOp,
  type VerifyStep,
  type WakeOrigin,
  writeEntry,
} from '@flow/core'
import { initTempHome, isolateHub } from '../../core/test/helpers.ts'
import {
  acceptTaskProposal,
  actOnInbox,
  createHubApp,
  createInboxRoutes,
  createNodeProtocol,
  createProposalWatcher,
  createSupervisorToolRoutes,
  createTaskRoutes,
  createTaskService,
  createUiApp,
  createUiLoginCodeRoutes,
  createUiSessions,
  createWakeTokenAuthority,
  type EventInput,
  expireQuestions,
  type InboxActionDeps,
  type MergeRequestHandler,
  QUESTION_TTL_MS,
  type RoleLookup,
  rejectTaskProposal,
  reviewDue,
  type SupervisorToolsDeps,
  scanDecisionReviews,
  toOutbound,
} from '../src/index.ts'
import { must, tempLedger } from './ledger-helpers.ts'
import { FakeClock, testToken } from './server-fixtures.ts'

/**
 * supervisor 的提问、任务提案与决策回看（add-m1-supervisor D11；tasks 4.4–4.7）：
 * 真实签发的唤醒 token → 鉴权中间件 → 路由 → 账本 / 写入层。
 */

const WS = 'ws/product-res'
const OTHER = 'ws/xuanxue-saas'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c()
})

const readOnly = {
  setting_sources: [],
  allowedTools: ['Read', 'Grep', 'Glob'],
  disallowedTools: ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
}

const roles: RoleLookup = async (name) => {
  switch (name) {
    case 'supervisor':
      return ok({
        name,
        executor: 'claude-sdk',
        kind: 'supervisor' as const,
        permissions: readOnly,
        creatable_by: ['*'],
      })
    case 'dev':
      return ok({ name, executor: 'codex-orca', creatable_by: ['supervisor'] })
    case 'merger':
      return ok({ name, executor: 'pr-merge', creatable_by: ['*'] })
    default:
      return ok(null)
  }
}

const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? 'ok' : r.error?.code)

async function setup(o: { supervisorActive?: (ws: string) => Promise<boolean> } = {}) {
  const home = await initTempHome('flow-sv-tools-')
  const restore = isolateHub(home)
  const repo = mkdtempSync(join(tmpdir(), 'flow-sv-repo-'))
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
  const workspaces = async (ref: string) =>
    ref === WS || ref === OTHER
      ? { ref, repos: [repo], supervisor: defaultSupervisorConfig() }
      : null
  /** 验收命令的策略判定：测试中切换。 */
  const verify = { allow: true }
  const verifyPolicy = async (_scope: unknown, steps: readonly VerifyStep[]) =>
    ok(
      steps.map((s, index) => ({
        index,
        command: s.cmd.join(' '),
        allowed: verify.allow,
        level: verify.allow ? ('auto' as const) : ('draft-approve' as const),
      })),
    )
  const tasks = createTaskService({
    ledger: l.store,
    workspaceExists: async (ref) => ref === WS || ref === OTHER,
    workspaces,
    roles,
    verifyPolicy,
    now: clock.now,
  })
  const tools: SupervisorToolsDeps = {
    ledger: l.store,
    tasks,
    home,
    workspaces,
    roles,
    verifyPolicy,
    levels: () => EMPTY_INBOX_CONFIG,
    webUrl: (id) => `http://127.0.0.1:7477/ui#item-${id}`,
    supervisorActive: o.supervisorActive ?? (async (ws) => ws === WS),
    now: clock.now,
  }
  const merges: string[] = []
  const mergeRequests: MergeRequestHandler = {
    approve: async (item) => {
      merges.push(`approve:${item.id}`)
      return ok(null)
    },
    reject: async (item) => {
      merges.push(`reject:${item.id}`)
      return ok(null)
    },
  }
  const inbox: InboxActionDeps = {
    ledger: l.store,
    tasks,
    home,
    scanProposals: async () => {},
    taskProposals: {
      accept: (item, opts) => acceptTaskProposal(tools, item, opts),
      reject: (item, opts) => rejectTaskProposal(tools, item, opts),
    },
    mergeRequests,
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
  const wake = async (origin: WakeOrigin, opts: { ws?: string; events?: number[] } = {}) => {
    const ws = opts.ws ?? WS
    const events = opts.events ?? []
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
              payload: { task_id: id, workspace: ws, origin, events, generation: g },
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
  /** MCP 中 supervisor 的操作上下文：以唤醒 token 访问进程内的中枢应用。 */
  const ctx = (token: string) => ({
    home,
    actor: 'supervisor',
    via: 'mcp' as const,
    token,
    fetch: (req: Request) => app.fetch(req),
  })
  /** 以 token 直接调用中枢路由。 */
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
  return { home, repo, clock, ledger: l.store, tools, inbox, app, wake, ctx, post, verify, merges }
}

describe('ask_user（4.4）', () => {
  test('创建 supervisor 提问条目：Decide、source_ref 为唤醒、动作 reply、附选项；唤醒不挂起', async () => {
    const { ledger, wake, ctx } = await setup()
    const w = await wake('instruction')
    const r = must(
      await askUserOp.run(
        { workspace: 'product-res', question: '用哪个缓存方案？', options: ['A', 'B'] },
        ctx(w.token),
      ),
    )
    expect(r.item).toMatchObject({
      source: 'supervisor',
      level: 'decide',
      source_ref: w.id,
      workspace: WS,
      actions: ['reply'],
      options: ['A', 'B'],
      state: 'open',
    })
    expect(r.item.body).toContain('1. A')
    expect(ledger.getTask(w.id)?.status).toBe('running')
  })

  test('其他 AI 身份 role_not_allowed；reply 唤醒 reply_only_wake；跨 workspace workspace_mismatch', async () => {
    const { wake, ctx, post } = await setup()
    const asReviewer = await askUserOp.run(
      { workspace: 'product-res', question: '?' },
      { ...ctx('x'), actor: 'reviewer' },
    )
    expect(code(asReviewer)).toBe('role_not_allowed')
    // 中枢同样按身份拒绝（user token 降级为 reviewer）。
    const res = await post(
      '/v1/supervisor/questions',
      { workspace: WS, question: '?' },
      testToken,
      'reviewer',
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: { code: 'role_not_allowed' } })
    const reply = await wake('reply')
    expect(code(await askUserOp.run({ workspace: WS, question: '?' }, ctx(reply.token)))).toBe(
      'reply_only_wake',
    )
    const w = await wake('instruction')
    expect(
      code(await askUserOp.run({ workspace: 'xuanxue-saas', question: '?' }, ctx(w.token))),
    ).toBe('workspace_mismatch')
  })

  test('未回答提问达到上限 too_many_questions', async () => {
    const { wake, ctx } = await setup()
    const w = await wake('instruction')
    for (let i = 0; i < 3; i++) {
      must(await askUserOp.run({ workspace: WS, question: `问题 ${i}` }, ctx(w.token)))
    }
    const r = await askUserOp.run({ workspace: WS, question: '第四个' }, ctx(w.token))
    expect(code(r)).toBe('too_many_questions')
  })

  test('用户回复：条目 answered，写 supervisor.answered；supervisor 不能回复', async () => {
    const { ledger, inbox, wake, ctx, post } = await setup()
    const w = await wake('instruction')
    const { item } = must(
      await askUserOp.run(
        { workspace: WS, question: '选哪个？', options: ['A', 'B'] },
        ctx(w.token),
      ),
    )
    const denied = await post(`/v1/inbox/${item.id}/act`, { action: 'reply', text: 'B' }, w.token)
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ error: { code: 'user_only' } })
    must(
      await actOnInbox(
        inbox,
        item.short_id,
        { action: 'reply', text: 'B', via: 'telegram' },
        'user',
      ),
    )
    const after = ledger.getInboxItem(item.id)
    expect(after?.closed).toMatchObject({
      reason: 'answered',
      cause_actor: 'user',
      via: 'telegram',
    })
    const answered = ledger.recentEvents(WS, ['supervisor.answered'], 5)
    expect(answered).toHaveLength(1)
    expect(answered[0]).toMatchObject({
      actor: 'user',
      payload: { item_id: item.id, text: 'B', via: 'telegram' },
    })
  })

  test('7 天未回答关闭为 expired（唤醒事件），之前不关闭', async () => {
    const { ledger, wake, ctx, clock } = await setup()
    const w = await wake('instruction')
    const { item } = must(
      await askUserOp.run({ workspace: WS, question: '还在吗？' }, ctx(w.token)),
    )
    expect(expireQuestions(ledger, clock.now() + QUESTION_TTL_MS - 1000)).toEqual([])
    expect(expireQuestions(ledger, clock.now() + QUESTION_TTL_MS)).toEqual([item.id])
    expect(ledger.getInboxItem(item.id)?.closed).toMatchObject({ reason: 'expired', by: 'hub' })
  })
})

describe('task_propose 与收件箱接受 / 驳回（4.5、4.6）', () => {
  const draft = (repo: string, over: Record<string, unknown> = {}) => ({
    goal: '把缓存 TTL 调成 10 分钟',
    workspace: WS,
    role: 'dev',
    executor: 'codex-orca',
    cwd: repo,
    verify: [{ cmd: ['pnpm', 'test'] }],
    ...over,
  })

  test('提交带决策的提案：条目展示角色、执行器、仓库与 cwd、验收命令、目标、决策与 Web 链接', async () => {
    const { ledger, repo, wake, ctx } = await setup()
    const w = await wake('autonomous')
    const r = must(
      await taskProposeOp.run(
        {
          draft: draft(repo) as never,
          reason: '巡检发现缓存命中率低',
          title: 'Cache TTL',
          expected_outcome: '命中率提升到 90%',
          metric: '缓存命中率',
          review_date: '2026-11-25',
        },
        ctx(w.token),
      ),
    )
    expect(r.item).toMatchObject({
      source: 'task_proposal',
      level: 'decide',
      source_ref: r.proposal_id,
      actions: ['accept', 'reject'],
    })
    for (const s of [
      '角色：dev',
      '执行器：codex-orca',
      `cwd：${repo}`,
      'pnpm test',
      '把缓存 TTL 调成 10 分钟',
      '命中率提升到 90%',
      '2026-11-25',
      'http://127.0.0.1:7477/ui#item-',
    ]) {
      expect(r.item.body).toContain(s)
    }
    const created = ledger.eventsByPayload('task_proposal.created', 'proposal_id', r.proposal_id)
    expect(created[0]).toMatchObject({ actor: 'hub', payload: { wake_task_id: w.id } })
  })

  test('草稿校验：merger → role_not_allowed；相对 cwd 与越界回看日期 → invalid_arguments；仓库外 → repo_not_in_workspace', async () => {
    const { repo, wake, ctx } = await setup()
    const w = await wake('autonomous')
    const run = (d: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      taskProposeOp.run({ draft: d as never, ...extra }, ctx(w.token))
    expect(code(await run(draft(repo, { role: 'merger', executor: 'pr-merge' })))).toBe(
      'role_not_allowed',
    )
    expect(code(await run(draft(repo, { cwd: 'relative/dir' })))).toBe('invalid_arguments')
    expect(code(await run(draft(repo, { cwd: tmpdir() })))).toBe('repo_not_in_workspace')
    expect(
      code(
        await run(draft(repo), {
          title: 't',
          expected_outcome: 'e',
          metric: 'm',
          review_date: '2027-12-31',
        }),
      ),
    ).toBe('invalid_arguments')
    expect(code(await run(draft(repo), { title: 't' }))).toBe('invalid_arguments')
    expect(code(await run(draft(repo, { workspace: OTHER })))).toBe('workspace_mismatch')
    const reply = await wake('reply')
    expect(code(await taskProposeOp.run({ draft: draft(repo) as never }, ctx(reply.token)))).toBe(
      'reply_only_wake',
    )
  })

  test('手机上接受：user 建任务（origin instruction、parent 为唤醒），写决策并在 context 引用；supervisor 不能接受', async () => {
    const { home, ledger, inbox, repo, wake, ctx, post } = await setup()
    const w = await wake('autonomous')
    const { proposal_id, item } = must(
      await taskProposeOp.run(
        {
          draft: draft(repo) as never,
          title: 'Cache TTL',
          expected_outcome: '命中率提升到 90%',
          metric: '缓存命中率',
          review_date: '2026-11-25',
        },
        ctx(w.token),
      ),
    )
    const denied = await post(`/v1/inbox/${item.id}/act`, { action: 'accept' }, w.token)
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ error: { code: 'user_only' } })

    must(await actOnInbox(inbox, item.short_id, { action: 'accept', via: 'telegram' }, 'user'))
    expect(ledger.getInboxItem(item.id)?.closed).toMatchObject({ reason: 'proposal_accepted' })
    const accepted = ledger.eventsByPayload('task_proposal.accepted', 'proposal_id', proposal_id)[0]
    expect(accepted?.actor).toBe('user')
    if (accepted?.type !== 'task_proposal.accepted') throw new Error('缺少 accepted 事件')
    const task = ledger.getTask(accepted.payload.task_id)
    expect(task).toMatchObject({ created_by: 'user', origin: 'instruction' })
    expect(task?.contract.parent).toBe(w.id)
    const path = accepted.payload.decision_path as string
    expect(path).toMatch(/^decisions\/\d{4}-\d{2}-\d{2}-cache-ttl-[0-9a-f]+\.md$/)
    expect(task?.contract.context).toContain(path)
    const fm = parseFrontmatter(readFileSync(join(home, 'brain', path), 'utf8'))
    expect(fm.ok && fm.data.data).toMatchObject({
      type: 'decision',
      status: 'approved',
      workspace: WS,
      review_date: '2026-11-25',
      sources: [`task:${task?.id}`],
    })
  })

  test('Web 上修改目标后接受：任务用新目标，accepted 记录新目标', async () => {
    const { ledger, inbox, repo, wake, ctx } = await setup()
    const w = await wake('autonomous')
    const { proposal_id, item } = must(
      await taskProposeOp.run({ draft: draft(repo) as never }, ctx(w.token)),
    )
    must(
      await actOnInbox(
        inbox,
        item.id,
        { action: 'accept', goal: '改成 5 分钟', via: 'web' },
        'user',
      ),
    )
    const accepted = ledger.eventsByPayload('task_proposal.accepted', 'proposal_id', proposal_id)[0]
    if (accepted?.type !== 'task_proposal.accepted') throw new Error('缺少 accepted 事件')
    expect(accepted.payload.goal).toBe('改成 5 分钟')
    expect(accepted.payload.decision_path).toBeUndefined()
    expect(ledger.getTask(accepted.payload.task_id)?.contract.goal).toBe('改成 5 分钟')
  })

  test('接受时不能借 user 身份跳过 verify 判定：策略不再放行则拒绝，条目保持打开', async () => {
    const { ledger, inbox, repo, wake, ctx, verify } = await setup()
    const w = await wake('autonomous')
    const { item } = must(await taskProposeOp.run({ draft: draft(repo) as never }, ctx(w.token)))
    verify.allow = false
    const r = await actOnInbox(inbox, item.id, { action: 'accept', via: 'cli' }, 'user')
    expect(code(r)).toBe('verify_not_allowed')
    expect(ledger.getInboxItem(item.id)?.state).toBe('open')
    // 提交时就不能自动放行的提案直接拒绝。
    expect(code(await taskProposeOp.run({ draft: draft(repo) as never }, ctx(w.token)))).toBe(
      'verify_not_allowed',
    )
  })

  test('驳回：写 task_proposal.rejected，条目 proposal_rejected', async () => {
    const { ledger, inbox, repo, wake, ctx } = await setup()
    const w = await wake('autonomous')
    const { proposal_id, item } = must(
      await taskProposeOp.run({ draft: draft(repo) as never }, ctx(w.token)),
    )
    must(await actOnInbox(inbox, item.id, { action: 'reject', text: '先不做', via: 'cli' }, 'user'))
    expect(ledger.getInboxItem(item.id)?.closed).toMatchObject({ reason: 'proposal_rejected' })
    expect(
      ledger.eventsByPayload('task_proposal.rejected', 'proposal_id', proposal_id)[0],
    ).toMatchObject({
      actor: 'user',
      payload: { note: '先不做', via: 'cli' },
    })
  })

  test('来源隔离：知识提案扫描不关闭 task_proposal 条目；merge_request 路由到合并处理而不是 task_reply', async () => {
    const { home, ledger, inbox, repo, wake, ctx, merges } = await setup()
    const w = await wake('autonomous')
    const { item } = must(await taskProposeOp.run({ draft: draft(repo) as never }, ctx(w.token)))
    const watcher = createProposalWatcher({
      ledger,
      home,
      clock: { now: Date.now, setTimeout: () => () => {} },
    })
    await watcher.scan()
    watcher.stop()
    expect(ledger.getInboxItem(item.id)?.state).toBe('open')

    must(
      ledger.append(
        {
          type: 'inbox.item_created',
          workspace: WS,
          payload: {
            item_id: 'mrg.1',
            level: 'decide',
            source: 'merge_request',
            source_ref: 'https://github.com/o/r/pull/1',
            title: '合并请求',
            actions: ['approve', 'reject'],
          },
        },
        { actor: 'hub' },
      ),
    )
    expect(code(await actOnInbox(inbox, 'mrg.1', { action: 'reply', text: 'x' }, 'user'))).toBe(
      'action_not_available',
    )
    must(await actOnInbox(inbox, 'mrg.1', { action: 'approve', via: 'web' }, 'user'))
    must(await actOnInbox(inbox, 'mrg.1', { action: 'reject', via: 'web' }, 'user'))
    expect(merges).toEqual(['approve:mrg.1', 'reject:mrg.1'])
    // 没有注入合并处理时（4.8 之前）操作不可用。
    const { mergeRequests: _unused, ...bare } = inbox
    expect(code(await actOnInbox(bare, 'mrg.1', { action: 'approve' }, 'user'))).toBe(
      'action_not_available',
    )
    // supervisor 不能批准合并。
    expect(code(await actOnInbox(inbox, 'mrg.1', { action: 'approve' }, 'supervisor'))).toBe(
      'user_only',
    )
    // goal 只用于接受任务提案。
    expect(code(await actOnInbox(inbox, 'mrg.1', { action: 'approve', goal: 'x' }, 'user'))).toBe(
      'invalid_arguments',
    )
  })
})

describe('决策回看（4.7）', () => {
  const decision = (home: string, id: string, over: Record<string, unknown> = {}) =>
    writeEntry(
      home,
      {
        id: `decisions/${id}`,
        content: renderEntry(
          {
            type: 'decision',
            title: id,
            summary: '缓存决策',
            scope: 'work',
            status: 'approved',
            expected_outcome: '命中率 90%',
            metric: '命中率',
            review_date: '2026-10-20',
            workspace: WS,
            sources: ['task:t-1'],
            last_verified: null,
            ...over,
          },
          '\n决策正文\n',
        ),
      },
      { actor: 'user' },
    )

  test('reviewDue：早于今天到期；当天 09:00 之后到期', () => {
    const at = (h: number) => new Date(2026, 9, 26, h, 0, 0)
    expect(reviewDue('2026-10-25', at(1))).toBe(true)
    expect(reviewDue('2026-10-26', at(8))).toBe(false)
    expect(reviewDue('2026-10-26', at(9))).toBe(true)
    expect(reviewDue('2026-10-27', at(23))).toBe(false)
  })

  test('扫描：启用 supervisor 的写 decision.review_due（去重、补发）；无 workspace 或未启用只生成 Digest', async () => {
    const { home, ledger, tools } = await setup()
    must(await decision(home, 'a'))
    must(await decision(home, 'b', { workspace: OTHER }))
    must(await decision(home, 'c', { workspace: undefined }))
    must(await decision(home, 'd', { review_date: '2099-01-01' }))
    must(await decision(home, 'e', { status: 'reviewed' }))
    const r = must(await scanDecisionReviews(tools))
    expect(r.due).toEqual(['decisions/a.md'])
    expect(r.digest.sort()).toEqual(['decisions/b.md', 'decisions/c.md'])
    const due = ledger.eventsByPayload('decision.review_due', 'path', 'decisions/a.md')
    expect(due).toHaveLength(1)
    expect(due[0]).toMatchObject({
      actor: 'hub',
      workspace: WS,
      payload: { review_date: '2026-10-20', missed: true },
    })
    const items = ledger.listInboxItems({ source: 'decision', limit: -1 })
    expect(items.map((i) => i.level)).toEqual(['digest', 'digest'])
    expect(ledger.eventsByPayload('decision.review_due', 'path', 'decisions/b.md')).toHaveLength(0)
    // 再扫一次不重复。
    const again = must(await scanDecisionReviews(tools))
    expect(again).toEqual({ due: [], digest: [] })
  })

  test('decision_review：只能回看唤醒关联的决策；追加回看一节、只改 status 与 last_verified', async () => {
    const { home, ledger, tools, wake, ctx, clock } = await setup()
    must(await decision(home, 'a'))
    must(await decision(home, 'other'))
    must(await scanDecisionReviews(tools, {}))
    const due = ledger.eventsByPayload('decision.review_due', 'path', 'decisions/a.md')[0]
    if (!due) throw new Error('没有到期事件')
    const w = await wake('autonomous', { events: [due.seq] })
    const otherPath = join(home, 'brain', 'decisions/other.md')
    const otherBefore = readFileSync(otherPath, 'utf8')
    const wrong = await decisionReviewOp.run(
      { path: 'decisions/other.md', text: '越界回看' },
      ctx(w.token),
    )
    expect(code(wrong)).toBe('not_review_target')
    expect(readFileSync(otherPath, 'utf8')).toBe(otherBefore)

    const path = join(home, 'brain', 'decisions/a.md')
    const before = parseFrontmatter(readFileSync(path, 'utf8'))
    const r = must(
      await decisionReviewOp.run({ path: 'decisions/a.md', text: '命中率达到 92%' }, ctx(w.token)),
    )
    const today = localDate(new Date(clock.now()))
    expect(r).toMatchObject({ status: 'reviewed', last_verified: today })
    const after = parseFrontmatter(readFileSync(path, 'utf8'))
    if (!before.ok || !after.ok) throw new Error('frontmatter 解析失败')
    expect(after.data.data).toEqual({
      ...before.data.data,
      status: 'reviewed',
      last_verified: today,
    })
    expect(after.data.body).toContain(`## 回看 ${today}\n\n命中率达到 92%`)
    expect(after.data.body.startsWith(before.data.body.trimEnd())).toBe(true)
    // 已回看的决策不能再回看。
    expect(
      code(await decisionReviewOp.run({ path: 'decisions/a.md', text: '再来' }, ctx(w.token))),
    ).toBe('invalid_transition')
  })

  test('回看唤醒想建 dev 任务 → proposal_required；reply 唤醒 decision_review → reply_only_wake', async () => {
    const { home, ledger, tools, wake, ctx, post, repo } = await setup()
    must(await decision(home, 'a'))
    must(await scanDecisionReviews(tools))
    const due = ledger.eventsByPayload('decision.review_due', 'path', 'decisions/a.md')[0]
    const w = await wake('autonomous', { events: [due?.seq ?? 0] })
    const res = await post(
      '/v1/tasks',
      { goal: 'x', workspace: WS, role: 'dev', executor: 'codex-orca', cwd: repo, parent: w.id },
      w.token,
    )
    expect(await res.json()).toMatchObject({ error: { code: 'proposal_required' } })
    const reply = await wake('reply')
    expect(
      code(await decisionReviewOp.run({ path: 'decisions/a.md', text: 'x' }, ctx(reply.token))),
    ).toBe('reply_only_wake')
    expect(existsSync(join(home, 'brain', 'decisions/a.md'))).toBe(true)
  })
})

describe('Web 与渠道的呈现', () => {
  test('提问选项进入外发条目；Web 页面显示选项按钮与目标编辑，接受时带修改后的目标', async () => {
    const { ledger, inbox, repo, wake, ctx, clock } = await setup()
    const w = await wake('autonomous')
    const q = must(
      await askUserOp.run(
        { workspace: WS, question: '选哪个？', options: ['甲', '乙'] },
        ctx(w.token),
      ),
    )
    expect(toOutbound(q.item, { ledger, snippetMax: 0 }).options).toEqual(['甲', '乙'])
    const p = must(
      await taskProposeOp.run(
        {
          draft: {
            goal: '原目标',
            workspace: WS,
            role: 'dev',
            executor: 'codex-orca',
            cwd: repo,
          } as never,
        },
        ctx(w.token),
      ),
    )
    const PORT = 47_124
    const HOST = `127.0.0.1:${PORT}`
    const sessions = createUiSessions({ now: clock.now })
    const ui = createHubApp({
      token: testToken,
      mount: [
        { path: '/', app: createUiLoginCodeRoutes(sessions) },
        { path: '/', app: createUiApp({ sessions, inbox, port: () => PORT, now: clock.now }) },
      ],
    })
    const issued = await ui.request('/v1/ui/login-code', {
      method: 'POST',
      headers: { Authorization: `Bearer ${testToken}`, 'Content-Type': 'application/json' },
      body: '{}',
    })
    const { data } = (await issued.json()) as { data: { login_path: string } }
    const login = await ui.request(data.login_path, { headers: { Host: HOST } })
    const cookie = /flow_ui_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1]
    const headers = { Host: HOST, Cookie: `flow_ui_session=${cookie}` }
    const html = await (await ui.request('/ui/items', { headers })).text()
    expect(html).toContain('data-option="甲"')
    expect(html).toContain('data-goal')
    expect(html).toContain('原目标')
    const res = await ui.request(`/ui/items/${encodeURIComponent(p.item.id)}/act`, {
      method: 'POST',
      headers: { ...headers, Origin: `http://${HOST}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'accept', goal: '新目标' }),
    })
    expect(res.status).toBe(200)
    const accepted = ledger.eventsByPayload(
      'task_proposal.accepted',
      'proposal_id',
      p.proposal_id,
    )[0]
    expect(accepted).toMatchObject({ payload: { goal: '新目标', via: 'web' } })
  })
})
