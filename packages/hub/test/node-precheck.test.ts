import { afterEach, describe, expect, test } from 'bun:test'
import { ackReplyRequest } from '@flow/core'
import {
  createNodeProtocol,
  createTaskService,
  type LedgerStore,
  type NodeProtocol,
} from '../src/index.ts'
import { leaseTokenMatches, policyContext } from '../src/policy/routes.ts'
import { anyRole, contractInput, must, tempLedger } from './ledger-helpers.ts'
import { FakeClock } from './server-fixtures.ts'

/**
 * ④ G9（tasks 5.6）中枢侧：续约上报任务分支与 worktree、ack-reply 拒收（dropped）、
 * 卡住附带的请求文本，以及 policy/check 的上下文组装（只认节点上报的环境字段）。
 */

const T0 = Date.parse('2026-10-26T08:00:00.000Z')
const TTL = 60

interface Ctx {
  ledger: LedgerStore
  clock: FakeClock
  protocol: NodeProtocol
  create(over?: Record<string, unknown>): Promise<string>
}

let cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups) c()
  cleanups = []
})

async function setup(caps = ['executor:fake', 'executor:codex-orca']): Promise<Ctx> {
  const clock = new FakeClock(T0)
  const t = await tempLedger({ now: clock.now })
  const protocol = createNodeProtocol({ ledger: t.store, clock, leaseTtlS: TTL, leaseWaitMaxS: 30 })
  cleanups.push(() => {
    protocol.stop()
    t.cleanup()
  })
  const tasks = createTaskService({
    ledger: t.store,
    workspaceExists: () => true,
    roles: anyRole,
    now: clock.now,
  })
  must(
    protocol.service.registerNode(
      { node_id: 'n1', hostname: 'host', version: '0.0.0', capabilities: caps },
      'unknown',
    ),
  )
  return {
    ledger: t.store,
    clock,
    protocol,
    async create(over = {}) {
      const c = await tasks.createTask(contractInput(over), { actor: 'user' })
      if (!c.ok) throw new Error(c.error.message)
      return c.data.task.id
    },
  }
}

async function grant(ctx: Ctx, caps = ['executor:fake', 'executor:codex-orca']) {
  const r = await ctx.protocol.service.acquire({ node_id: 'n1', capabilities: caps, wait_s: 0 })
  if (!r.ok || !r.data.lease) throw new Error('没有领到租约')
  return r.data.lease
}

const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? 'ok' : r.error?.code)

describe('续约上报任务分支（task.branch_reported）', () => {
  test('codex-orca：写入分支与 worktree，只写一次，之后的上报被忽略且不影响续约', async () => {
    const ctx = await setup()
    const id = await ctx.create({ executor: 'codex-orca' })
    const lease = await grant(ctx)
    const renew = (branch: string, worktree: string) =>
      ctx.protocol.service.renew(lease.lease_id, {
        lease_token: lease.lease_token,
        branch: { branch, worktree },
      })
    expect(code(renew('ustclhx/t-1', '/w/t-1'))).toBe('ok')
    expect(ctx.ledger.getTask(id)).toMatchObject({ branch: 'ustclhx/t-1', worktree: '/w/t-1' })
    const reported = ctx.ledger.taskEvents(id).filter((e) => e.type === 'task.branch_reported')
    expect(reported).toHaveLength(1)
    expect(reported[0]).toMatchObject({
      actor: 'node:n1',
      payload: { branch: 'ustclhx/t-1', worktree: '/w/t-1' },
    })
    // 不可更改：再次上报（含不同的值）被忽略，续约照常成功。
    expect(code(renew('ustclhx/other', '/w/other'))).toBe('ok')
    expect(ctx.ledger.getTask(id)).toMatchObject({ branch: 'ustclhx/t-1', worktree: '/w/t-1' })
    expect(ctx.ledger.taskEvents(id).filter((e) => e.type === 'task.branch_reported')).toHaveLength(
      1,
    )
  })

  test('首次上报固定快照；之后的租约随 grant 下发快照', async () => {
    const ctx = await setup()
    const id = await ctx.create({ executor: 'codex-orca', retry: { max_attempts: 2 } })
    const lease = await grant(ctx)
    const snapshot = { remote_url: 'https://github.com/acme/demo.git', default_branch: 'main' }
    const r = must(
      ctx.protocol.service.renew(lease.lease_id, {
        lease_token: lease.lease_token,
        branch: { branch: 'ustclhx/t-1', worktree: '/w/t-1', repo_snapshot: snapshot },
      }),
    )
    expect(r.branch_report).toBe('recorded')
    expect(ctx.ledger.getTask(id)?.repo_snapshot).toEqual(snapshot)
    // 下一次领取（例如重试）：grant 带上投影里的快照。
    must(
      ctx.protocol.service.complete(lease.lease_id, {
        lease_token: lease.lease_token,
        outcome: 'blocked',
        blocked_reason: 'question',
        message: '？',
      }),
    )
    must(
      ctx.ledger.append(
        { task_id: id, workspace: 'ws/demo', type: 'task.requeued', payload: { reason: 'manual' } },
        { actor: 'user' },
      ),
    )
    const next = await grant(ctx)
    expect(next.repo_snapshot).toEqual(snapshot)
  })

  test('worktree 缺失的旧任务可补报一次 worktree（分支相同），不补快照', async () => {
    const ctx = await setup()
    const id = await ctx.create({ executor: 'codex-orca' })
    const lease = await grant(ctx)
    // G9 之前的旧事件：只有分支。
    must(
      ctx.ledger.append(
        {
          task_id: id,
          workspace: 'ws/demo',
          type: 'task.branch_reported',
          payload: { branch: 'ustclhx/t-1' },
        },
        { actor: 'node:n1' },
      ),
    )
    const snapshot = { remote_url: 'https://github.com/acme/demo.git', default_branch: 'main' }
    const renew = (branch: string, worktree: string) =>
      must(
        ctx.protocol.service.renew(lease.lease_id, {
          lease_token: lease.lease_token,
          branch: { branch, worktree, repo_snapshot: snapshot },
        }),
      )
    // 分支不同不能补报（忽略）。
    expect(renew('ustclhx/other', '/w/other').branch_report).toBe('ignored')
    expect(ctx.ledger.getTask(id)).toMatchObject({ branch: 'ustclhx/t-1', worktree: null })
    expect(renew('ustclhx/t-1', '/w/t-1').branch_report).toBe('recorded')
    expect(ctx.ledger.getTask(id)).toMatchObject({
      branch: 'ustclhx/t-1',
      worktree: '/w/t-1',
      repo_snapshot: null,
    })
    // 补报之后不可再改。
    expect(renew('ustclhx/t-1', '/w/t-2').branch_report).toBe('ignored')
    expect(ctx.ledger.getTask(id)?.worktree).toBe('/w/t-1')
    // store 也拒绝带快照的补报。
    const store = ctx.ledger.append(
      {
        task_id: id,
        workspace: 'ws/demo',
        type: 'task.branch_reported',
        payload: { branch: 'ustclhx/t-1', worktree: '/w/t-1', repo_snapshot: snapshot },
      },
      { actor: 'node:n1' },
    )
    expect(code(store)).not.toBe('ok')
  })

  test('分支写入在续约生效之后：确定性失败返回 ignored、续约照常；数据库忙返回 retry', async () => {
    const ctx = await setup()
    const id = await ctx.create({ executor: 'codex-orca' })
    const lease = await grant(ctx)
    const append = ctx.ledger.append.bind(ctx.ledger)
    let mode: 'fail' | 'busy' = 'fail'
    ctx.ledger.append = ((draft, opts) => {
      if (draft.type !== 'task.branch_reported') return append(draft, opts)
      if (mode === 'busy') {
        throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
      }
      return { ok: false, error: { kind: 'failure', code: 'internal_error', message: '模拟' } }
    }) as typeof ctx.ledger.append
    const renew = () =>
      ctx.protocol.service.renew(lease.lease_id, {
        lease_token: lease.lease_token,
        activity: [{ ts: new Date(T0).toISOString(), kind: 'output', text: 'x' }],
        branch: { branch: 'ustclhx/t-1', worktree: '/w/t-1' },
      })
    const before = ctx.ledger.getLease(lease.lease_id)?.expires_at
    ctx.clock.time += 10_000
    const failed = must(renew())
    expect(failed.branch_report).toBe('ignored')
    // 续约照常生效：活动已记录、到期时间顺延。
    expect(ctx.ledger.taskActivity(id)).toHaveLength(1)
    expect(failed.expires_at > (before ?? '')).toBe(true)
    mode = 'busy'
    expect(must(renew()).branch_report).toBe('retry')
    ctx.ledger.append = append
    expect(must(renew()).branch_report).toBe('recorded')
    expect(ctx.ledger.getTask(id)?.branch).toBe('ustclhx/t-1')
  })

  test('非 codex-orca 任务的上报被 store 拒绝，但续约不失败、投影没有分支', async () => {
    const ctx = await setup()
    const id = await ctx.create()
    const lease = await grant(ctx)
    const r = ctx.protocol.service.renew(lease.lease_id, {
      lease_token: lease.lease_token,
      branch: { branch: 'ustclhx/t-1', worktree: '/w/t-1' },
    })
    expect(code(r)).toBe('ok')
    expect(ctx.ledger.getTask(id)).toMatchObject({ branch: null, worktree: null })
  })

  test('协议：worktree 必须是绝对路径，分支名按 taskBranch 校验', async () => {
    const ctx = await setup()
    await ctx.create({ executor: 'codex-orca' })
    const lease = await grant(ctx)
    for (const branch of [
      { branch: 'ustclhx/t-1', worktree: 'relative/path' },
      { branch: '-x', worktree: '/w/t-1' },
      { branch: 'a..b', worktree: '/w/t-1' },
      { branch: 'ustclhx/t-1', worktree: '/w/t\n1' },
    ]) {
      const r = ctx.protocol.service.renew(lease.lease_id, {
        lease_token: lease.lease_token,
        branch,
      })
      expect(code(r)).toBe('invalid_arguments')
    }
  })
})

/** 授权卡住（带 decision_id 与请求文本），并由 supervisor 写入一条批准。 */
async function delegatedApprove(ctx: Ctx) {
  const id = await ctx.create()
  const lease = await grant(ctx)
  const decided = must(
    ctx.ledger.append(
      {
        task_id: id,
        workspace: 'ws/demo',
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
    ctx.protocol.service.renew(lease.lease_id, {
      lease_token: lease.lease_token,
      blocked: {
        reason: 'awaiting_approval',
        message: '等待授权：pnpm check',
        decision_id: decided.seq,
        request: { tool: 'CodexCommand', command: 'pnpm check', reason: '运行检查' },
        diff_stat: ' README.md | 2 ++\n 1 file changed, 2 insertions(+)',
      },
    }),
  )
  // 中枢委托给 supervisor（D15）：supervisor 的回复只能落在有效的委托上（store 校验）。
  const blockSeq = ctx.ledger
    .taskEvents(id)
    .filter((e) => e.type === 'task.blocked')
    .at(-1)?.seq
  must(
    ctx.ledger.append(
      {
        task_id: id,
        workspace: 'ws/demo',
        type: 'task.reply_delegated',
        payload: {
          task_id: id,
          block_seq: blockSeq ?? 0,
          kind: 'awaiting_approval',
          decision_id: decided.seq,
          deadline: '2099-01-01T00:00:00.000Z',
        },
      },
      { actor: 'hub' },
    ),
  )
  return { id, lease, decisionId: decided.seq }
}

describe('卡住附带的请求文本与改动摘要', () => {
  test('task.blocked 与任务视图带 decision_id、request、diff_stat', async () => {
    const ctx = await setup()
    const { id, decisionId } = await delegatedApprove(ctx)
    expect(ctx.ledger.getTask(id)?.blocked).toMatchObject({
      reason: 'awaiting_approval',
      decision_id: decisionId,
      request: { tool: 'CodexCommand', command: 'pnpm check', reason: '运行检查' },
      diff_stat: ' README.md | 2 ++\n 1 file changed, 2 insertions(+)',
    })
  })

  test('请求文本中的疑似密钥在入账前脱敏', async () => {
    const ctx = await setup()
    const id = await ctx.create()
    const lease = await grant(ctx)
    const fake = `ghp_${'Ab9'.repeat(12)}`
    must(
      ctx.protocol.service.renew(lease.lease_id, {
        lease_token: lease.lease_token,
        blocked: {
          reason: 'awaiting_approval',
          message: '等待授权',
          request: { tool: 'CodexCommand', command: `echo ${fake}`, reason: `token ${fake}` },
        },
      }),
    )
    const blocked = ctx.ledger.taskEvents(id).at(-1)
    expect(JSON.stringify(blocked?.payload)).not.toContain(fake)
  })
})

describe('ack-reply 拒收（dropped{reason: request_changed}）', () => {
  test('supervisor 的批准被拒收：写 task.unblocked、回复标记 dropped，之后以 no_delegate 重新卡住', async () => {
    const ctx = await setup()
    const { id, lease } = await delegatedApprove(ctx)
    must(
      ctx.ledger.append(
        {
          task_id: id,
          workspace: 'ws/demo',
          type: 'task.replied',
          payload: { reply_id: 'r-sup', kind: 'approve', via: 'supervisor', reason: '白名单内' },
        },
        { actor: 'supervisor' },
      ),
    )
    const renewed = must(
      ctx.protocol.service.renew(lease.lease_id, { lease_token: lease.lease_token }),
    )
    expect(renewed.reply).toMatchObject({ reply_id: 'r-sup', kind: 'approve', by: 'supervisor' })
    const ack = ctx.protocol.service.ackReply(lease.lease_id, {
      lease_token: lease.lease_token,
      reply_id: 'r-sup',
      outcome: 'dropped',
      reason: 'request_changed',
    })
    expect(ack.ok && ack.data.task.status).toBe('running')
    expect(ctx.ledger.getReply('r-sup')).toMatchObject({ state: 'dropped' })
    const unblocked = ctx.ledger.taskEvents(id).at(-1)
    expect(unblocked).toMatchObject({
      type: 'task.unblocked',
      actor: 'node:n1',
      payload: { dropped_reply_ids: ['r-sup'] },
    })
    expect(unblocked?.payload).not.toHaveProperty('reply_id')
    // 重复确认是幂等的。
    expect(
      code(
        ctx.protocol.service.ackReply(lease.lease_id, {
          lease_token: lease.lease_token,
          reply_id: 'r-sup',
          outcome: 'dropped',
          reason: 'request_changed',
        }),
      ),
    ).toBe('ok')
    // 节点以 no_delegate 重新上报卡住：新卡住不带 decision_id，任务视图记录 no_delegate。
    must(
      ctx.protocol.service.renew(lease.lease_id, {
        lease_token: lease.lease_token,
        blocked: { reason: 'awaiting_approval', message: '等待授权：pnpm lint', no_delegate: true },
      }),
    )
    expect(ctx.ledger.getTask(id)?.blocked).toMatchObject({
      reason: 'awaiting_approval',
      no_delegate: true,
    })
    expect(ctx.ledger.getTask(id)?.blocked).not.toHaveProperty('decision_id')
    // 续约不再返回已拒收的回复。
    expect(
      must(ctx.protocol.service.renew(lease.lease_id, { lease_token: lease.lease_token })).reply,
    ).toBeNull()
  })

  test('supervisor 的拒绝或文字回复不能拒收（只限批准）', async () => {
    const ctx = await setup()
    const { id, lease } = await delegatedApprove(ctx)
    must(
      ctx.ledger.append(
        {
          task_id: id,
          workspace: 'ws/demo',
          type: 'task.replied',
          payload: { reply_id: 'r-deny', kind: 'deny', via: 'supervisor' },
        },
        { actor: 'supervisor' },
      ),
    )
    const r = ctx.protocol.service.ackReply(lease.lease_id, {
      lease_token: lease.lease_token,
      reply_id: 'r-deny',
      outcome: 'dropped',
      reason: 'request_changed',
    })
    expect(code(r)).toBe('invalid_arguments')
    expect(ctx.ledger.getReply('r-deny')).toMatchObject({ state: 'pending' })
  })

  test('用户的回复不能拒收；dropped 必须带 reason，其他 outcome 不能带', async () => {
    const ctx = await setup()
    const { id, lease } = await delegatedApprove(ctx)
    const blockSeq = ctx.ledger.activeDelegation(id)?.block_seq ?? 0
    // 委托仍有效时，用户回复必须在同一次追加里结束委托（D15 "用户优先"）。
    must(
      ctx.ledger.appendMany(
        [
          {
            task_id: id,
            workspace: 'ws/demo',
            type: 'task.reply_escalated',
            payload: { reason: 'user_replied', block_seq: blockSeq },
          },
          {
            task_id: id,
            workspace: 'ws/demo',
            type: 'task.replied',
            payload: { reply_id: 'r-user', kind: 'approve' },
          },
        ],
        { actor: 'user' },
      ),
    )
    const r = ctx.protocol.service.ackReply(lease.lease_id, {
      lease_token: lease.lease_token,
      reply_id: 'r-user',
      outcome: 'dropped',
      reason: 'request_changed',
    })
    expect(code(r)).toBe('invalid_arguments')
    expect(ctx.ledger.getReply('r-user')).toMatchObject({ state: 'pending' })
    const token = 'x'.repeat(16)
    expect(
      ackReplyRequest.safeParse({ lease_token: token, reply_id: 'r-1', outcome: 'dropped' })
        .success,
    ).toBe(false)
    expect(
      ackReplyRequest.safeParse({
        lease_token: token,
        reply_id: 'r-1',
        outcome: 'delivered',
        reason: 'request_changed',
      }).success,
    ).toBe(false)
    expect(
      ackReplyRequest.safeParse({
        lease_token: token,
        reply_id: 'r-1',
        outcome: 'dropped',
        reason: 'other',
      }).success,
    ).toBe(false)
  })
})

describe('policy/check 上下文（policyContext）', () => {
  const task = {
    workspace: 'ws/demo',
    branch: 'ustclhx/t-1',
    worktree: '/w/t-1',
    repo_snapshot: { remote_url: 'https://github.com/acme/demo.git', default_branch: 'main' },
  }
  const report = { push_env_ok: true, gh_env_ok: true, command_cwd: '/w/t-1' }

  test('可信时带入节点上报的字段；任务分支、worktree、默认分支取自投影；remote 缺省 origin', () => {
    const ctx = policyContext(task, report, true)
    expect(ctx).toMatchObject({
      remotes: ['origin'],
      task_branch: 'ustclhx/t-1',
      task_worktree: '/w/t-1',
      default_branch: 'main',
      command_cwd: '/w/t-1',
      push_env_ok: true,
      gh_env_ok: true,
    })
    // 中枢只做字符串相等：realpath 在节点侧完成。
    expect(ctx.realpath?.('/w/./x')).toBe('/w/./x')
  })

  test('不可信时节点字段一律视为缺失；投影没有分支时也不补', () => {
    const ctx = policyContext(
      { workspace: 'ws/demo', branch: null, worktree: null, repo_snapshot: null },
      report,
      false,
    )
    expect(ctx.push_env_ok).toBe(false)
    expect(ctx.gh_env_ok).toBe(false)
    expect(ctx).not.toHaveProperty('command_cwd')
    expect(ctx).not.toHaveProperty('default_branch')
    expect(ctx).not.toHaveProperty('task_branch')
    expect(ctx).not.toHaveProperty('task_worktree')
  })

  test('默认分支只取快照：快照缺失或快照没有默认分支时不补', () => {
    expect(policyContext({ ...task, repo_snapshot: null }, report, true)).not.toHaveProperty(
      'default_branch',
    )
    expect(
      policyContext(
        { ...task, repo_snapshot: { remote_url: 'https://github.com/acme/demo.git' } },
        report,
        true,
      ),
    ).not.toHaveProperty('default_branch')
  })

  test('只有严格的 true 才算环境通过', () => {
    const ctx = policyContext(task, { ...report, push_env_ok: false }, true)
    expect(ctx.push_env_ok).toBe(false)
    expect(policyContext(task, {}, true).gh_env_ok).toBe(false)
  })

  test('租约令牌：只匹配该任务未过期的活动租约', async () => {
    const ctx = await setup()
    const id = await ctx.create()
    const other = await ctx.create()
    const lease = await grant(ctx)
    const now = ctx.clock.now()
    expect(leaseTokenMatches(ctx.ledger, id, lease.lease_token, now)).toBe(true)
    expect(leaseTokenMatches(ctx.ledger, id, `${lease.lease_token}x`, now)).toBe(false)
    expect(leaseTokenMatches(ctx.ledger, id, undefined, now)).toBe(false)
    expect(leaseTokenMatches(ctx.ledger, other, lease.lease_token, now)).toBe(false)
    expect(leaseTokenMatches(ctx.ledger, id, lease.lease_token, Date.parse(lease.expires_at))).toBe(
      false,
    )
  })
})
