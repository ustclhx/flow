import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyBinding,
  briefUpdateOp,
  defaultSupervisorConfig,
  delegationRequestMatches,
  fail,
  globalSupervisorConfig,
  ok,
  operations,
  type Result,
  type Role,
  type SupervisorConfig,
  type TaskRespondRequest,
  taskRespondOp,
} from '@flow/core'
import {
  actOnInbox,
  createDelegationService,
  createHubApp,
  createInboxReactor,
  createNodeProtocol,
  createSupervisorToolRoutes,
  createTaskRoutes,
  createTaskService,
  createWakeScheduler,
  createWakeTokenAuthority,
  DELEGATED_TITLE_PREFIX,
  type LedgerStore,
  type NodeProtocol,
  type RoleLookup,
  type SupervisorToolsDeps,
  startInbox,
  type WakeCaller,
  type WakeScheduler,
  type WorkspaceInfo,
} from '../src/index.ts'
import { createItem, MemoryChannel, specOf } from './channel-fixtures.ts'
import { contractInput, must, tempLedger } from './ledger-helpers.ts'
import { authHeaders, FakeClock, testToken, tick } from './server-fixtures.ts'

/**
 * add-m1-supervisor 3.5、4.9（D15）：委托判定、不推送、转交（超时、唤醒不可用 / 卡住 / 失败 / 结束、
 * 用户回复、用户忽略）、隐式失效、task_respond 的核对与写入、竞态、重启恢复与端到端。
 */

const WS = 'ws/demo'
const T0 = new Date(2026, 9, 26, 10, 0).getTime()
const TTL = 3600

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
  merger: { name: 'merger', executor: 'pr-merge', creatable_by: ['*'] },
  'pr-reviewer': {
    name: 'pr-reviewer',
    executor: 'claude-sdk',
    permissions: READ_PERMS,
    creatable_by: ['*'],
  },
}

interface SetupOptions {
  supervisor?: Partial<SupervisorConfig>
  supervisorRole?: () => Promise<Result<Role | null>>
  roles?: RoleLookup
  repos?: string[]
  store?: LedgerStore
  clock?: FakeClock
}

async function setup(o: SetupOptions = {}) {
  const clock = o.clock ?? new FakeClock(T0)
  let ledger = o.store
  if (!ledger) {
    const t = await tempLedger({ now: clock.now })
    cleanups.push(t.cleanup)
    ledger = t.store
  }
  const store = ledger
  const root = mkdtempSync(join(tmpdir(), 'flow-delegation-'))
  const repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const workspaces: Record<string, WorkspaceInfo> = {
    [WS]: {
      ref: WS,
      repos: o.repos ?? [repo],
      supervisor: { ...defaultSupervisorConfig(), ...o.supervisor },
    },
    'ws/global': { ref: 'ws/global', repos: [repo], supervisor: globalSupervisorConfig() },
  }
  const lookup = async (ref: string) => workspaces[ref] ?? null
  const roles: RoleLookup = o.roles ?? (async (name) => ok((ROLES[name] ?? null) as Role | null))
  let n = 0
  const tasks = createTaskService({
    ledger: store,
    workspaceExists: async (ref) => ref in workspaces,
    workspaces: lookup,
    roles,
    now: clock.now,
    newTaskId: () => `t-${String(++n).padStart(3, '0')}`,
  })
  let released = 0
  let r = 0
  const delegation = createDelegationService({
    ledger: store,
    clock,
    workspaces: lookup,
    roles,
    supervisorRole: o.supervisorRole ?? (async () => ok(SUPERVISOR)),
    logger: { warn() {} },
    newReplyId: () => `r-${String(++r).padStart(4, '0')}`,
    onRelease: () => {
      released++
    },
  })
  delegation.start()
  cleanups.push(() => delegation.stop())
  const scheduler: WakeScheduler = createWakeScheduler({
    ledger: store,
    tasks,
    clock,
    workspaces: lookup,
    listWorkspaces: async () => Object.values(workspaces),
    supervisorRole: o.supervisorRole ?? (async () => ok(SUPERVISOR)),
    logger: { warn() {} },
    onReplyUnavailable: (info) => delegation.onReplyUnavailable(info),
  })
  scheduler.start()
  cleanups.push(() => scheduler.stop())
  const wakeTokens = createWakeTokenAuthority({ ledger: () => store, now: clock.now })
  const protocol: NodeProtocol = createNodeProtocol({
    ledger: store,
    clock,
    leaseTtlS: TTL,
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
        capabilities: ['executor:fake', 'executor:claude-sdk', 'executor:pr-merge'],
      },
      'unknown',
    ),
  )
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await delegation.idle()
      await scheduler.idle()
      await tick()
    }
  }
  return {
    store,
    clock,
    tasks,
    delegation,
    scheduler,
    protocol,
    wakeTokens,
    workspaces,
    released: () => released,
    settle,
  }
}
type Env = Awaited<ReturnType<typeof setup>>

const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? 'ok' : r.error?.code)

async function create(env: Env, over: Record<string, unknown> = {}) {
  const c = await env.tasks.createTask(contractInput(over), { actor: 'user' })
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

/** 交互式 worker 卡在提问（节点持有租约）。 */
function blockQuestion(env: Env, lease: Lease, extra: Record<string, unknown> = {}) {
  must(
    env.protocol.service.renew(lease.lease_id, {
      lease_token: lease.lease_token,
      blocked: { reason: 'question', message: '用 A 还是 B？', ...extra },
    }),
  )
  return blockSeqOf(env, lease.task_id)
}

/** 直接进入新的卡住（blocked → blocked，例如节点直接写入新的卡住）。 */
function reblock(env: Env, id: string, extra: Record<string, unknown> = {}) {
  must(
    env.store.append(
      {
        task_id: id,
        workspace: WS,
        type: 'task.blocked',
        payload: { reason: 'question', message: '还有一个问题', lease_held: false, ...extra },
      },
      { actor: 'node:n1' },
    ),
  )
  return blockSeqOf(env, id)
}

interface ApprovalOptions {
  level?: string
  decidedCommand?: string | undefined
  blockedCommand?: string | undefined
  decidedPaths?: string[]
  blockedPaths?: string[]
  decidedTool?: string
  withDecision?: boolean
  decisionTask?: string
  actor?: string
  extra?: Record<string, unknown>
}

/** 授权请求卡住：先写策略判定（actor policy），再由节点上报卡住（带 decision_id 与请求文本）。 */
function blockApproval(env: Env, lease: Lease, o: ApprovalOptions = {}) {
  const id = lease.task_id
  const decidedCommand = 'decidedCommand' in o ? o.decidedCommand : 'pnpm check'
  const blockedCommand = 'blockedCommand' in o ? o.blockedCommand : 'pnpm check'
  const decisionTask = o.decisionTask ?? id
  const decided = must(
    env.store.append(
      {
        task_id: decisionTask,
        workspace: WS,
        type: 'policy.decided',
        payload: {
          task_id: decisionTask,
          request: {
            tool: o.decidedTool ?? 'CodexCommand',
            ...(decidedCommand === undefined ? {} : { command: decidedCommand }),
            ...(o.decidedPaths ? { paths: o.decidedPaths } : {}),
            actions: ['tool:CodexCommand'],
          },
          level: (o.level ?? 'supervisor') as 'supervisor',
          matched_rules: [],
          actions: [],
        },
      },
      { actor: o.actor ?? 'policy' },
    ),
  )
  must(
    env.protocol.service.renew(lease.lease_id, {
      lease_token: lease.lease_token,
      blocked: {
        reason: 'awaiting_approval',
        message: '等待授权：pnpm check',
        ...(o.withDecision === false ? {} : { decision_id: decided.seq }),
        request: {
          tool: 'CodexCommand',
          ...(blockedCommand === undefined ? {} : { command: blockedCommand }),
          ...(o.blockedPaths ? { paths: o.blockedPaths } : {}),
          reason: '运行检查',
        },
        ...o.extra,
      },
    }),
  )
  return { blockSeq: blockSeqOf(env, id), decisionId: decided.seq }
}

const delegationsOf = (env: Env, id: string) =>
  env.store.taskEvents(id).filter((e) => e.type === 'task.reply_delegated')
const escalationsOf = (env: Env, id: string) =>
  env.store.taskEvents(id).filter((e) => e.type === 'task.reply_escalated')

/** 领取 reply 唤醒的租约，取得唤醒绑定 token 认定的调用方。 */
async function replyCaller(env: Env): Promise<{ caller: WakeCaller; lease: Lease }> {
  const lease = await grant(env, 'claude-sdk')
  const token = lease.wake_token
  if (!token) throw new Error('reply 唤醒的租约没有唤醒 token')
  const caller = env.wakeTokens.authenticate(token)
  if (!caller) throw new Error('唤醒 token 无效')
  expect(caller.origin).toBe('reply')
  return { caller, lease }
}

const respond = (
  env: Env,
  caller: WakeCaller | null,
  input: Partial<TaskRespondRequest> & Pick<TaskRespondRequest, 'task_id' | 'block_seq'>,
  actor = 'supervisor',
) =>
  env.delegation.respond(actor, caller, {
    decision: 'answer',
    text: '选 A',
    reason: '目标只限 README',
    ...input,
  } as TaskRespondRequest)

/** 一个卡在提问、已委托并已有 reply 唤醒在运行的任务。 */
async function delegatedQuestion(env: Env) {
  const id = await create(env)
  const lease = await grant(env, 'fake')
  const blockSeq = blockQuestion(env, lease)
  await env.settle()
  expect(delegationsOf(env, id)).toHaveLength(1)
  const { caller, lease: wakeLease } = await replyCaller(env)
  return { id, lease, blockSeq, caller, wakeLease }
}

// ---------------------------------------------------------------------------

describe('core delegationRequestMatches', () => {
  const r = (command?: string, paths?: string[], tool = 'CodexCommand') => ({
    tool,
    ...(command === undefined ? {} : { command }),
    ...(paths ? { paths } : {}),
  })
  test('逐字一致才算一致；任何不确定都不一致', () => {
    expect(delegationRequestMatches(r('pnpm check'), r('pnpm check'))).toBe(true)
    expect(delegationRequestMatches(r('pnpm check'), r('pnpm check '))).toBe(false)
    expect(delegationRequestMatches(r('pnpm check'), r('pnpm check', undefined, 'Bash'))).toBe(
      false,
    )
    expect(delegationRequestMatches(r(), r())).toBe(false)
    expect(delegationRequestMatches(r('pnpm check'), r())).toBe(false)
    expect(delegationRequestMatches(undefined, r('pnpm check'))).toBe(false)
    expect(delegationRequestMatches(r('x', ['a']), r('x', ['a']))).toBe(true)
    expect(delegationRequestMatches(r('x', ['a']), r('x'))).toBe(false)
    expect(delegationRequestMatches(r('x', ['a', 'b']), r('x', ['b', 'a']))).toBe(false)
    // 可能被截断或脱敏过：两侧相同也判为不一致。
    for (const t of ['a [REDACTED:cli-flag]', 'a [secret:gh/token]', 'abc…', 'x'.repeat(2000)]) {
      expect(delegationRequestMatches(r(t), r(t))).toBe(false)
      expect(delegationRequestMatches(r('x', [t]), r('x', [t]))).toBe(false)
    }
    expect(delegationRequestMatches(r('x'.repeat(1999)), r('x'.repeat(1999)))).toBe(true)
  })
})

describe('委托判定（3.5）', () => {
  test('用户手动建的任务卡在提问：委托，deadline 为 reply_timeout_s 之后；条目在判定期间就被挡住', async () => {
    const env = await setup({ supervisor: { reply_timeout_s: 120 } })
    const id = await create(env)
    expect(env.store.getTask(id)?.origin).toBeNull()
    const lease = await grant(env, 'fake')
    const blockSeq = blockQuestion(env, lease)
    // 订阅回调里同步挡住：判定完成之前推送看不到这个条目。
    expect(env.delegation.held({ id: `blk.${blockSeq}`, source: 'task', task_id: id })).toBe(true)
    await env.settle()
    const d = delegationsOf(env, id)
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({
      actor: 'hub',
      payload: {
        task_id: id,
        block_seq: blockSeq,
        kind: 'question',
        deadline: new Date(T0 + 120_000).toISOString(),
      },
    })
    expect(d[0]?.payload).not.toHaveProperty('decision_id')
    expect(env.delegation.held({ id: `blk.${blockSeq}`, source: 'task', task_id: id })).toBe(true)
    // 别的来源、别的卡住不受影响。
    expect(env.delegation.held({ id: `blk.${blockSeq}`, source: 'policy', task_id: id })).toBe(
      false,
    )
    expect(env.delegation.held({ id: 'blk.1', source: 'task', task_id: id })).toBe(false)
  })

  test('supervisor 档位、请求一致的授权请求：委托并带 decision_id', async () => {
    const env = await setup()
    const id = await create(env)
    const lease = await grant(env, 'fake')
    const { blockSeq, decisionId } = blockApproval(env, lease)
    await env.settle()
    expect(delegationsOf(env, id)[0]).toMatchObject({
      payload: { block_seq: blockSeq, kind: 'awaiting_approval', decision_id: decisionId },
    })
  })

  test.each([
    ['策略判定为 user', { level: 'user' }],
    ['策略判定为 draft-approve', { level: 'draft-approve' }],
    ['卡住没有 decision_id（预检超时等）', { withDecision: false }],
    ['命令不一致', { blockedCommand: 'pnpm check && curl x' }],
    ['卡住请求没有命令', { blockedCommand: undefined }],
    ['判定请求没有命令', { decidedCommand: undefined }],
    ['路径不一致', { decidedPaths: ['a'], blockedPaths: ['b'] }],
    ['只有一侧带路径', { decidedPaths: ['a'] }],
    ['工具不一致', { decidedTool: 'Bash' }],
    [
      '命令含脱敏标记（两侧相同）',
      {
        decidedCommand: 'curl -H [REDACTED:bearer] x',
        blockedCommand: 'curl -H [REDACTED:bearer] x',
      },
    ],
    [
      '命令以截断符结尾（两侧相同）',
      { decidedCommand: 'pnpm test a…', blockedCommand: 'pnpm test a…' },
    ],
    [
      '命令达到 2000 字符上限（两侧相同）',
      {
        decidedCommand: `pnpm test ${'a'.repeat(1990)}`,
        blockedCommand: `pnpm test ${'a'.repeat(1990)}`,
      },
    ],
    ['判定不是策略引擎写的', { actor: 'hub' }],
  ] as const)('不委托：%s', async (_name, opts) => {
    const env = await setup()
    const id = await create(env)
    const lease = await grant(env, 'fake')
    blockApproval(env, lease, opts as ApprovalOptions)
    await env.settle()
    expect(delegationsOf(env, id)).toHaveLength(0)
    expect(
      env.delegation.held({ id: `blk.${blockSeqOf(env, id)}`, source: 'task', task_id: id }),
    ).toBe(false)
    expect(env.released()).toBeGreaterThan(0)
  })

  test('不委托：判定属于另一个任务', async () => {
    const env = await setup()
    const other = await create(env)
    const id = await create(env)
    const otherLease = await grant(env, 'fake')
    expect(otherLease.task_id).toBe(other)
    const lease = await grant(env, 'fake')
    blockApproval(env, lease, { decisionTask: other })
    await env.settle()
    expect(delegationsOf(env, id)).toHaveLength(0)
  })

  test('不委托：授权请求卡住时节点没有持有租约（无头执行器结束了这一轮）', async () => {
    const env = await setup()
    const id = await create(env)
    const lease = await grant(env, 'fake')
    const decided = must(
      env.store.append(
        {
          task_id: id,
          workspace: WS,
          type: 'policy.decided',
          payload: {
            task_id: id,
            request: { tool: 'CodexCommand', command: 'pnpm check', actions: [] },
            level: 'supervisor',
            matched_rules: [],
            actions: [],
          },
        },
        { actor: 'policy' },
      ),
    )
    must(
      env.protocol.service.complete(lease.lease_id, {
        lease_token: lease.lease_token,
        outcome: 'blocked',
        blocked_reason: 'awaiting_approval',
        message: '等待授权',
        decision_id: decided.seq,
        request: { tool: 'CodexCommand', command: 'pnpm check' },
      } as never),
    )
    await env.settle()
    expect(env.store.getTask(id)?.status).toBe('blocked')
    expect(delegationsOf(env, id)).toHaveLength(0)
  })

  test('无头执行器的提问（不持有租约）也委托', async () => {
    const env = await setup()
    const id = await create(env)
    const lease = await grant(env, 'fake')
    must(
      env.protocol.service.complete(lease.lease_id, {
        lease_token: lease.lease_token,
        outcome: 'blocked',
        blocked_reason: 'question',
        message: '用 A 还是 B？',
      }),
    )
    await env.settle()
    expect(delegationsOf(env, id)).toHaveLength(1)
  })

  test.each([
    ['ws/global', { ws: 'ws/global' }],
    ['delegate_replies: false', { supervisor: { delegate_replies: false } }],
    ['supervisor.enabled: false', { supervisor: { enabled: false } }],
    ['没有登记仓库', { repos: [] }],
    ['没有 supervisor 角色', { supervisorRole: async () => ok(null) }],
    ['supervisor 角色有误', { supervisorRole: async () => fail('failure', 'role_invalid', 'x') }],
    ['角色查不到', { roles: async () => ok(null) }],
    ['角色加载失败', { roles: async () => fail('failure', 'unknown_role', 'x') }],
  ] as const)('不委托：%s', async (_name, opts) => {
    const { ws, ...rest } = opts as { ws?: string } & SetupOptions
    const env = await setup(rest as SetupOptions)
    const id = await create(env, ws ? { workspace: ws } : {})
    const lease = await grant(env, 'fake')
    blockQuestion(env, lease)
    await env.settle()
    expect(delegationsOf(env, id)).toHaveLength(0)
    expect(env.scheduler.projection().pending(ws ?? WS, 'reply')).toHaveLength(0)
  })

  test('不委托：merger 任务与 reviewer_roles 中的审查任务', async () => {
    const env = await setup()
    const merger = await create(env, { role: 'merger', executor: 'pr-merge' })
    const l1 = await grant(env, 'pr-merge')
    blockQuestion(env, l1)
    const reviewer = await create(env, {
      role: 'pr-reviewer',
      executor: 'claude-sdk',
      inputs: { review: { pr: 'https://github.com/acme/demo/pull/1' } },
    })
    const l2 = await grant(env, 'claude-sdk')
    expect(l2.task_id).toBe(reviewer)
    blockQuestion(env, l2)
    await env.settle()
    expect(delegationsOf(env, merger)).toHaveLength(0)
    expect(delegationsOf(env, reviewer)).toHaveLength(0)
  })

  test('不委托：no_delegate、已请求取消、已有待送达回复', async () => {
    const env = await setup()
    const a = await create(env)
    const la = await grant(env, 'fake')
    blockQuestion(env, la, { no_delegate: true })
    const b = await create(env)
    const lb = await grant(env, 'fake')
    must(env.tasks.cancelTask(b, { actor: 'user' }))
    expect(env.store.getTask(b)?.cancel_requested).toBe(true)
    blockQuestion(env, lb)
    await env.settle()
    expect(delegationsOf(env, a)).toHaveLength(0)
    expect(delegationsOf(env, b)).toHaveLength(0)
  })

  test('唤醒任务自身卡住不委托', async () => {
    const env = await setup()
    must(
      env.store.append(
        { type: 'user.instruction', workspace: WS, payload: { text: '修 README', via: 'cli' } },
        { actor: 'user' },
      ),
    )
    await env.settle()
    const lease = await grant(env, 'claude-sdk')
    expect(env.store.wakeOf(lease.task_id)).not.toBeNull()
    blockQuestion(env, lease)
    await env.settle()
    expect(delegationsOf(env, lease.task_id)).toHaveLength(0)
  })

  test('中枢侧 no_delegate 兜底：同一 running 区间内 supervisor 的批准被拒收过，之后的卡住不委托', async () => {
    const env = await setup()
    const { id, lease, caller } = await (async () => {
      const id = await create(env)
      const lease = await grant(env, 'fake')
      blockApproval(env, lease)
      await env.settle()
      const { caller } = await replyCaller(env)
      return { id, lease, caller }
    })()
    must(
      respond(env, caller, {
        task_id: id,
        block_seq: blockSeqOf(env, id),
        decision: 'approve',
        text: undefined,
      }),
    )
    const renewed = must(
      env.protocol.service.renew(lease.lease_id, { lease_token: lease.lease_token }),
    )
    must(
      env.protocol.service.ackReply(lease.lease_id, {
        lease_token: lease.lease_token,
        reply_id: renewed.reply?.reply_id ?? '',
        outcome: 'dropped',
        reason: 'request_changed',
      }),
    )
    // 节点没带 no_delegate（例如旧节点）：中枢仍不委托。
    blockApproval(env, lease)
    await env.settle()
    expect(delegationsOf(env, id)).toHaveLength(1)
  })

  test('重新卡住（blocked → blocked）重新判定，可以再次委托', async () => {
    const env = await setup()
    const id = await create(env)
    const lease = await grant(env, 'fake')
    const first = blockQuestion(env, lease)
    await env.settle()
    const second = reblock(env, id)
    await env.settle()
    expect(
      delegationsOf(env, id).map((e) => e.type === 'task.reply_delegated' && e.payload.block_seq),
    ).toEqual([first, second])
    expect(env.store.activeDelegation(id)?.block_seq).toBe(second)
  })
})

describe('转交（3.5）', () => {
  test('超时：到 deadline 仍未回复即转交（timeout），之后 task_respond 返回 stale_block', async () => {
    const env = await setup({ supervisor: { reply_timeout_s: 600 } })
    const { id, blockSeq, caller } = await delegatedQuestion(env)
    await env.clock.advance(599_000)
    expect(escalationsOf(env, id)).toHaveLength(0)
    await env.clock.advance(1_000)
    await env.settle()
    expect(escalationsOf(env, id)[0]).toMatchObject({
      actor: 'hub',
      payload: { reason: 'timeout', block_seq: blockSeq },
    })
    expect(env.store.activeDelegation(id)).toBeNull()
    expect(env.delegation.held({ id: `blk.${blockSeq}`, source: 'task', task_id: id })).toBe(false)
    expect(code(respond(env, caller, { task_id: id, block_seq: blockSeq }))).toBe('stale_block')
  })

  test('唤醒不可用（onReplyUnavailable）：同步写 wake_unavailable，只针对仍有效的委托', async () => {
    const env = await setup()
    const id = await create(env)
    const lease = await grant(env, 'fake')
    const blockSeq = blockQuestion(env, lease)
    await env.settle()
    const d = delegationsOf(env, id)[0]
    expect(d).toBeDefined()
    const q = { seq: d?.seq ?? 0, type: 'task.reply_delegated' as const, ts: '', task_id: id }
    env.delegation.onReplyUnavailable({ workspace: WS, reason: 'quota', delegations: [q] })
    // 同步写入：回调返回时委托已结束。
    expect(escalationsOf(env, id)[0]).toMatchObject({
      payload: { reason: 'wake_unavailable', block_seq: blockSeq },
    })
    env.delegation.onReplyUnavailable({ workspace: WS, reason: 'quota', delegations: [q] })
    expect(escalationsOf(env, id)).toHaveLength(1)
  })

  test('reply 配额用尽：调度器经 onReplyUnavailable 立即转交', async () => {
    const env = await setup({
      supervisor: { limits: { ...defaultSupervisorConfig().limits, reply_wakes_per_day: 0 } },
    })
    const id = await create(env)
    const lease = await grant(env, 'fake')
    blockQuestion(env, lease)
    await env.settle()
    expect(escalationsOf(env, id)[0]).toMatchObject({ payload: { reason: 'wake_unavailable' } })
  })

  test('处理它的 reply 唤醒卡住：已被消费的委托也按 wake_unavailable 立即转交', async () => {
    const env = await setup()
    const { id, blockSeq, wakeLease } = await delegatedQuestion(env)
    must(
      env.protocol.service.renew(wakeLease.lease_id, {
        lease_token: wakeLease.lease_token,
        blocked: { reason: 'awaiting_approval', message: '唤醒自己卡住了' },
      }),
    )
    await env.settle()
    expect(escalationsOf(env, id)[0]).toMatchObject({
      payload: { reason: 'wake_unavailable', block_seq: blockSeq },
    })
  })

  test('reply 唤醒失败 → wake_failed；结束时仍未回复 → wake_ended；已回复则不转交', async () => {
    const env = await setup()
    const a = await delegatedQuestion(env)
    must(
      env.protocol.service.complete(a.wakeLease.lease_id, {
        lease_token: a.wakeLease.lease_token,
        outcome: 'failed',
        result: { summary: '失败', executor: 'claude-sdk', node_id: 'n1', reason: 'crashed' },
      } as never),
    )
    await env.settle()
    expect(escalationsOf(env, a.id)[0]).toMatchObject({ payload: { reason: 'wake_failed' } })

    const env2 = await setup()
    const b = await delegatedQuestion(env2)
    must(
      env2.protocol.service.complete(b.wakeLease.lease_id, {
        lease_token: b.wakeLease.lease_token,
        outcome: 'done',
        result: { summary: '结束', executor: 'claude-sdk', node_id: 'n1' },
      } as never),
    )
    await env2.settle()
    expect(escalationsOf(env2, b.id)[0]).toMatchObject({ payload: { reason: 'wake_ended' } })

    const env3 = await setup()
    const c = await delegatedQuestion(env3)
    must(respond(env3, c.caller, { task_id: c.id, block_seq: c.blockSeq }))
    must(
      env3.protocol.service.complete(c.wakeLease.lease_id, {
        lease_token: c.wakeLease.lease_token,
        outcome: 'done',
        result: { summary: '结束', executor: 'claude-sdk', node_id: 'n1' },
      } as never),
    )
    await env3.settle()
    expect(escalationsOf(env3, c.id)).toHaveLength(0)
  })

  test('用户回复：同一次追加结束委托（user_replied，actor user）；没有委托时照常成功', async () => {
    const env = await setup()
    const { id, blockSeq, caller } = await delegatedQuestion(env)
    const r = must(env.tasks.replyTask(id, { kind: 'text', text: '用 B' }, { actor: 'user' }))
    expect(r.reply.by).toBe('user')
    const events = env.store.taskEvents(id)
    const esc = events.find((e) => e.type === 'task.reply_escalated')
    const replied = events.find((e) => e.type === 'task.replied')
    expect(esc).toMatchObject({
      actor: 'user',
      payload: { reason: 'user_replied', block_seq: blockSeq },
    })
    expect(replied?.seq).toBe((esc?.seq ?? 0) + 1)
    expect(esc?.ts).toBe(replied?.ts)
    // 用户优先：supervisor 随后的回复 stale_block。
    expect(code(respond(env, caller, { task_id: id, block_seq: blockSeq }))).toBe('stale_block')

    // 没有委托（delegate_replies 关闭）时用户回复照常成功，不写转交。
    const off = await setup({ supervisor: { delegate_replies: false } })
    const t = await create(off)
    const l = await grant(off, 'fake')
    blockQuestion(off, l)
    await off.settle()
    must(off.tasks.replyTask(t, { kind: 'text', text: '用 B' }, { actor: 'user' }))
    expect(escalationsOf(off, t)).toHaveLength(0)
  })

  test('用户回复绕过 replyTask 直接写 task.replied：委托仍有效时被 store 拒绝', async () => {
    const env = await setup()
    const { id } = await delegatedQuestion(env)
    const r = env.store.append(
      {
        task_id: id,
        workspace: WS,
        type: 'task.replied',
        payload: { reply_id: 'r-x', kind: 'text', text: 'B', via: 'cli' },
      },
      { actor: 'user' },
    )
    expect(code(r)).toBe('invalid_event')
  })

  test('用户忽略条目：同一次追加写 user_dismissed，条目关闭，不再推送', async () => {
    const env = await setup()
    const reactor = createInboxReactor({ ledger: env.store })
    reactor.start()
    cleanups.push(() => reactor.stop())
    const { id, blockSeq } = await delegatedQuestion(env)
    await reactor.idle()
    const deps = {
      ledger: env.store,
      tasks: env.tasks,
      home: '/nonexistent',
      scanProposals: async () => {},
    }
    must(await actOnInbox(deps, `blk.${blockSeq}`, { action: 'dismiss', via: 'cli' }, 'user'))
    const esc = escalationsOf(env, id)[0]
    expect(esc).toMatchObject({ actor: 'user', payload: { reason: 'user_dismissed' } })
    expect(env.store.getInboxItem(`blk.${blockSeq}`)?.closed?.reason).toBe('dismissed')
  })

  test('隐式失效：进入新的卡住后旧 block_seq 的 task_respond 与转交都被拒绝，不写转交事件', async () => {
    const env = await setup()
    const { id, blockSeq, caller } = await delegatedQuestion(env)
    reblock(env, id, { no_delegate: true })
    await env.settle()
    expect(env.store.activeDelegation(id)).toBeNull()
    expect(escalationsOf(env, id)).toHaveLength(0)
    expect(code(respond(env, caller, { task_id: id, block_seq: blockSeq }))).toBe('stale_block')
    const r = env.store.append(
      {
        task_id: id,
        workspace: WS,
        type: 'task.reply_escalated',
        payload: { reason: 'timeout', block_seq: blockSeq },
      },
      { actor: 'hub' },
    )
    expect(code(r)).toBe('invalid_event')
    // 原委托的超时到点也不写转交。
    await env.clock.advance(600_000)
    await env.settle()
    expect(escalationsOf(env, id)).toHaveLength(0)
  })

  test('请求取消后委托随之失效', async () => {
    const env = await setup()
    const { id, blockSeq, caller } = await delegatedQuestion(env)
    must(env.tasks.cancelTask(id, { actor: 'user' }))
    expect(env.store.activeDelegation(id)).toBeNull()
    expect(code(respond(env, caller, { task_id: id, block_seq: blockSeq }))).toBe('stale_block')
  })
})

describe('task_respond（4.9）', () => {
  test('answer：写 task.replied（actor supervisor、via supervisor、带 reason），节点收到回复继续', async () => {
    const env = await setup()
    const { id, lease, blockSeq, caller } = await delegatedQuestion(env)
    const r = must(respond(env, caller, { task_id: id, block_seq: blockSeq }))
    expect(r).toMatchObject({
      decision: 'answer',
      requeued: false,
      reply: { by: 'supervisor', kind: 'text', text: '选 A' },
    })
    const replied = env.store.taskEvents(id).find((e) => e.type === 'task.replied')
    expect(replied).toMatchObject({
      actor: 'supervisor',
      payload: { kind: 'text', via: 'supervisor', text: '选 A', reason: '目标只限 README' },
    })
    const renewed = must(
      env.protocol.service.renew(lease.lease_id, { lease_token: lease.lease_token }),
    )
    expect(renewed.reply).toMatchObject({ kind: 'text', text: '选 A', by: 'supervisor' })
    must(
      env.protocol.service.ackReply(lease.lease_id, {
        lease_token: lease.lease_token,
        reply_id: renewed.reply?.reply_id ?? '',
      }),
    )
    expect(env.store.getTask(id)?.status).toBe('running')
  })

  test('无头执行器的提问：回复后任务带着回复重新排队', async () => {
    const env = await setup()
    const id = await create(env)
    const lease = await grant(env, 'fake')
    must(
      env.protocol.service.complete(lease.lease_id, {
        lease_token: lease.lease_token,
        outcome: 'blocked',
        blocked_reason: 'question',
        message: '用 A 还是 B？',
      }),
    )
    await env.settle()
    const { caller } = await replyCaller(env)
    const r = must(respond(env, caller, { task_id: id, block_seq: blockSeqOf(env, id) }))
    expect(r.requeued).toBe(true)
    expect(env.store.getTask(id)?.status).toBe('queued')
  })

  test('approve / deny：只用于授权请求；answer 用于授权请求、approve 用于提问 → invalid_arguments', async () => {
    const env = await setup()
    const id = await create(env)
    const lease = await grant(env, 'fake')
    const { blockSeq } = blockApproval(env, lease)
    await env.settle()
    const { caller } = await replyCaller(env)
    expect(
      code(respond(env, caller, { task_id: id, block_seq: blockSeq, decision: 'answer' })),
    ).toBe('invalid_arguments')
    const r = must(
      respond(env, caller, { task_id: id, block_seq: blockSeq, decision: 'deny', text: '不需要' }),
    )
    expect(r.reply).toMatchObject({ kind: 'deny', text: '不需要' })
    // 已有待送达的回复：第二次回复 stale_block。
    expect(
      code(
        respond(env, caller, {
          task_id: id,
          block_seq: blockSeq,
          decision: 'approve',
          text: undefined,
        }),
      ),
    ).toBe('stale_block')

    const env2 = await setup()
    const q = await delegatedQuestion(env2)
    expect(
      code(
        respond(env2, q.caller, {
          task_id: q.id,
          block_seq: q.blockSeq,
          decision: 'approve',
          text: undefined,
        }),
      ),
    ).toBe('invalid_arguments')
    expect(
      code(
        respond(env2, q.caller, {
          task_id: q.id,
          block_seq: q.blockSeq,
          decision: 'deny',
          text: undefined,
        }),
      ),
    ).toBe('invalid_arguments')
  })

  test('approve：节点送达前复核通过后任务继续', async () => {
    const env = await setup()
    const id = await create(env)
    const lease = await grant(env, 'fake')
    const { blockSeq } = blockApproval(env, lease)
    await env.settle()
    const { caller } = await replyCaller(env)
    must(
      respond(env, caller, {
        task_id: id,
        block_seq: blockSeq,
        decision: 'approve',
        text: undefined,
      }),
    )
    const renewed = must(
      env.protocol.service.renew(lease.lease_id, { lease_token: lease.lease_token }),
    )
    expect(renewed.reply).toMatchObject({ kind: 'approve', by: 'supervisor' })
    must(
      env.protocol.service.ackReply(lease.lease_id, {
        lease_token: lease.lease_token,
        reply_id: renewed.reply?.reply_id ?? '',
      }),
    )
    expect(env.store.getTask(id)?.status).toBe('running')
  })

  test('escalate：写 task.reply_escalated{reason: supervisor}（actor hub，带说明），条目不再被挡住', async () => {
    const env = await setup()
    const { id, blockSeq, caller } = await delegatedQuestion(env)
    const before = env.released()
    const r = must(
      respond(env, caller, {
        task_id: id,
        block_seq: blockSeq,
        decision: 'escalate',
        text: undefined,
        reason: '需要扩大范围，交给用户',
      }),
    )
    expect(r).toMatchObject({ decision: 'escalate', reply: null, requeued: false })
    expect(escalationsOf(env, id)[0]).toMatchObject({
      actor: 'hub',
      payload: { reason: 'supervisor', block_seq: blockSeq, note: '需要扩大范围，交给用户' },
    })
    expect(env.store.taskEvents(id).some((e) => e.type === 'task.replied')).toBe(false)
    expect(env.released()).toBeGreaterThan(before)
    expect(env.delegation.held({ id: `blk.${blockSeq}`, source: 'task', task_id: id })).toBe(false)
  })

  test('调用方核对：身份、唤醒 token、reply 唤醒、被分配的唤醒、workspace', async () => {
    const env = await setup()
    const { id, blockSeq, caller } = await delegatedQuestion(env)
    const req = { task_id: id, block_seq: blockSeq }
    expect(code(respond(env, caller, req, 'user'))).toBe('role_not_allowed')
    expect(code(respond(env, caller, req, 'codex'))).toBe('role_not_allowed')
    expect(code(respond(env, null, req))).toBe('scope_denied')
    // 普通唤醒的 token：not_delegated。
    expect(code(respond(env, { ...caller, task_id: 't-nope' }, req))).toBe('not_delegated')
    // 伪造的租约 id。
    expect(code(respond(env, { ...caller, lease_id: 'l-fake' }, req))).toBe('not_delegated')
    // 另一个任务的委托由另一个 reply 唤醒处理：本唤醒不能回复它。
    const other = await create(env)
    const ol = await grant(env, 'fake')
    const otherBlock = blockQuestion(env, ol)
    await env.settle()
    expect(code(respond(env, caller, { task_id: other, block_seq: otherBlock }))).toBe(
      'not_delegated',
    )
    // 不存在的任务。
    expect(code(respond(env, caller, { task_id: 't-404', block_seq: 1 }))).toBe('not_delegated')
    // 什么都没写。
    expect(env.store.taskEvents(id).some((e) => e.type === 'task.replied')).toBe(false)
  })

  test('其他 workspace 的任务：not_delegated', async () => {
    const env = await setup()
    const { caller } = await delegatedQuestion(env)
    const g = await create(env, { workspace: 'ws/global' })
    const gl = await grant(env, 'fake')
    const gb = blockQuestion(env, gl)
    await env.settle()
    expect(code(respond(env, caller, { task_id: g, block_seq: gb }))).toBe('not_delegated')
  })

  test('回复未委托的卡住（策略判定为 user）：not_delegated，任务保持 blocked', async () => {
    const env = await setup()
    const { caller } = await delegatedQuestion(env)
    const id = await create(env)
    const lease = await grant(env, 'fake')
    const { blockSeq } = blockApproval(env, lease, { level: 'user' })
    await env.settle()
    expect(
      code(
        respond(env, caller, {
          task_id: id,
          block_seq: blockSeq,
          decision: 'approve',
          text: undefined,
        }),
      ),
    ).toBe('not_delegated')
    expect(env.store.getTask(id)?.status).toBe('blocked')
  })

  test('block_seq 不是当前卡住：stale_block', async () => {
    const env = await setup()
    const { id, blockSeq, caller } = await delegatedQuestion(env)
    expect(code(respond(env, caller, { task_id: id, block_seq: blockSeq - 1 }))).toBe('stale_block')
  })

  test('reply 唤醒的租约过期后不能回复', async () => {
    const env = await setup()
    const { id, blockSeq, caller } = await delegatedQuestion(env)
    await env.clock.advance(TTL * 1000 + 1)
    expect(code(respond(env, caller, { task_id: id, block_seq: blockSeq }))).toBe('not_delegated')
  })

  test('竞态：supervisor 先回复，用户随后回复得到 reply_pending', async () => {
    const env = await setup()
    const { id, blockSeq, caller } = await delegatedQuestion(env)
    must(respond(env, caller, { task_id: id, block_seq: blockSeq }))
    expect(code(env.tasks.replyTask(id, { kind: 'text', text: 'B' }, { actor: 'user' }))).toBe(
      'reply_pending',
    )
  })

  test('竞态：超时与回复并发，以 store 事务先后为准', async () => {
    // 回复先到：超时到点不再转交。
    const env = await setup()
    const a = await delegatedQuestion(env)
    must(respond(env, a.caller, { task_id: a.id, block_seq: a.blockSeq }))
    await env.clock.advance(600_000)
    await env.settle()
    expect(escalationsOf(env, a.id)).toHaveLength(0)
    // 超时先到：随后的回复 stale_block。
    const env2 = await setup()
    const b = await delegatedQuestion(env2)
    await env2.clock.advance(600_000)
    await env2.settle()
    expect(code(respond(env2, b.caller, { task_id: b.id, block_seq: b.blockSeq }))).toBe(
      'stale_block',
    )
  })

  test('task_reply 对 supervisor 仍返回 user_only', async () => {
    const env = await setup()
    const { id } = await delegatedQuestion(env)
    expect(
      code(env.tasks.replyTask(id, { kind: 'text', text: 'A' }, { actor: 'supervisor' })),
    ).toBe('user_only')
  })

  test('store 兜底：supervisor 的回复必须 via supervisor 且落在有效委托上；其他身份不能声称 via supervisor', async () => {
    const env = await setup()
    const id = await create(env)
    const lease = await grant(env, 'fake')
    blockQuestion(env, lease, { no_delegate: true })
    await env.settle()
    const replied = (actor: string, via: string) =>
      env.store.append(
        {
          task_id: id,
          workspace: WS,
          type: 'task.replied',
          payload: { reply_id: `r-${actor}`, kind: 'text', text: 'A', via: via as 'cli' },
        },
        { actor },
      )
    expect(code(replied('supervisor', 'supervisor'))).toBe('not_delegated')
    expect(code(replied('supervisor', 'cli'))).toBe('invalid_event')
    expect(code(replied('user', 'supervisor'))).toBe('invalid_event')
  })
})

describe('重启恢复', () => {
  test('委托与 deadline 由账本恢复：重启后的服务按原 deadline 转交', async () => {
    const env = await setup()
    const { id, blockSeq } = await delegatedQuestion(env)
    env.delegation.stop()
    env.scheduler.stop()
    await env.clock.advance(300_000)
    const again = await setup({ store: env.store, clock: env.clock })
    await again.settle()
    expect(again.delegation.held({ id: `blk.${blockSeq}`, source: 'task', task_id: id })).toBe(true)
    await again.clock.advance(299_000)
    expect(escalationsOf(again, id)).toHaveLength(0)
    await again.clock.advance(1_000)
    await again.settle()
    expect(escalationsOf(again, id)[0]).toMatchObject({ payload: { reason: 'timeout' } })
  })

  test('停机期间 reply 唤醒结束：启动时补写 wake_ended', async () => {
    const env = await setup()
    const { id, wakeLease } = await delegatedQuestion(env)
    env.delegation.stop()
    must(
      env.protocol.service.complete(wakeLease.lease_id, {
        lease_token: wakeLease.lease_token,
        outcome: 'done',
        result: { summary: '结束', executor: 'claude-sdk', node_id: 'n1' },
      } as never),
    )
    expect(escalationsOf(env, id)).toHaveLength(0)
    const again = await setup({ store: env.store, clock: env.clock })
    await again.settle()
    expect(escalationsOf(again, id)[0]).toMatchObject({ payload: { reason: 'wake_ended' } })
  })

  test('停机前卡住、还没判定：启动时补判定', async () => {
    const env = await setup()
    env.delegation.stop()
    const id = await create(env)
    const lease = await grant(env, 'fake')
    blockQuestion(env, lease)
    await tick()
    expect(delegationsOf(env, id)).toHaveLength(0)
    const again = await setup({ store: env.store, clock: env.clock })
    await again.settle()
    expect(delegationsOf(again, id)).toHaveLength(1)
  })

  test('账本重建：委托、supervisor 回复与转交都能重放', async () => {
    const env = await setup()
    const a = await delegatedQuestion(env)
    must(respond(env, a.caller, { task_id: a.id, block_seq: a.blockSeq }))
    const renewed = must(
      env.protocol.service.renew(a.lease.lease_id, { lease_token: a.lease.lease_token }),
    )
    must(
      env.protocol.service.ackReply(a.lease.lease_id, {
        lease_token: a.lease.lease_token,
        reply_id: renewed.reply?.reply_id ?? '',
      }),
    )
    const b = blockQuestion(env, a.lease, { message: '再问一次' })
    await env.settle()
    must(env.tasks.replyTask(a.id, { kind: 'text', text: '用户来答' }, { actor: 'user' }))
    expect(escalationsOf(env, a.id)[0]).toMatchObject({
      payload: { reason: 'user_replied', block_seq: b },
    })
    const before = env.store.snapshot({ includeSoft: false })
    must(env.store.rebuild())
    expect(env.store.snapshot({ includeSoft: false })).toEqual(before)
  })
})

describe('收件箱：委托期间不推送（inbox spec "委托给 supervisor 的条目"）', () => {
  async function withInbox(o: SetupOptions = {}) {
    const env = await setup(o)
    const channel = new MemoryChannel()
    const inbox = await startInbox({
      ledger: env.store,
      home: join(mkdtempSync(join(tmpdir(), 'flow-delegation-inbox-')), 'home'),
      clock: env.clock,
      watch: false,
      channels: [specOf(channel)],
      held: env.delegation.held,
      logger: { warn() {} },
    })
    cleanups.push(() => inbox.stop())
    const settle = async () => {
      for (let i = 0; i < 4; i++) {
        await env.settle()
        await inbox.idle()
        await inbox.pusher.tick()
        await env.clock.advance(0)
      }
    }
    return { env, channel, inbox, settle }
  }

  test('Interrupt 级的授权请求委托后不推送，标"supervisor 处理中"；超时转交时推送并注明原因', async () => {
    const { env, channel, settle } = await withInbox()
    const id = await create(env)
    const lease = await grant(env, 'fake')
    const { blockSeq } = blockApproval(env, lease)
    await settle()
    const item = env.store.getInboxItem(`blk.${blockSeq}`)
    expect(item?.level).toBe('interrupt')
    expect(item?.title.startsWith(DELEGATED_TITLE_PREFIX)).toBe(true)
    expect(channel.sentIds().flat()).not.toContain(`blk.${blockSeq}`)
    await env.clock.advance(600_000)
    await settle()
    const after = env.store.getInboxItem(`blk.${blockSeq}`)
    expect(after?.title.startsWith(DELEGATED_TITLE_PREFIX)).toBe(false)
    expect(after?.body).toContain('supervisor 超时未回复')
    expect(channel.sentIds().flat()).toContain(`blk.${blockSeq}`)
    expect(escalationsOf(env, id)).toHaveLength(1)
  })

  test('supervisor escalate：按原级别推送，条目注明 supervisor 给出的理由', async () => {
    const { env, channel, settle } = await withInbox()
    const id = await create(env)
    const lease = await grant(env, 'fake')
    const blockSeq = blockQuestion(env, lease)
    await settle()
    expect(channel.sentIds().flat()).not.toContain(`blk.${blockSeq}`)
    const { caller } = await replyCaller(env)
    must(
      respond(env, caller, {
        task_id: id,
        block_seq: blockSeq,
        decision: 'escalate',
        text: undefined,
        reason: '拿不准，需要用户决定',
      }),
    )
    await settle()
    expect(channel.sentIds().flat()).toContain(`blk.${blockSeq}`)
    expect(env.store.getInboxItem(`blk.${blockSeq}`)?.body).toContain('拿不准，需要用户决定')
  })

  test('supervisor 回复后条目在任务恢复时关闭，记录回复者为 supervisor，始终没有推送', async () => {
    const { env, channel, settle } = await withInbox()
    const id = await create(env)
    const lease = await grant(env, 'fake')
    const blockSeq = blockQuestion(env, lease)
    await settle()
    const { caller } = await replyCaller(env)
    must(respond(env, caller, { task_id: id, block_seq: blockSeq }))
    await settle()
    // 回复未送达、任务仍卡着：条目保持打开，仍不推送。
    expect(env.store.getInboxItem(`blk.${blockSeq}`)?.state).toBe('open')
    const renewed = must(
      env.protocol.service.renew(lease.lease_id, { lease_token: lease.lease_token }),
    )
    must(
      env.protocol.service.ackReply(lease.lease_id, {
        lease_token: lease.lease_token,
        reply_id: renewed.reply?.reply_id ?? '',
      }),
    )
    await settle()
    const item = env.store.getInboxItem(`blk.${blockSeq}`)
    expect(item?.closed).toMatchObject({ reason: 'task_running', cause_actor: 'supervisor' })
    expect(channel.sentIds().flat()).not.toContain(`blk.${blockSeq}`)
  })

  test('不委托的卡住照常推送', async () => {
    const { env, channel, settle } = await withInbox({ supervisor: { delegate_replies: false } })
    await create(env)
    const lease = await grant(env, 'fake')
    const blockSeq = blockQuestion(env, lease)
    await settle()
    expect(channel.sentIds().flat()).toContain(`blk.${blockSeq}`)
  })
})

describe('每日摘要列出 supervisor 代回复的内容', () => {
  test('摘要含决定、任务、回答原文与理由', async () => {
    const env = await setup()
    const channel = new MemoryChannel()
    const inbox = await startInbox({
      ledger: env.store,
      home: join(mkdtempSync(join(tmpdir(), 'flow-delegation-digest-')), 'home'),
      clock: env.clock,
      watch: false,
      channels: [specOf(channel)],
      held: env.delegation.held,
      logger: { warn() {} },
    })
    cleanups.push(() => inbox.stop())
    const { id, blockSeq, caller } = await delegatedQuestion(env)
    must(respond(env, caller, { task_id: id, block_seq: blockSeq, text: '选 A：只改 README' }))
    // 第二天 08:30 的摘要覆盖"昨天"。
    await inbox.pusher.fireDigest(new Date(2026, 9, 27, 8, 30).getTime())
    const digest = env.store.getInboxItem('dig.2026-10-27')
    expect(digest?.body).toContain('supervisor 代回复 1 次')
    expect(digest?.body).toContain(`回答 ${id}【待送达】：选 A：只改 README`)
    expect(digest?.body).toContain('理由：目标只限 README')
  })
})

describe('端到端：提问委托 → reply 唤醒 → answer → 节点继续；授权代批准；超时转交', () => {
  test('一个普通唤醒运行时，委托的提问由并行的 reply 唤醒回答', async () => {
    const env = await setup()
    must(
      env.store.append(
        { type: 'user.instruction', workspace: WS, payload: { text: '修 README', via: 'cli' } },
        { actor: 'user' },
      ),
    )
    await env.settle()
    const normal = await grant(env, 'claude-sdk')
    expect(env.store.wakeOf(normal.task_id)?.origin).toBe('instruction')
    const id = await create(env)
    const lease = await grant(env, 'fake')
    const blockSeq = blockQuestion(env, lease)
    await env.settle()
    const { caller } = await replyCaller(env)
    expect(caller.task_id).not.toBe(normal.task_id)
    const wake = env.store.wakeOf(caller.task_id)
    expect(wake?.events).toEqual([delegationsOf(env, id)[0]?.seq ?? -1])
    const inputs = env.store.getTask(caller.task_id)?.contract.inputs?.wake
    expect(inputs?.events[0]).toMatchObject({
      type: 'task.reply_delegated',
      task_id: id,
      data: { block_seq: blockSeq, kind: 'question' },
    })
    must(respond(env, caller, { task_id: id, block_seq: blockSeq }))
    const renewed = must(
      env.protocol.service.renew(lease.lease_id, { lease_token: lease.lease_token }),
    )
    must(
      env.protocol.service.ackReply(lease.lease_id, {
        lease_token: lease.lease_token,
        reply_id: renewed.reply?.reply_id ?? '',
      }),
    )
    expect(env.store.getTask(id)?.status).toBe('running')
  })
})

describe('HTTP 路由与操作（4.9）', () => {
  async function withApp() {
    const env = await setup()
    const app = createHubApp({
      token: testToken,
      wakeTokens: env.wakeTokens,
      ledger: env.store,
      mount: [
        {
          path: '/',
          app: createSupervisorToolRoutes({
            delegation: env.delegation,
          } as unknown as SupervisorToolsDeps),
        },
        { path: '/', app: createTaskRoutes({ ledger: env.store, tasks: env.tasks }) },
      ],
    })
    const post = (path: string, body: unknown, headers: Record<string, string>) =>
      app.fetch(
        new Request(`http://hub${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
        }),
      )
    return { env, app, post }
  }

  test('reply 唤醒 token 经 HTTP 回复；user token 声明 supervisor 被拒；user 调用 role_not_allowed', async () => {
    const { env, post } = await withApp()
    const id = await create(env)
    const lease = await grant(env, 'fake')
    const blockSeq = blockQuestion(env, lease)
    await env.settle()
    const wake = await grant(env, 'claude-sdk')
    const wakeAuth = { Authorization: `Bearer ${wake.wake_token}` }
    const body = {
      task_id: id,
      block_seq: blockSeq,
      decision: 'answer',
      text: '选 A',
      reason: '范围内',
    }
    // 冒用：user token + X-Flow-Actor: supervisor。
    const spoof = await post('/v1/supervisor/respond', body, {
      ...authHeaders,
      'X-Flow-Actor': 'supervisor',
    })
    expect(spoof.status).toBe(403)
    expect(((await spoof.json()) as { error: { code: string } }).error.code).toBe('reserved_actor')
    const asUser = await post('/v1/supervisor/respond', body, authHeaders)
    expect(((await asUser.json()) as { error: { code: string } }).error.code).toBe(
      'role_not_allowed',
    )
    // answer 缺 text：invalid_arguments。
    const bad = await post('/v1/supervisor/respond', { ...body, text: undefined }, wakeAuth)
    expect(bad.status).toBe(400)
    // 通用 task_reply 对 supervisor：user_only。
    const reply = await post(`/v1/tasks/${id}/reply`, { kind: 'text', text: 'A' }, wakeAuth)
    expect(((await reply.json()) as { error: { code: string } }).error.code).toBe('user_only')
    const okRes = await post('/v1/supervisor/respond', body, wakeAuth)
    expect(okRes.status).toBe(200)
    const data = ((await okRes.json()) as { data: { reply: { by: string } } }).data
    expect(data.reply.by).toBe('supervisor')
    const again = await post('/v1/supervisor/respond', body, wakeAuth)
    expect(again.status).toBe(409)
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe('stale_block')
  })

  test('task_respond 操作：只有 supervisor；reply 唤醒的 MCP 绑定放行它；在 operations 中', () => {
    expect(operations.some((op) => op.name === 'task_respond')).toBe(true)
    expect(taskRespondOp.replyAllowed).toBe(true)
    const input = {
      task_id: 't-1',
      block_seq: 3,
      decision: 'answer' as const,
      text: 'A',
      reason: 'r',
    }
    expect(applyBinding(taskRespondOp, input, { workspace: WS, replyOnly: true }).ok).toBe(true)
    expect(code(applyBinding(briefUpdateOp, {} as never, { workspace: WS, replyOnly: true }))).toBe(
      'reply_only_wake',
    )
    expect(taskRespondOp.input.safeParse({ ...input, text: undefined }).success).toBe(false)
    expect(taskRespondOp.input.safeParse({ ...input, decision: 'approve' }).success).toBe(false)
    expect(
      taskRespondOp.input.safeParse({ ...input, decision: 'escalate', text: undefined }).success,
    ).toBe(true)
    expect(taskRespondOp.input.safeParse({ ...input, text: 'x'.repeat(2001) }).success).toBe(false)
  })

  test('task_respond 操作的本地预检：其他身份 role_not_allowed', async () => {
    const r = await taskRespondOp.run(
      { task_id: 't-1', block_seq: 3, decision: 'escalate', reason: 'r' },
      { home: '/nonexistent', actor: 'codex', via: 'mcp' },
    )
    expect(code(r)).toBe('role_not_allowed')
  })
})

describe('推送：被挡住的条目不计入 Decide 提前推送阈值', () => {
  test('5 个 Decide 条目中 1 个被挡住时不提前推送；放开后推送', async () => {
    const clock = new FakeClock(T0)
    const t = await tempLedger({ now: clock.now })
    cleanups.push(t.cleanup)
    const channel = new MemoryChannel()
    let holding = true
    const inbox = await startInbox({
      ledger: t.store,
      home: join(mkdtempSync(join(tmpdir(), 'flow-delegation-held-')), 'home'),
      clock,
      watch: false,
      channels: [specOf(channel)],
      held: (item) => holding && item.id === 'sup.5',
      logger: { warn() {} },
    })
    cleanups.push(() => inbox.stop())
    for (const id of ['sup.1', 'sup.2', 'sup.3', 'sup.4', 'sup.5'])
      createItem(t.store, id, 'decide')
    await inbox.pusher.tick()
    await clock.advance(0)
    expect(channel.sentIds()).toEqual([])
    holding = false
    await inbox.pusher.tick()
    await clock.advance(0)
    expect(channel.sentIds().flat().sort()).toEqual(['sup.1', 'sup.2', 'sup.3', 'sup.4', 'sup.5'])
  })
})

describe('纵深防御（审查后补充）', () => {
  test('请求取消：委托结束，条目恢复标题并立即推送', async () => {
    const env = await setup()
    const channel = new MemoryChannel()
    const inbox = await startInbox({
      ledger: env.store,
      home: join(mkdtempSync(join(tmpdir(), 'flow-delegation-cancel-')), 'home'),
      clock: env.clock,
      watch: false,
      channels: [specOf(channel)],
      held: env.delegation.held,
      logger: { warn() {} },
    })
    cleanups.push(() => inbox.stop())
    const settle = async () => {
      for (let i = 0; i < 4; i++) {
        await env.settle()
        await inbox.idle()
        await inbox.pusher.tick()
        await env.clock.advance(0)
      }
    }
    const id = await create(env)
    const lease = await grant(env, 'fake')
    const blockSeq = blockQuestion(env, lease)
    await settle()
    expect(channel.sentIds().flat()).not.toContain(`blk.${blockSeq}`)
    const released = env.released()
    must(env.tasks.cancelTask(id, { actor: 'user' }))
    await settle()
    expect(env.released()).toBeGreaterThan(released)
    const item = env.store.getInboxItem(`blk.${blockSeq}`)
    expect(item?.title.startsWith(DELEGATED_TITLE_PREFIX)).toBe(false)
    expect(channel.sentIds().flat()).toContain(`blk.${blockSeq}`)
  })

  test('store：判定之后、卡住之前还有别的策略判定时不能委托', async () => {
    const env = await setup()
    const id = await create(env)
    const lease = await grant(env, 'fake')
    const first = must(
      env.store.append(
        {
          task_id: id,
          workspace: WS,
          type: 'policy.decided',
          payload: {
            task_id: id,
            request: { tool: 'CodexCommand', command: 'pnpm check', actions: [] },
            level: 'supervisor',
            matched_rules: [],
            actions: [],
          },
        },
        { actor: 'policy' },
      ),
    )
    // 第二个请求的判定（例如预检之后 worker 又发起了别的请求）：卡住带的是第一个判定。
    blockApproval(env, lease, { withDecision: false })
    const blockSeq = blockSeqOf(env, id)
    const r = env.store.append(
      {
        task_id: id,
        workspace: WS,
        type: 'task.reply_delegated',
        payload: {
          task_id: id,
          block_seq: blockSeq,
          kind: 'awaiting_approval',
          decision_id: first.seq,
          deadline: '2099-01-01T00:00:00.000Z',
        },
      },
      { actor: 'hub' },
    )
    expect(code(r)).toBe('invalid_event')
  })

  test('store：判定早于这一轮执行开始（task.started）时不能委托', async () => {
    const env = await setup()
    const id = await create(env)
    const decided = must(
      env.store.append(
        {
          task_id: id,
          workspace: WS,
          type: 'policy.decided',
          payload: {
            task_id: id,
            request: { tool: 'CodexCommand', command: 'pnpm check', actions: [] },
            level: 'supervisor',
            matched_rules: [],
            actions: [],
          },
        },
        { actor: 'policy' },
      ),
    )
    const lease = await grant(env, 'fake')
    must(
      env.protocol.service.renew(lease.lease_id, {
        lease_token: lease.lease_token,
        blocked: {
          reason: 'awaiting_approval',
          message: '等待授权',
          decision_id: decided.seq,
          request: { tool: 'CodexCommand', command: 'pnpm check' },
        },
      }),
    )
    await env.settle()
    expect(delegationsOf(env, id)).toHaveLength(0)
  })

  test('判定超时（读配置挂起）：不委托、放开条目，串行链不被堵住', async () => {
    let hang = false
    const roles: RoleLookup = async (name) => {
      if (hang && name === 'developer') return new Promise(() => {})
      return ok((ROLES[name] ?? null) as Role | null)
    }
    const env = await setup({ roles })
    const id = await create(env)
    const lease = await grant(env, 'fake')
    hang = true
    const blockSeq = blockQuestion(env, lease)
    // 判定挂起中（不等 delegation.idle()：它要等到判定结束）。
    for (let i = 0; i < 3; i++) await tick()
    expect(env.delegation.held({ id: `blk.${blockSeq}`, source: 'task', task_id: id })).toBe(true)
    await env.clock.advance(30_000)
    await env.settle()
    expect(env.delegation.held({ id: `blk.${blockSeq}`, source: 'task', task_id: id })).toBe(false)
    expect(delegationsOf(env, id)).toHaveLength(0)
    // 之后的判定照常进行。
    hang = false
    const other = await create(env)
    const ol = await grant(env, 'fake')
    blockQuestion(env, ol)
    await env.settle()
    expect(delegationsOf(env, other)).toHaveLength(1)
  })

  test('store：task.replied 只接受 user 与 supervisor；supervisor 的回复类型必须与卡住类型一致', async () => {
    const env = await setup()
    const { id } = await delegatedQuestion(env)
    const reply = (actor: string, kind: 'approve' | 'text', via: 'cli' | 'supervisor') =>
      env.store.append(
        {
          task_id: id,
          workspace: WS,
          type: 'task.replied',
          payload: {
            reply_id: `r-${actor}-${kind}`,
            kind,
            via,
            ...(kind === 'text' ? { text: 'A' } : {}),
          },
        },
        { actor },
      )
    expect(code(reply('hub', 'text', 'cli'))).toBe('actor_mismatch')
    expect(code(reply('codex', 'text', 'cli'))).toBe('actor_mismatch')
    expect(code(reply('supervisor', 'approve', 'supervisor'))).toBe('invalid_event')
    must(reply('supervisor', 'text', 'supervisor'))
  })

  test('supervisor 的回复待送达时，用户忽略条目被拒绝（reply_pending）', async () => {
    const env = await setup()
    const reactor = createInboxReactor({ ledger: env.store })
    reactor.start()
    cleanups.push(() => reactor.stop())
    const { id, blockSeq, caller } = await delegatedQuestion(env)
    must(respond(env, caller, { task_id: id, block_seq: blockSeq }))
    await reactor.idle()
    const deps = {
      ledger: env.store,
      tasks: env.tasks,
      home: '/nonexistent',
      scanProposals: async () => {},
    }
    const r = await actOnInbox(deps, `blk.${blockSeq}`, { action: 'dismiss', via: 'cli' }, 'user')
    expect(code(r)).toBe('reply_pending')
    expect(env.store.getInboxItem(`blk.${blockSeq}`)?.state).toBe('open')
  })
})
