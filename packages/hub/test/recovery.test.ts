import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireLeaseData, renderRecoveryPrompt } from '@raindown/core'
import { openLedger } from '../src/ledger/store.ts'
import { createTaskService } from '../src/ledger/tasks.ts'
import { recoveryForTask } from '../src/nodes/recovery.ts'
import { createNodeService } from '../src/nodes/service.ts'
import { createTaskTokenAuthority } from '../src/server/lease-tokens.ts'
import { anyRole, contractInput, must } from './ledger-helpers.ts'
import { FakeClock } from './server-fixtures.ts'

let home: string
let previousHome: string | undefined
const cleanups: (() => void)[] = []
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'raindown-recovery-'))
  previousHome = process.env.RAINDOWN_HOME
  process.env.RAINDOWN_HOME = home
})
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  if (previousHome === undefined) delete process.env.RAINDOWN_HOME
  else process.env.RAINDOWN_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

const PR = 'https://github.com/owner/repo/pull/32'
const PUSHED_SHA = 'ab'.repeat(20)

async function setup() {
  const clock = new FakeClock(Date.parse('2026-11-06T00:00:00.000Z'))
  const path = join(home, 'ledger.db')
  let ledger = await openLedger(path, { now: clock.now })
  const service = () => createNodeService({ ledger, clock, leaseTtlS: 60, leaseWaitMaxS: 0 })
  let nodes = service()
  cleanups.push(() => {
    nodes.close()
    ledger.close()
  })
  const tasks = () => createTaskService({ ledger, roles: anyRole, workspaceExists: () => true })
  const contract = contractInput({
    executor: 'codex-orca',
    cwd: home,
    retry: { max_attempts: 3 },
  })
  const task = must(await tasks().createTask(contract, { actor: 'user' })).task
  const register = () =>
    must(
      nodes.registerNode(
        {
          node_id: 'n1',
          hostname: 'test',
          version: '0.0.0',
          capabilities: ['executor:codex-orca'],
        },
        'node:n1',
      ),
    )
  register()
  const grant = async () => {
    const lease = must(
      await nodes.acquire({
        node_id: 'n1',
        capabilities: ['executor:codex-orca'],
        wait_s: 0,
      }),
    ).lease
    if (!lease) throw new Error('没有租约')
    return lease
  }
  return {
    clock,
    task,
    grant,
    tasks,
    ledger: () => ledger,
    nodes: () => nodes,
    async restart() {
      nodes.close()
      ledger.close()
      ledger = await openLedger(path, { now: clock.now })
      nodes = service()
      register()
    },
  }
}

test('首次派工不携带恢复提示', async () => {
  const ctx = await setup()
  expect(await ctx.grant()).not.toHaveProperty('recovery')
})

test('重试租约同时保留恢复事实与新派工凭证，旧派工凭证不能复用', async () => {
  const ctx = await setup()
  const tokens = createTaskTokenAuthority({ ledger: ctx.ledger })
  const nodes = createNodeService({
    ledger: ctx.ledger(),
    clock: ctx.clock,
    leaseTtlS: 60,
    leaseWaitMaxS: 0,
    issueTaskToken: (grant) => tokens.issue(grant),
    renewTaskToken: (grant) => tokens.ensure(grant),
  })
  cleanups.push(() => nodes.close())
  const acquire = async () => {
    const granted = must(
      await nodes.acquire(
        { node_id: 'n1', capabilities: ['executor:codex-orca'], wait_s: 0 },
        { actor: 'user' },
      ),
    )
    const lease = acquireLeaseData.parse(granted).lease
    if (!lease?.dispatch_token) throw new Error('派工缺少凭证')
    return lease
  }
  const first = await acquire()
  const report = must(
    ctx.ledger().append(
      {
        type: 'task.reported',
        task_id: ctx.task.id,
        workspace: ctx.task.workspace,
        payload: {
          status: 'failed',
          summary: 'PR已开出但执行器退出',
          reason: '需要恢复执行',
          attempt: first.attempt,
          lease_id: first.lease_id,
        },
      },
      { actor: ctx.task.contract.role },
    ),
  )
  must(
    nodes.complete(first.lease_id, {
      lease_token: first.lease_token,
      report_seq: report.seq,
      outcome: 'failed',
      result: {
        summary: '执行器退出',
        executor: 'codex-orca',
        node_id: 'n1',
        artifacts: [{ kind: 'pr', ref: PR }],
      },
    }),
  )
  must(await ctx.tasks().retryTask(ctx.task.id, { actor: 'user' }))
  const second = await acquire()
  expect(second).toMatchObject({
    task_id: first.task_id,
    attempt: 2,
    recovery: {
      previous_end: {
        attempt: 1,
        reason: 'failed',
        last_report: 'PR已开出但执行器退出',
        message: 'PR已开出但执行器退出',
      },
      prs: [PR],
    },
  })
  expect(second.dispatch_token).not.toBe(first.dispatch_token)
  expect(tokens.authenticate(first.dispatch_token as string)).toBeNull()
  expect(tokens.authenticate(second.dispatch_token as string)).toMatchObject({
    task_id: first.task_id,
    attempt: 2,
  })
})

test('节点重启后租约过期重新派工：保留账本分支，忽略临时 activity 中的 PR 和 push', async () => {
  const ctx = await setup()
  const first = await ctx.grant()
  must(
    ctx.nodes().renew(first.lease_id, {
      lease_token: first.lease_token,
      branch: { branch: 'task/recovery', worktree: join(home, 'deleted-worktree') },
      activity: [
        {
          ts: new Date(ctx.clock.now()).toISOString(),
          kind: 'status',
          data: { prs: [PR, '不合法的链接'], pushed_sha: PUSHED_SHA },
        },
      ],
    }),
  )
  await ctx.restart()
  await ctx.clock.advance(60_001)
  expect(ctx.nodes().expireDue()).toBe(1)
  const second = await ctx.grant()
  expect(second).toMatchObject({
    task_id: first.task_id,
    attempt: 2,
    recovery: {
      previous_end: { attempt: 1, reason: 'lease_expired' },
      reported_branch: 'task/recovery',
      prs: [],
    },
  })
  if (!second.recovery) throw new Error('重新派工缺少恢复上下文')
  const prompt = renderRecoveryPrompt(second.recovery)
  for (const fact of ['工作目录', 'git', 'PR', 'push']) {
    expect(prompt).toContain(fact)
  }
  expect(prompt).not.toContain(PR)
  expect(prompt).not.toContain(PUSHED_SHA)
  expect(second.recovery).not.toHaveProperty('pushed_sha')
})

test('task_retry后的派工包含上次崩溃，旧账缺少结束事件仍可恢复', async () => {
  const ctx = await setup()
  const first = await ctx.grant()
  must(
    ctx.nodes().complete(first.lease_id, {
      lease_token: first.lease_token,
      outcome: 'blocked',
      blocked_reason: 'crashed',
      message: 'worker异常退出，请核对PR',
    }),
  )
  must(await ctx.tasks().retryTask(ctx.task.id, { actor: 'user' }))
  const second = await ctx.grant()
  expect(second.recovery).toMatchObject({
    previous_end: {
      attempt: 1,
      reason: 'blocked',
      blocked_reason: 'crashed',
      message: 'worker异常退出，请核对PR',
    },
    prs: [],
  })
  const oldEvents = ctx
    .ledger()
    .taskEvents(ctx.task.id)
    .filter(
      (e) =>
        e.type !== 'task.attempt_ended' && !(e.type === 'task.started' && e.payload.attempt === 2),
    )
  expect(
    recoveryForTask(
      {
        taskEvents: () => oldEvents,
      },
      { ...ctx.task, attempt: 1 },
    )?.previous_end.reason,
  ).toBe('unknown')
})

test('失败后重试保留本任务已记录的PR，不把commit产物或push授权当成已push', async () => {
  const ctx = await setup()
  const first = await ctx.grant()
  must(
    ctx.nodes().renew(first.lease_id, {
      lease_token: first.lease_token,
      blocked: { reason: 'question', message: '已解决的旧问题' },
    }),
  )
  must(
    ctx.nodes().renew(first.lease_id, {
      lease_token: first.lease_token,
      resumed: { note: '问题已解决' },
    }),
  )
  must(
    ctx.nodes().complete(first.lease_id, {
      lease_token: first.lease_token,
      outcome: 'failed',
      result: {
        summary: 'PR已开出但执行器失败',
        executor: 'codex-orca',
        node_id: 'n1',
        artifacts: [
          { kind: 'pr', ref: PR },
          { kind: 'commit', ref: PUSHED_SHA },
        ],
      },
    }),
  )
  must(ctx.ledger().rebuild())
  must(await ctx.tasks().retryTask(ctx.task.id, { actor: 'user' }))
  const second = await ctx.grant()
  expect(second.recovery).toMatchObject({
    previous_end: { reason: 'failed', message: 'PR已开出但执行器失败' },
    prs: [PR],
  })
  expect(second.recovery).not.toHaveProperty('pushed_sha')
  expect(second.recovery?.previous_end).not.toHaveProperty('blocked_reason')
})

test('普通提问回复重排不附恢复提示，也不继承更早派工的崩溃原因', async () => {
  const ctx = await setup()
  const first = await ctx.grant()
  must(
    ctx.nodes().complete(first.lease_id, {
      lease_token: first.lease_token,
      outcome: 'blocked',
      blocked_reason: 'crashed',
      message: '上一次崩溃',
    }),
  )
  must(await ctx.tasks().retryTask(ctx.task.id, { actor: 'user' }))
  const recovered = await ctx.grant()
  expect(recovered.recovery?.previous_end.blocked_reason).toBe('crashed')
  must(
    ctx.nodes().complete(recovered.lease_id, {
      lease_token: recovered.lease_token,
      outcome: 'blocked',
      blocked_reason: 'question',
      message: '用哪个标题？',
      session: 'session-2',
    }),
  )
  must(ctx.tasks().replyTask(ctx.task.id, { kind: 'text', text: '标题A' }, { actor: 'user' }))
  const answered = await ctx.grant()
  expect(answered.resume).toMatchObject({ session: 'session-2', reply: { text: '标题A' } })
  expect(answered).not.toHaveProperty('recovery')
})

test('提问等待期间节点失联，带回复重排仍须附恢复提示', async () => {
  const ctx = await setup()
  const first = await ctx.grant()
  must(
    ctx.nodes().renew(first.lease_id, {
      lease_token: first.lease_token,
      blocked: { reason: 'question', message: '用哪个标题？' },
    }),
  )
  must(ctx.tasks().replyTask(ctx.task.id, { kind: 'text', text: '标题A' }, { actor: 'user' }))
  await ctx.clock.advance(60_001)
  expect(ctx.nodes().expireDue()).toBe(1)
  const answered = await ctx.grant()
  expect(answered.resume?.reply.text).toBe('标题A')
  expect(answered.recovery?.previous_end.reason).toBe('lease_expired')
})
