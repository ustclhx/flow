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
  ...over,
})

async function setup(
  query: ExistingPrLookup = async () => ok([pr()]),
  over: Partial<TaskContractInput> = {},
) {
  const l = await tempLedger()
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
  return { ...l, repo, reactor, inbox, branch, block }
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
  const s = await setup(async () => ok([pr({ state: 'MERGED' })]))
  s.branch()
  s.block()
  s.reactor.start()
  await s.reactor.idle()
  expect(s.store.getTask('dev')?.status).toBe('done')
})

test.each([
  { state: 'CLOSED' },
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
    return fail('retryable', 'test_failed', '查询失败')
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

test('本任务已记录的旧 PR 可作为依据，保留先前派工的 blocked 结束事实', async () => {
  const s = await setup(async () => ok([pr({ createdAt: '2026-10-23T00:00:00Z' })]))
  s.branch()
  s.store.recordActivity('dev', [
    { kind: 'status', ts: '2026-10-24T00:00:10Z', data: { prs: [PR] } },
  ])
  s.block()
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
  expect(s.store.getTask('dev')?.status).toBe('done')
  expect(s.store.taskEvents('dev').filter((e) => e.type === 'task.attempt_ended')).toMatchObject([
    { payload: { attempt: 1, reason: 'blocked' } },
  ])
})
