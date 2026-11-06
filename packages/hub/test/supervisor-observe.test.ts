import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultSupervisorConfig,
  describeSupervisorConfig,
  type EventOf,
  type LedgerEvent,
  ok,
  type Role,
  type SupervisorConfig,
  type SupervisorObserveConfig,
  supervisorConfigSchema,
  type TaskRespondRequest,
} from '@raindown/core'
import {
  createDelegationService,
  createHubApp,
  createNodeProtocol,
  createSupervisorRoutes,
  createSupervisorToolRoutes,
  createTaskRoutes,
  createTaskService,
  createWakeScheduler,
  createWakeTokenAuthority,
  type LedgerStore,
  type NodeProtocol,
  OBSERVE_LINE_PREFIX,
  type RoleLookup,
  type SupervisorToolsDeps,
  startInbox,
  summarizeArgs,
  supervisorReport,
  toOutbound,
  type WakeCaller,
  type WakeScheduler,
  type WorkspaceInfo,
} from '../src/index.ts'
import { MemoryChannel, specOf } from './channel-fixtures.ts'
import { contractInput, must, tempLedger } from './ledger-helpers.ts'
import { authHeaders, FakeClock, testToken, tick } from './server-fixtures.ts'

/**
 * add-harness-neutral-coordination 7.1、7.2、7.4（D10）：observe 配置、代答 / 代批 observe 与安全不变量
 * （observe 判断绝不送达 worker：续约下发、reply_fetched、带回复重新排队、任务绑定的 task_show / event_get），
 * 用户随后的实际回复照常送达，`supervisor report` 的一致率。
 */

const WS = 'ws/demo'
const T0 = new Date(2026, 10, 6, 10, 0).getTime()
const ALL_TIME = { since: '2000-01-01T00:00:00.000Z', until: '2100-01-01T00:00:00.000Z' }

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

const READ_PERMS = {
  setting_sources: [],
  allowedTools: ['Read', 'Grep', 'Glob'],
  disallowedTools: ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
}
const SUPERVISOR = {
  name: 'supervisor',
  executor: 'claude-sdk',
  kind: 'supervisor',
  permissions: READ_PERMS,
  creatable_by: [],
} as unknown as Role
const ROLES: Record<string, unknown> = {
  supervisor: SUPERVISOR,
  developer: { name: 'developer', executor: 'fake', creatable_by: ['*'] },
}

const OFF: SupervisorObserveConfig = { replies: false, approvals: false, autonomous: false }

async function setup(o: { observe?: Partial<SupervisorObserveConfig> } = {}) {
  const clock = new FakeClock(T0)
  const t = await tempLedger({ now: clock.now })
  cleanups.push(t.cleanup)
  const store = t.store
  const root = mkdtempSync(join(tmpdir(), 'raindown-observe-'))
  const repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const supervisor: SupervisorConfig = {
    ...defaultSupervisorConfig(),
    observe: { ...OFF, ...o.observe },
  }
  const workspaces: Record<string, WorkspaceInfo> = { [WS]: { ref: WS, repos: [repo], supervisor } }
  const lookup = async (ref: string) => workspaces[ref] ?? null
  const roles: RoleLookup = async (name) => ok((ROLES[name] ?? null) as Role | null)
  let n = 0
  const tasks = createTaskService({
    ledger: store,
    workspaceExists: async (ref) => ref in workspaces,
    workspaces: lookup,
    roles,
    now: clock.now,
    newTaskId: () => `t-${String(++n).padStart(3, '0')}`,
  })
  let r = 0
  const delegation = createDelegationService({
    ledger: store,
    clock,
    workspaces: lookup,
    roles,
    supervisorRole: async () => ok(SUPERVISOR),
    logger: { warn() {} },
    newReplyId: () => `r-${String(++r).padStart(4, '0')}`,
  })
  delegation.start()
  cleanups.push(() => delegation.stop())
  const scheduler: WakeScheduler = createWakeScheduler({
    ledger: store,
    tasks,
    clock,
    workspaces: lookup,
    listWorkspaces: async () => Object.values(workspaces),
    supervisorRole: async () => ok(SUPERVISOR),
    logger: { warn() {} },
    onReplyUnavailable: (info) => delegation.onReplyUnavailable(info),
  })
  scheduler.start()
  cleanups.push(() => scheduler.stop())
  const wakeTokens = createWakeTokenAuthority({ ledger: () => store, now: clock.now })
  const protocol: NodeProtocol = createNodeProtocol({
    ledger: store,
    clock,
    leaseTtlS: 3600,
    leaseWaitMaxS: 30,
    issueWakeToken: (g) => wakeTokens.issue(g),
  })
  cleanups.push(() => protocol.stop())
  must(
    protocol.service.registerNode(
      {
        node_id: 'n1',
        hostname: 'host',
        version: '0.0.0',
        capabilities: ['executor:fake', 'executor:claude-sdk'],
      },
      'unknown',
    ),
  )
  const channel = new MemoryChannel()
  const inbox = await startInbox({
    ledger: store,
    home: join(root, 'home'),
    clock,
    watch: false,
    channels: [specOf(channel)],
    held: delegation.held,
    logger: { warn() {} },
  })
  cleanups.push(() => inbox.stop())
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await delegation.idle()
      await scheduler.idle()
      await inbox.idle()
      await inbox.pusher.tick()
      await clock.advance(0)
      await tick()
    }
  }
  return { store, clock, tasks, delegation, protocol, wakeTokens, workspaces, channel, settle }
}
type Env = Awaited<ReturnType<typeof setup>>

const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? 'ok' : r.error?.code)

async function create(env: Env) {
  const c = await env.tasks.createTask(contractInput({ workspace: WS, role: 'developer' }), {
    actor: 'user',
  })
  if (!c.ok) throw new Error(c.error.message)
  return c.data.task.id
}

async function grant(env: Env, executor: string) {
  const r = await env.protocol.service.acquire(
    { node_id: 'n1', capabilities: [`executor:${executor}`], wait_s: 0 },
    { actor: 'node:n1' },
  )
  if (!r.ok || !r.data.lease) throw new Error(`没有领到 ${executor} 的租约`)
  return r.data.lease
}
type Lease = Awaited<ReturnType<typeof grant>>

const blockSeqOf = (env: Env, id: string) =>
  env.store
    .taskEvents(id)
    .filter((e) => e.type === 'task.blocked')
    .at(-1)?.seq ?? 0

const OPTIONS = [
  { label: 'A', description: '只改 README' },
  { label: 'B', description: '连同文档站一起改' },
]

/** worker 卡在带结构化选项的提问（节点持有租约）。 */
function blockQuestion(env: Env, lease: Lease) {
  must(
    env.protocol.service.renew(lease.lease_id, {
      lease_token: lease.lease_token,
      blocked: {
        reason: 'question',
        basis: 'reported',
        message: '用 A 还是 B？',
        question: { text: '用 A 还是 B？', options: OPTIONS, recommended: 'A' },
      },
    }),
  )
  return blockSeqOf(env, lease.task_id)
}

/** 授权请求卡住：策略判定（supervisor 档位）后节点上报卡住。 */
function blockApproval(env: Env, lease: Lease) {
  const id = lease.task_id
  const decided = must(
    env.store.append(
      {
        task_id: id,
        workspace: WS,
        type: 'policy.decided',
        payload: {
          task_id: id,
          request: { tool: 'CodexCommand', command: 'pnpm check', actions: ['tool:CodexCommand'] },
          level: 'supervisor',
          matched_rules: [],
          actions: [],
        },
      },
      { actor: 'policy' },
    ),
  )
  must(
    env.protocol.service.renew(lease.lease_id, {
      lease_token: lease.lease_token,
      blocked: {
        reason: 'awaiting_approval',
        message: '等待授权：pnpm check',
        decision_id: decided.seq,
        request: { tool: 'CodexCommand', command: 'pnpm check', reason: '运行检查' },
      },
    }),
  )
  return { blockSeq: blockSeqOf(env, id), decisionId: decided.seq }
}

async function replyCaller(env: Env): Promise<WakeCaller> {
  const lease = await grant(env, 'claude-sdk')
  const caller = lease.wake_token ? env.wakeTokens.authenticate(lease.wake_token) : null
  if (!caller) throw new Error('唤醒 token 无效')
  expect(caller.origin).toBe('reply')
  return caller
}

const respond = (
  env: Env,
  caller: WakeCaller,
  input: Partial<TaskRespondRequest> & Pick<TaskRespondRequest, 'task_id' | 'block_seq'>,
  opts?: Parameters<Env['delegation']['respond']>[3],
) =>
  env.delegation.respond(
    'supervisor',
    caller,
    { decision: 'answer', text: 'A', reason: '目标只限 README', ...input } as TaskRespondRequest,
    opts,
  )

const allEvents = (env: Env): LedgerEvent[] => env.store.eventsAfter(0, {}, 100_000)
const observedOf = (env: Env, taskId: string) =>
  allEvents(env).filter(
    (e): e is EventOf<'task.reply_observed'> =>
      e.type === 'task.reply_observed' && e.payload.task_id === taskId,
  )

/**
 * observe 判断绝不送达：没有 task.replied（supervisor）、没有回复记录、没有待送达回复，
 * 没有 reply_fetched / requeued_with_reply，续约不带回复，任务仍卡住。
 */
function expectNotDelivered(env: Env, id: string, lease?: Lease) {
  const events = env.store.taskEvents(id)
  expect(events.some((e) => e.type === 'task.replied')).toBe(false)
  expect(events.some((e) => e.type === 'task.reply_fetched')).toBe(false)
  expect(events.some((e) => e.type === 'task.requeued_with_reply')).toBe(false)
  expect(env.store.taskReplies(id)).toHaveLength(0)
  expect(env.store.pendingReply(id)).toBeNull()
  expect(env.store.taskResume(id)).toBeNull()
  expect(env.store.getTask(id)?.status).toBe('blocked')
  if (lease) {
    const renewed = must(
      env.protocol.service.renew(lease.lease_id, { lease_token: lease.lease_token }),
    )
    expect(renewed.reply ?? null).toBeNull()
  }
}

// ---------------------------------------------------------------------------

describe('配置 supervisor.observe（7.1）', () => {
  test('缺省三项均为 false；可逐项开启；拼错的键报错；doctor 摘要显示每项状态', () => {
    expect(defaultSupervisorConfig().observe).toEqual(OFF)
    const parsed = supervisorConfigSchema.parse({ observe: { approvals: true } })
    expect(parsed.observe).toEqual({ replies: false, approvals: true, autonomous: false })
    expect(supervisorConfigSchema.safeParse({ observe: { approval: true } }).success).toBe(false)
    expect(describeSupervisorConfig(parsed)).toContain('observe：代答 关、代批 开、自主工作 关')
    expect(describeSupervisorConfig(defaultSupervisorConfig())).toContain(
      'observe：代答 关、代批 关、自主工作 关',
    )
  })

  test('配置缺省：委托不带 observe，supervisor 的回复照常送达（行为不变）', async () => {
    const env = await setup()
    const id = await create(env)
    const lease = await grant(env, 'fake')
    const blockSeq = blockQuestion(env, lease)
    await env.settle()
    const delegated = env.store.taskEvents(id).find((e) => e.type === 'task.reply_delegated')
    expect(delegated?.payload).not.toHaveProperty('observe')
    const caller = await replyCaller(env)
    const r = must(respond(env, caller, { task_id: id, block_seq: blockSeq }))
    expect(r).not.toHaveProperty('observed')
    expect(r.reply).toMatchObject({ by: 'supervisor', text: 'A' })
    const renewed = must(
      env.protocol.service.renew(lease.lease_id, { lease_token: lease.lease_token }),
    )
    expect(renewed.reply).toMatchObject({ by: 'supervisor', text: 'A' })
    expect(observedOf(env, id)).toHaveLength(0)
  })
})

describe('代批 observe（7.2）', () => {
  test('委托照常、supervisor 判断批准：只记录 task.reply_observed 并转给用户，绝不送达', async () => {
    const env = await setup({ observe: { approvals: true } })
    const id = await create(env)
    const lease = await grant(env, 'fake')
    const { blockSeq, decisionId } = blockApproval(env, lease)
    await env.settle()
    const delegated = env.store.taskEvents(id).find((e) => e.type === 'task.reply_delegated')
    expect(delegated?.payload).toMatchObject({ kind: 'awaiting_approval', observe: true })
    // 委托期间条目不推送（与非 observe 相同）。
    expect(env.channel.sentIds().flat()).not.toContain(`blk.${blockSeq}`)
    const caller = await replyCaller(env)
    const r = must(
      respond(env, caller, {
        task_id: id,
        block_seq: blockSeq,
        decision: 'approve',
        text: undefined,
        reason: '只读检查，范围内',
      }),
    )
    expect(r).toMatchObject({ decision: 'approve', reply: null, requeued: false, observed: true })
    const observed = observedOf(env, id)
    expect(observed).toHaveLength(1)
    expect(observed[0]).toMatchObject({
      actor: 'hub',
      workspace: WS,
      payload: {
        task_id: id,
        block_seq: blockSeq,
        delegation_seq: delegated?.seq,
        kind: 'awaiting_approval',
        decision_id: decisionId,
        decision: 'approve',
        reason: '只读检查，范围内',
      },
    })
    // observe 判断不带信封 task_id：不在任务事件里。
    expect(observed[0]?.task_id).toBeUndefined()
    expect(env.store.taskEvents(id).some((e) => e.type === 'task.reply_observed')).toBe(false)
    const esc = env.store.taskEvents(id).filter((e) => e.type === 'task.reply_escalated')
    expect(esc).toHaveLength(1)
    expect(esc[0]).toMatchObject({
      actor: 'hub',
      payload: { reason: 'observe', block_seq: blockSeq },
    })
    expect(esc[0]?.payload).not.toHaveProperty('note')
    expect(env.store.activeDelegation(id)).toBeNull()
    expectNotDelivered(env, id, lease)
    await env.settle()
    // 收件箱条目附"supervisor 会：批准（理由）"，并按原级别推送给用户；渠道渲染同样显示。
    const item = env.store.getInboxItem(`blk.${blockSeq}`)
    expect(item?.state).toBe('open')
    expect(item?.body.startsWith(`${OBSERVE_LINE_PREFIX}批准（只读检查，范围内）`)).toBe(true)
    expect(env.channel.sentIds().flat()).toContain(`blk.${blockSeq}`)
    const out = toOutbound(item as NonNullable<typeof item>, { ledger: env.store, snippetMax: 0 })
    expect(out.text).toContain('supervisor 会：批准（只读检查，范围内）')
    // 再次 task_respond：委托已结束。
    expect(
      code(respond(env, caller, { task_id: id, block_seq: blockSeq, decision: 'approve' })),
    ).toBe('stale_block')
    expectNotDelivered(env, id, lease)
  })

  test('用户之后的实际回复照常送达；report 计为一致 / 不一致', async () => {
    for (const [userKind, agreed] of [
      ['approve', 1],
      ['deny', 0],
    ] as const) {
      const env = await setup({ observe: { approvals: true } })
      const id = await create(env)
      const lease = await grant(env, 'fake')
      const { blockSeq } = blockApproval(env, lease)
      await env.settle()
      const caller = await replyCaller(env)
      must(respond(env, caller, { task_id: id, block_seq: blockSeq, decision: 'approve' }))
      const replied = must(
        env.tasks.replyTask(
          id,
          userKind === 'deny' ? { kind: 'deny', text: '不行' } : { kind: 'approve' },
          { actor: 'user' },
        ),
      )
      expect(replied.reply.by).toBe('user')
      const renewed = must(
        env.protocol.service.renew(lease.lease_id, { lease_token: lease.lease_token }),
      )
      expect(renewed.reply).toMatchObject({ kind: userKind, by: 'user' })
      const report = supervisorReport(env.store, ALL_TIME, env.clock.now())
      expect(report.workspaces[0]?.observed_replies).toMatchObject({
        total: 1,
        awaiting_approval: 1,
        replied: 1,
        judged: 1,
        agreed,
        agreement: agreed,
        approvals: { judged: 1, agreed },
      })
    }
  })

  test('只开 approvals：提问的委托不受影响，supervisor 的回答照常送达', async () => {
    const env = await setup({ observe: { approvals: true } })
    const id = await create(env)
    const lease = await grant(env, 'fake')
    const blockSeq = blockQuestion(env, lease)
    await env.settle()
    const caller = await replyCaller(env)
    const r = must(respond(env, caller, { task_id: id, block_seq: blockSeq }))
    expect(r.reply).toMatchObject({ by: 'supervisor' })
    expect(observedOf(env, id)).toHaveLength(0)
  })

  test('账本重建：observe 判断、转交与用户回复都能重放；observe 判断只接受 hub、只落在有效委托上', async () => {
    const env = await setup({ observe: { approvals: true } })
    const id = await create(env)
    const lease = await grant(env, 'fake')
    const { blockSeq, decisionId } = blockApproval(env, lease)
    await env.settle()
    const delegationSeq =
      env.store.taskEvents(id).find((e) => e.type === 'task.reply_delegated')?.seq ?? 0
    const forged = {
      workspace: WS,
      type: 'task.reply_observed' as const,
      payload: {
        task_id: id,
        block_seq: blockSeq,
        delegation_seq: delegationSeq,
        kind: 'awaiting_approval' as const,
        decision_id: decisionId,
        decision: 'approve' as const,
        reason: '伪造',
      },
    }
    expect(code(env.store.append(forged, { actor: 'supervisor' }))).toBe('actor_mismatch')
    expect(code(env.store.append({ ...forged, task_id: id }, { actor: 'hub' }))).toBe(
      'invalid_event',
    )
    const caller = await replyCaller(env)
    must(respond(env, caller, { task_id: id, block_seq: blockSeq, decision: 'approve' }))
    // 委托已结束：之后的 observe 判断被拒绝。
    expect(code(env.store.append(forged, { actor: 'hub' }))).toBe('not_delegated')
    must(env.tasks.replyTask(id, { kind: 'approve' }, { actor: 'user' }))
    const before = env.store.snapshot({ includeSoft: false })
    must(env.store.rebuild())
    expect(env.store.snapshot({ includeSoft: false })).toEqual(before)
    expect(observedOf(env, id)).toHaveLength(1)
  })

  test('store 兜底：observe 委托上 supervisor 的 task.replied 一律拒绝', async () => {
    const env = await setup({ observe: { approvals: true } })
    const id = await create(env)
    const lease = await grant(env, 'fake')
    blockApproval(env, lease)
    await env.settle()
    const r = env.store.append(
      {
        task_id: id,
        workspace: WS,
        type: 'task.replied',
        payload: { reply_id: 'r-9999', kind: 'approve', via: 'supervisor', reason: '绕过' },
      },
      { actor: 'supervisor' },
    )
    expect(code(r)).toBe('not_delegated')
    expectNotDelivered(env, id, lease)
  })
})

describe('代答 observe（7.2）', () => {
  test('无头执行器（不持有租约）：observe 下不带回复重新排队、不建回复', async () => {
    const env = await setup({ observe: { replies: true } })
    const id = await create(env)
    const lease = await grant(env, 'fake')
    must(
      env.protocol.service.complete(lease.lease_id, {
        lease_token: lease.lease_token,
        outcome: 'blocked',
        blocked_reason: 'question',
        basis: 'reported',
        message: '用 A 还是 B？',
        question: { text: '用 A 还是 B？', options: OPTIONS, recommended: 'A' },
      }),
    )
    await env.settle()
    const blockSeq = blockSeqOf(env, id)
    const caller = await replyCaller(env)
    const r = must(respond(env, caller, { task_id: id, block_seq: blockSeq }))
    expect(r).toMatchObject({ decision: 'answer', reply: null, requeued: false, observed: true })
    expect(observedOf(env, id)[0]?.payload).toMatchObject({ decision: 'answer', text: 'A' })
    expectNotDelivered(env, id)
    // 节点再领取：这个任务不会被派出（没有重新排队）。
    const again = await env.protocol.service.acquire(
      { node_id: 'n1', capabilities: ['executor:fake'], wait_s: 0 },
      { actor: 'node:n1' },
    )
    expect(again.ok && again.data.lease?.task_id === id).toBe(false)
    // 用户之后回答：照常带回复重新排队，下一次派工拿到的是用户的回答。
    must(env.tasks.replyTask(id, { kind: 'text', text: 'A' }, { actor: 'user' }))
    expect(env.store.getTask(id)?.status).toBe('queued')
    expect(env.store.taskResume(id)?.reply).toMatchObject({ by: 'user', text: 'A' })
    const report = supervisorReport(env.store, ALL_TIME, env.clock.now())
    expect(report.workspaces[0]?.observed_replies).toMatchObject({
      question: 1,
      replied: 1,
      choices: { judged: 1, agreed: 1 },
      agreement: 1,
    })
  })

  test('委托后才开启 observe：task_respond 时读取的当前配置同样不送达', async () => {
    const env = await setup()
    const id = await create(env)
    const lease = await grant(env, 'fake')
    const blockSeq = blockQuestion(env, lease)
    await env.settle()
    const caller = await replyCaller(env)
    const r = must(
      respond(
        env,
        caller,
        { task_id: id, block_seq: blockSeq },
        {
          observe: { replies: true, approvals: false },
        },
      ),
    )
    expect(r.observed).toBe(true)
    expectNotDelivered(env, id, lease)
  })

  test('observe 下 supervisor 转交：记录判断，以 supervisor 原因转交并附理由；report 不计入一致率', async () => {
    const env = await setup({ observe: { replies: true } })
    const id = await create(env)
    const lease = await grant(env, 'fake')
    const blockSeq = blockQuestion(env, lease)
    await env.settle()
    const caller = await replyCaller(env)
    must(
      respond(env, caller, {
        task_id: id,
        block_seq: blockSeq,
        decision: 'escalate',
        text: undefined,
        reason: '需要用户决定',
      }),
    )
    expect(observedOf(env, id)[0]?.payload.decision).toBe('escalate')
    expect(env.store.taskEvents(id).find((e) => e.type === 'task.reply_escalated')).toMatchObject({
      payload: { reason: 'supervisor', note: '需要用户决定' },
    })
    expectNotDelivered(env, id, lease)
    const report = supervisorReport(env.store, ALL_TIME, env.clock.now())
    expect(report.workspaces[0]?.observed_replies).toMatchObject({
      total: 1,
      escalate: 1,
      judged: 0,
      agreement: null,
    })
  })

  test('自由文本回答只统计已回复，不判一致', async () => {
    const env = await setup({ observe: { replies: true } })
    const id = await create(env)
    const lease = await grant(env, 'fake')
    const blockSeq = blockQuestion(env, lease)
    await env.settle()
    const caller = await replyCaller(env)
    must(respond(env, caller, { task_id: id, block_seq: blockSeq, text: '先只改 README 吧' }))
    must(env.tasks.replyTask(id, { kind: 'text', text: 'A' }, { actor: 'user' }))
    const s = supervisorReport(env.store, ALL_TIME, env.clock.now()).workspaces[0]
    expect(s?.observed_replies).toMatchObject({ replied: 1, free_text: 1, judged: 0 })
  })
})

describe('worker 读不到 observe 判断（任务绑定的 task_show / event_get）', () => {
  test('事件列表去掉 reply_observed 与收件箱事件；event_get 按不存在处理；user 仍能读取', async () => {
    const env = await setup({ observe: { approvals: true } })
    const id = await create(env)
    const lease = await grant(env, 'fake')
    const { blockSeq } = blockApproval(env, lease)
    await env.settle()
    const caller = await replyCaller(env)
    must(
      respond(env, caller, {
        task_id: id,
        block_seq: blockSeq,
        decision: 'approve',
        reason: 'SECRET_JUDGEMENT',
      }),
    )
    await env.settle()
    const app = createHubApp({
      token: testToken,
      wakeTokens: env.wakeTokens,
      taskTokens: {
        authenticate: (token) =>
          token === 'worker-token'
            ? { actor: 'dev', task_id: id, workspace: WS, lease_id: lease.lease_id, attempt: 1 }
            : null,
      },
      ledger: env.store,
      mount: [{ path: '/', app: createTaskRoutes({ ledger: env.store, tasks: env.tasks }) }],
    })
    const worker = { Authorization: 'Bearer worker-token' }
    for (const path of [`/v1/tasks/${id}`, `/v1/tasks/${id}?section=events&limit=500`]) {
      const res = await app.request(path, { headers: worker })
      expect(res.status).toBe(200)
      const text = await res.text()
      expect(text).not.toContain('SECRET_JUDGEMENT')
      expect(text).not.toContain('supervisor 会')
      expect(text).not.toContain('"inbox.')
      expect(text).not.toContain('task.reply_observed')
    }
    const observedSeq = observedOf(env, id)[0]?.seq ?? 0
    const inboxUpdate = env.store
      .taskEvents(id)
      .find(
        (e) => e.type === 'inbox.item_updated' && JSON.stringify(e).includes('SECRET_JUDGEMENT'),
      )
    expect(inboxUpdate).toBeDefined()
    for (const seq of [observedSeq, inboxUpdate?.seq ?? 0]) {
      const denied = await app.request(`/v1/events/${seq}`, { headers: worker })
      expect(denied.status).toBe(404)
      expect(await denied.text()).not.toContain('SECRET_JUDGEMENT')
    }
    // 用户照常能看到 observe 判断。
    const asUser = await app.request(`/v1/events/${observedSeq}`, { headers: authHeaders })
    expect(asUser.status).toBe(200)
    expect(await asUser.text()).toContain('SECRET_JUDGEMENT')
    const userShow = await app.request(`/v1/tasks/${id}?section=events&limit=500`, {
      headers: authHeaders,
    })
    expect(await userShow.text()).toContain('inbox.item_updated')
  })
})

describe('HTTP task_respond 读取当前配置', () => {
  test('workspace 当前开启 observe：经 HTTP 的回复只记录不送达；结果带 observed', async () => {
    const env = await setup()
    const id = await create(env)
    const lease = await grant(env, 'fake')
    const blockSeq = blockQuestion(env, lease)
    await env.settle()
    const wake = await grant(env, 'claude-sdk')
    // 委托之后把 observe.replies 打开。
    const ws = env.workspaces[WS] as WorkspaceInfo
    ws.supervisor = { ...ws.supervisor, observe: { ...OFF, replies: true } }
    const app = createHubApp({
      token: testToken,
      wakeTokens: env.wakeTokens,
      ledger: env.store,
      mount: [
        {
          path: '/',
          app: createSupervisorToolRoutes({
            delegation: env.delegation,
            workspaces: async (ref: string) => env.workspaces[ref] ?? null,
          } as unknown as SupervisorToolsDeps),
        },
      ],
    })
    const res = await app.request('/v1/supervisor/respond', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${wake.wake_token}` },
      body: JSON.stringify({
        task_id: id,
        block_seq: blockSeq,
        decision: 'answer',
        text: 'A',
        reason: '范围内',
      }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { data: { observed?: boolean } }).data.observed).toBe(true)
    expectNotDelivered(env, id, lease)
  })
})

describe('raindown supervisor report（7.4）', () => {
  test('按执行器统计卡住 basis；observed_action 按类型计数；时间范围与 workspace 过滤；HTTP 只限 user', async () => {
    const env = await setup()
    const id = await create(env)
    const lease = await grant(env, 'fake')
    blockQuestion(env, lease)
    must(
      env.store.append(
        {
          task_id: id,
          workspace: WS,
          type: 'task.blocked',
          payload: {
            reason: 'question',
            basis: 'inferred',
            message: '终端推断',
            lease_held: false,
          },
        },
        { actor: 'node:n1' },
      ),
    )
    must(
      env.store.append(
        {
          workspace: WS,
          type: 'supervisor.observed_action',
          payload: { wake_task_id: id, action: 'task_propose', args: '{}', reason: 'observe' },
        },
        { actor: 'hub' },
      ),
    )
    const report = supervisorReport(env.store, ALL_TIME, env.clock.now())
    expect(report.workspaces).toHaveLength(1)
    expect(report.workspaces[0]?.stuck_basis).toEqual([
      { executor: 'fake', reported: 1, inferred: 1, unspecified: 0, reported_ratio: 0.5 },
    ])
    expect(report.workspaces[0]?.observed_actions).toEqual({
      total: 1,
      task_create: 0,
      task_propose: 1,
      pr_merge_request: 0,
    })
    // 时间范围之外与其他 workspace 不计入。
    const future = supervisorReport(
      env.store,
      { since: '2099-01-01T00:00:00.000Z', until: '2100-01-01T00:00:00.000Z' },
      env.clock.now(),
    )
    expect(future.workspaces).toEqual([])
    const other = supervisorReport(
      env.store,
      { ...ALL_TIME, workspace: 'ws/other' },
      env.clock.now(),
    )
    expect(other.workspaces[0]?.workspace).toBe('ws/other')
    expect(other.workspaces[0]?.observed_actions.total).toBe(0)
    // 缺省范围：最近 7 天。
    const recent = supervisorReport(env.store, {}, env.clock.now())
    expect(Date.parse(recent.until) - Date.parse(recent.since)).toBe(7 * 24 * 3600 * 1000 + 1)
    expect(recent.workspaces[0]?.stuck_basis[0]?.reported).toBe(1)

    const app = createHubApp({
      token: testToken,
      ledger: env.store,
      mount: [
        {
          path: '/',
          app: createSupervisorRoutes({
            scheduler: () => undefined,
            ledger: env.store,
            now: env.clock.now,
          }),
        },
      ],
    })
    const okRes = await app.request(
      `/v1/supervisor/report?since=${ALL_TIME.since}&until=${ALL_TIME.until}`,
      { headers: authHeaders },
    )
    expect(okRes.status).toBe(200)
    expect(
      ((await okRes.json()) as { data: { workspaces: unknown[] } }).data.workspaces,
    ).toHaveLength(1)
    const ai = await app.request('/v1/supervisor/report', {
      headers: { ...authHeaders, 'X-Raindown-Actor': 'reviewer' },
    })
    expect(((await ai.json()) as { error: { code: string } }).error.code).toBe('user_only')
    const bad = await app.request(
      `/v1/supervisor/report?since=${ALL_TIME.until}&until=${ALL_TIME.since}`,
      { headers: authHeaders },
    )
    expect(bad.status).toBe(400)
  })

  test('参数摘要遮蔽疑似密钥并限制长度', () => {
    const summary = summarizeArgs({ goal: `x Bearer ${'a'.repeat(40)} ${'长'.repeat(3000)}` })
    expect(summary.length).toBeLessThanOrEqual(1000)
    expect(summary).not.toContain('a'.repeat(40))
  })
})

// 防止未使用的导入在类型层面被移除（store 类型用于辅助函数签名）。
export type { LedgerStore }
