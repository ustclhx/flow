import { afterEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import { defaultSupervisorConfig, fail, ok, type TaskContractInput } from '@raindown/core'
import { createInboxReactor } from '../src/inbox/reactor.ts'
import {
  createExistingPrReactor,
  type ExistingPr,
  type ExistingPrLookup,
} from '../src/nodes/existing-pr.ts'
import { contract, drafts, must, startTask, tempLedger, WS } from './ledger-helpers.ts'
import { FakeClock, tick } from './server-fixtures.ts'

const PR = 'https://github.com/acme/demo/pull/32'
const BRANCH = 'raindown/dev'
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const pr = (over: Partial<ExistingPr> = {}): ExistingPr => ({
  url: PR,
  state: 'OPEN',
  headRefName: BRANCH,
  createdAt: '2026-10-24T00:01:00Z',
  isCrossRepository: false,
  isDraft: false,
  ...over,
})

async function setup(
  query: ExistingPrLookup = async () => ok([pr()]),
  over: Partial<TaskContractInput> = {},
) {
  const clock = new FakeClock(Date.parse('2026-10-24T00:00:00Z'))
  const l = await tempLedger({ now: clock.now })
  const originalHome = process.env.RAINDOWN_HOME
  process.env.RAINDOWN_HOME = l.dir
  cleanups.push(() => {
    l.cleanup()
    if (originalHome === undefined) delete process.env.RAINDOWN_HOME
    else process.env.RAINDOWN_HOME = originalHome
  })
  const repo = join(l.dir, 'repo')
  const task = contract({ cwd: repo, executor: 'codex-orca', ...over })
  must(
    l.store.append(
      {
        type: 'task.created',
        task_id: 'dev',
        workspace: WS,
        payload: { contract: task, origin: 'instruction' },
      },
      { actor: 'user' },
    ),
  )
  startTask(l.store, 'dev')
  const inbox = createInboxReactor({ ledger: l.store })
  inbox.start()
  const reactor = createExistingPrReactor({
    ledger: l.store,
    roles: async (name) =>
      ok({
        name,
        executor: task.executor,
        creatable_by: ['*'],
        ...(name === 'supervisor' ? { kind: 'supervisor' as const } : {}),
      }),
    workspaces: async () => ({
      ref: WS,
      repos: [repo],
      supervisor: { ...defaultSupervisorConfig(), reviewer_roles: ['pr-reviewer'] },
    }),
    query,
    clock,
  })
  cleanups.push(async () => {
    await reactor.stop()
    inbox.stop()
  })
  const branch = () =>
    must(
      l.store.append(
        {
          type: 'task.branch_reported',
          task_id: 'dev',
          workspace: WS,
          payload: {
            branch: BRANCH,
            repo_snapshot: { remote_url: 'https://github.com/acme/demo.git' },
            worktree: join(l.dir, 'removed-worktree'),
          },
        },
        { actor: 'node:n1' },
      ),
    )
  const block = (
    reason: 'workdir_missing' | 'crashed' | 'question' = 'workdir_missing',
    held = false,
  ) =>
    must(
      l.store.append(
        {
          type: 'task.blocked',
          task_id: 'dev',
          workspace: WS,
          payload: { reason, message: '目录丢失', lease_held: held },
        },
        { actor: 'node:n1' },
      ),
    )
  return { ...l, repo, reactor, inbox, branch, block, clock, task }
}

test.each(['workdir_missing', 'crashed'] as const)(
  '已有 PR 在 %s 后完成，关闭卡住项并可重建',
  async (reason) => {
    const queried: string[][] = []
    const s = await setup(async (repo, branch) => {
      queried.push([repo, branch])
      return ok([pr()])
    })
    s.branch()
    s.reactor.start()
    const blocked = s.block(reason)
    await s.inbox.idle()
    await s.reactor.idle()
    await s.inbox.idle()
    expect(queried).toEqual([[s.repo, BRANCH]])
    expect(s.store.getTask('dev')).toMatchObject({
      status: 'done',
      result: {
        completed_via: 'existing_pr',
        prs: [PR],
        artifacts: [{ kind: 'pr', ref: PR }],
      },
    })
    expect(s.store.getInboxItem(`blk.${blocked.seq}`)).toMatchObject({
      state: 'closed',
      closed: {
        reason: 'task_done',
        note: expect.stringContaining('已有 PR'),
      },
    })
    expect(s.store.taskEvents('dev').filter((e) => e.type === 'task.done')).toHaveLength(1)
    must(s.store.rebuild())
    expect(s.store.getTask('dev')?.result?.completed_via).toBe('existing_pr')
  },
)

test('启动时补处理卡住任务，已合并 PR 也可作为交付物', async () => {
  const s = await setup(async () => ok([pr({ state: 'MERGED', isDraft: true })]))
  s.branch()
  s.block()
  s.reactor.start()
  await s.reactor.idle()
  expect(s.store.getTask('dev')?.status).toBe('done')
})

test.each([
  { state: 'CLOSED' },
  { isDraft: true },
  { headRefName: 'another' },
  { isCrossRepository: true },
  { createdAt: '2026-10-23T00:00:00Z' },
  { url: 'https://github.com/other/repo/pull/32' },
] as Partial<ExistingPr>[])('不采信无本任务交付依据的 PR：%j', async (over) => {
  const s = await setup(async () => ok([pr(over)]))
  s.branch()
  s.block()
  s.reactor.start()
  await s.reactor.idle()
  expect(s.store.getTask('dev')?.status).toBe('blocked')
})

test('查询失败保留 blocked，缺失分支和无关卡住不查询', async () => {
  let calls = 0
  const s = await setup(async () => {
    calls++
    return fail('failure', 'test_failed', '查询失败')
  })
  s.branch()
  s.block()
  s.reactor.start()
  await s.reactor.idle()
  expect(s.store.getTask('dev')?.status).toBe('blocked')
  expect(calls).toBe(1)
  const withoutBranch = await setup(async () => {
    calls++
    return ok([pr()])
  })
  withoutBranch.block()
  withoutBranch.reactor.start()
  await withoutBranch.reactor.idle()
  const question = await setup(async () => {
    calls++
    return ok([pr()])
  })
  question.branch()
  question.block('question')
  question.reactor.start()
  await question.reactor.idle()
  expect(calls).toBe(1)
})

test.each([
  { executor: 'pr-merge', role: 'merger' },
  { role: 'supervisor' },
  { role: 'pr-reviewer' },
  { inputs: { review: { pr: PR } } },
  { inputs: { merge: { pr: PR, review_task: 'review', branch: BRANCH } } },
] as Partial<TaskContractInput>[])('审查或合并任务不自动完成：%j', async (over) => {
  let calls = 0
  const s = await setup(async () => {
    calls++
    return ok([pr()])
  }, over)
  if (over.executor !== 'pr-merge') s.branch()
  s.block()
  s.reactor.start()
  await s.reactor.idle()
  expect(calls).toBe(0)
  expect(s.store.getTask('dev')?.status).toBe('blocked')
})

test('异步查询期间人工重试不允许旧查询结束新派工', async () => {
  let finish!: (r: ReturnType<typeof ok<ExistingPr[]>>) => void
  let queried!: () => void
  const querying = new Promise<void>((done) => {
    queried = done
  })
  const s = await setup(() => {
    queried()
    return new Promise((done) => {
      finish = done
    })
  })
  s.branch()
  s.block()
  s.reactor.start()
  await querying
  must(s.store.append(drafts('dev')['task.requeued:manual'], { actor: 'user' }))
  startTask(s.store, 'dev', 2)
  s.block('question')
  finish(ok([pr()]))
  await s.reactor.idle()
  expect(s.store.getTask('dev')?.status).toBe('blocked')
})

test('只有 hub 可依据 PR 从适用的 blocked 状态完成，普通 done 不能绕过', async () => {
  const s = await setup()
  s.branch()
  s.block()
  const done = {
    type: 'task.done' as const,
    task_id: 'dev',
    workspace: WS,
    payload: {
      result: {
        summary: '已有PR',
        executor: 'fake',
        node_id: 'n1',
        completed_via: 'existing_pr' as const,
        prs: [PR],
      },
    },
  }
  expect(s.store.append(done, { actor: 'node:n1' }).ok).toBe(false)
  expect(s.store.append(drafts('dev')['task.done'], { actor: 'hub' }).ok).toBe(false)
  const q = await setup()
  q.branch()
  q.block('question')
  expect(q.store.append(done, { actor: 'hub' }).ok).toBe(false)
})

test('仍持有租约时依据 PR 完成会结束派工并释放租约', async () => {
  const s = await setup()
  s.branch()
  s.block('workdir_missing', true)
  s.reactor.start()
  await s.reactor.idle()
  expect(s.store.activeLease('dev')).toBeNull()
  expect(s.store.taskEvents('dev').findLast((e) => e.type === 'task.attempt_ended')).toMatchObject({
    payload: { attempt: 1, reason: 'done' },
  })
})

test('已消费上报后崩溃仍可依据 PR 完成，重建保留上报与派工结束事实', async () => {
  const s = await setup()
  s.branch()
  const report = {
    type: 'task.reported' as const,
    task_id: 'dev',
    workspace: WS,
    payload: {
      status: 'progress' as const,
      summary: '已推送任务分支，等待交付核验',
      lease_id: 'l-dev-1',
      attempt: 1,
    },
  }
  const reported = must(s.store.append(report, { actor: 'developer' }))
  must(
    s.store.append(
      {
        type: 'task.report_consumed',
        task_id: 'dev',
        workspace: WS,
        payload: { lease_id: 'l-dev-1', attempt: 1, report_seq: reported.seq },
      },
      { actor: 'node:n1' },
    ),
  )
  s.block('crashed', true)
  s.reactor.start()
  await s.reactor.idle()
  expect(s.store.getTask('dev')).toMatchObject({
    status: 'done',
    result: { completed_via: 'existing_pr', prs: [PR] },
  })
  expect(s.store.activeLease('dev')).toBeNull()
  expect(s.store.append(report, { actor: 'developer' }).ok).toBe(false)
  must(s.store.rebuild())
  expect<unknown>(s.store.workerReport('dev', 'l-dev-1', 1, reported.seq)).toEqual(reported)
  expect(s.store.workerReportWatermark('dev', 'l-dev-1', 1)).toBe(reported.seq)
  expect(s.store.attemptEnded('dev', 1)).toBe(true)
  expect(s.store.getTask('dev')?.result?.completed_via).toBe('existing_pr')
})

test('本任务已记录的旧 PR 可作为依据，保留先前派工的 blocked 结束事实', async () => {
  const s = await setup(async () => ok([pr({ createdAt: '2026-10-23T00:00:00Z' })]))
  s.branch()
  must(
    s.store.append(
      {
        type: 'task.failed',
        task_id: 'dev',
        workspace: WS,
        payload: {
          message: '执行器退出',
          result: {
            summary: 'PR 已开出',
            executor: 'codex-orca',
            node_id: 'n1',
            artifacts: [{ kind: 'pr', ref: PR }],
          },
        },
      },
      { actor: 'node:n1' },
    ),
  )
  must(s.store.append(drafts('dev')['task.requeued:manual'], { actor: 'user' }))
  startTask(s.store, 'dev', 2)
  s.block()
  must(
    s.store.append(
      {
        type: 'task.attempt_ended',
        task_id: 'dev',
        workspace: WS,
        payload: { attempt: 2, reason: 'blocked' },
      },
      { actor: 'hub' },
    ),
  )
  s.reactor.start()
  await s.reactor.idle()
  expect(s.store.getTask('dev')?.status).toBe('done')
  expect(s.store.taskEvents('dev').filter((e) => e.type === 'task.attempt_ended')).toMatchObject([
    { payload: { attempt: 2, reason: 'blocked' } },
  ])
})

test('查询最多并发两个，延迟重试释放槽供排队任务查询', async () => {
  const finishes: ((retryable?: boolean) => void)[] = []
  let active = 0
  let maximum = 0
  const s = await setup(async () => {
    active++
    maximum = Math.max(maximum, active)
    return new Promise((resolve) => {
      finishes.push((retryable) => {
        active--
        resolve(retryable ? fail('retryable', 'test_failed', '临时失败') : ok([]))
      })
    })
  })
  s.branch()
  s.block()
  for (const id of ['dev2', 'dev3']) {
    must(
      s.store.append(
        {
          type: 'task.created',
          task_id: id,
          workspace: WS,
          payload: { contract: s.task, origin: 'instruction' },
        },
        { actor: 'user' },
      ),
    )
    startTask(s.store, id)
    must(
      s.store.append(
        {
          type: 'task.branch_reported',
          task_id: id,
          workspace: WS,
          payload: {
            branch: BRANCH,
            repo_snapshot: { remote_url: 'https://github.com/acme/demo.git' },
          },
        },
        { actor: 'node:n1' },
      ),
    )
    must(
      s.store.append(
        {
          type: 'task.blocked',
          task_id: id,
          workspace: WS,
          payload: { reason: 'crashed', message: '执行器退出' },
        },
        { actor: 'node:n1' },
      ),
    )
  }
  s.reactor.start()
  await tick()
  expect(finishes).toHaveLength(2)
  finishes[0]?.(true)
  await tick()
  expect(finishes).toHaveLength(3)
  expect(s.clock.pending).toBe(1)
  finishes[1]?.()
  finishes[2]?.()
  await tick()
  await s.clock.advance(1_000)
  expect(finishes).toHaveLength(4)
  finishes[3]?.()
  await s.reactor.idle()
  expect(maximum).toBe(2)
})

test('可重试查询失败延迟后恢复，idle 包含延迟工作', async () => {
  let calls = 0
  const s = await setup(async () =>
    ++calls === 1 ? fail('retryable', 'test_failed', '临时失败') : ok([pr()]),
  )
  s.branch()
  s.block()
  s.reactor.start()
  let idle = false
  const waiting = s.reactor.idle().then(() => {
    idle = true
  })
  await tick()
  expect(calls).toBe(1)
  expect(idle).toBe(false)
  await s.clock.advance(999)
  expect(calls).toBe(1)
  await s.clock.advance(1)
  await waiting
  expect(calls).toBe(2)
  expect(s.store.getTask('dev')?.status).toBe('done')
})

test('可重试查询至多尝试三次，达到上限保留 blocked', async () => {
  let calls = 0
  const s = await setup(async () => {
    calls++
    return fail('retryable', 'test_failed', '临时失败')
  })
  s.branch()
  s.block()
  s.reactor.start()
  await tick()
  expect(calls).toBe(1)
  await s.clock.advance(1_000)
  expect(calls).toBe(2)
  await s.clock.advance(1_000)
  await s.reactor.idle()
  expect(calls).toBe(3)
  expect(s.clock.pending).toBe(0)
  await s.clock.advance(10_000)
  expect(calls).toBe(3)
  expect(s.store.getTask('dev')?.status).toBe('blocked')
})

test('停止取消延迟重试并让 idle 结束', async () => {
  let calls = 0
  const s = await setup(async () => {
    calls++
    return fail('retryable', 'test_failed', '临时失败')
  })
  s.branch()
  s.block()
  s.reactor.start()
  await tick()
  expect(s.clock.pending).toBe(1)
  const idle = s.reactor.idle()
  await s.reactor.stop()
  await idle
  expect(s.clock.pending).toBe(0)
  await s.clock.advance(10_000)
  expect(calls).toBe(1)
  expect(s.store.getTask('dev')?.status).toBe('blocked')
})

test('停止清除排队工作，在途查询返回后不写完成事件', async () => {
  const finishes: ((value: ReturnType<typeof ok<ExistingPr[]>>) => void)[] = []
  const s = await setup(() => new Promise((resolve) => finishes.push(resolve)))
  s.branch()
  s.reactor.start()
  s.block()
  // 同一任务新 blocked 事件也入队，旧查询返回时必须重新核对事件。
  await tick()
  s.block()
  await tick()
  s.block()
  await tick()
  expect(finishes).toHaveLength(2)
  const stopping = s.reactor.stop()
  for (const finish of finishes) finish(ok([pr()]))
  await stopping
  await s.reactor.idle()
  expect(finishes).toHaveLength(2)
  expect(s.store.getTask('dev')?.status).toBe('blocked')
  expect(s.store.taskEvents('dev').some((e) => e.type === 'task.done')).toBe(false)
})

test('启动补查跳过超过七天的 blocked，后续事件更新时间不改变窗口', async () => {
  let calls = 0
  const s = await setup(async () => {
    calls++
    return ok([pr()])
  })
  s.branch()
  s.block()
  s.clock.time += 8 * 86_400_000
  must(
    s.store.append(
      {
        type: 'task.attempt_ended',
        task_id: 'dev',
        workspace: WS,
        payload: { attempt: 1, reason: 'blocked' },
      },
      { actor: 'hub' },
    ),
  )
  s.reactor.start()
  await s.reactor.idle()
  expect(calls).toBe(0)
  expect(s.store.getTask('dev')?.status).toBe('blocked')
})

test('启动补查使用最后 blocked 的时间，任务创建超过七天仍可补查', async () => {
  let calls = 0
  const s = await setup(async () => {
    calls++
    return ok([pr()])
  })
  s.branch()
  s.block()
  s.clock.time += 8 * 86_400_000
  s.block()
  s.clock.time += 7 * 86_400_000
  s.reactor.start()
  await s.reactor.idle()
  expect(calls).toBe(1)
  expect(s.store.getTask('dev')?.status).toBe('done')
})

test('运行中新 blocked 不应用启动补查窗口', async () => {
  let calls = 0
  const s = await setup(async () => {
    calls++
    return ok([pr()])
  })
  s.branch()
  // 模拟订阅送达的事件时间与中枢墙钟相差超过窗口；只对启动扫描限时。
  const now = s.clock.now
  s.clock.now = () => now() + 8 * 86_400_000
  s.reactor.start()
  s.block()
  await s.reactor.idle()
  expect(calls).toBe(1)
  expect(s.store.getTask('dev')?.status).toBe('done')
})
