import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderRecoveryPrompt } from '@raindown/core'
import { openLedger } from '../src/ledger/store.ts'
import { createTaskService } from '../src/ledger/tasks.ts'
import { recoveryForTask } from '../src/nodes/recovery.ts'
import { createNodeService } from '../src/nodes/service.ts'
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

test('push后节点重启、租约过期重新派工：保留分支和结构化外部事实并附恢复提示', async () => {
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
      prs: [PR],
      pushed_sha: PUSHED_SHA,
    },
  })
  if (!second.recovery) throw new Error('重新派工缺少恢复上下文')
  const prompt = renderRecoveryPrompt(second.recovery)
  for (const fact of ['工作目录', 'git', 'PR', 'push', PR, PUSHED_SHA]) {
    expect(prompt).toContain(fact)
  }
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
        taskActivity: () => [],
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
  must(await ctx.tasks().retryTask(ctx.task.id, { actor: 'user' }))
  const second = await ctx.grant()
  expect(second.recovery).toMatchObject({
    previous_end: { reason: 'failed', message: 'PR已开出但执行器失败' },
    prs: [PR],
  })
  expect(second.recovery).not.toHaveProperty('pushed_sha')
  expect(second.recovery?.previous_end).not.toHaveProperty('blocked_reason')
})
