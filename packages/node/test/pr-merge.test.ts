import { afterEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import {
  fail,
  ok,
  type ShowTaskData,
  type TaskContract,
  type TaskView,
  taskContract,
  taskResult,
} from '@flow/core'
import {
  createPrMergeExecutor,
  type ExecutorContext,
  type ExecutorOutcome,
  evaluateChecks,
  evaluateRuns,
  type NodeClock,
  type PrMergeOptions,
} from '../src/index.ts'
import {
  type FakeGhState,
  fakeGh,
  run as ghRun,
  gitEnv,
  PR_URL,
  type TempRepo,
  tempRepo,
} from './github-helpers.ts'

/**
 * pr-merge 执行器（add-m1-supervisor 5.4；pr-acceptance "合并前的条件核对" "合并后确认发布流水线"）。
 * 本地临时仓库 + 注入的假 gh 与假中枢：绝不调用真实 gh、绝不访问远端。
 */

const MERGE_SHA = 'c'.repeat(40)

/** 定时器立即触发、同时把时间拨过去：流水线等待在测试中瞬间完成，时间仍按毫秒累计。 */
function instantClock(): NodeClock & { elapsed(): number } {
  const start = Date.parse('2026-10-26T08:00:00.000Z')
  let t = start
  return {
    now: () => t,
    setTimeout(cb, ms) {
      let cancelled = false
      t += Math.max(0, ms)
      setImmediate(() => {
        if (!cancelled) cb()
      })
      return () => {
        cancelled = true
      }
    },
    elapsed: () => t - start,
  }
}

let repos: TempRepo[] = []
afterEach(() => {
  for (const r of repos) rmSync(r.root, { recursive: true, force: true })
  repos = []
})

const TS = '2026-10-26T08:00:00.000Z'
function view(contract: TaskContract, over: Partial<TaskView> = {}): TaskView {
  return {
    id: 't-x',
    workspace: contract.workspace,
    status: 'done',
    contract,
    attempt: 1,
    created_at: TS,
    updated_at: TS,
    started_at: TS,
    finished_at: TS,
    cancel_requested: false,
    blocked: null,
    lease: null,
    result: null,
    created_by: 'hub',
    origin: 'instruction',
    branch: null,
    last_activity_at: null,
    ...over,
  }
}

interface Setup {
  r: TempRepo
  gh: ReturnType<typeof fakeGh>
  contract: TaskContract
  self: TaskView
  review: TaskView
  hubCalls: string[]
  hubDown: boolean
}

function setup(
  opts: { workspaceExtra?: string; gh?: Partial<FakeGhState>; review?: Partial<TaskView> } = {},
): Setup {
  const r = tempRepo(opts.workspaceExtra ?? '')
  repos.push(r)
  const contract = taskContract.parse({
    goal: '合并已审查的 PR',
    workspace: 'ws/demo',
    role: 'merger',
    executor: 'pr-merge',
    cwd: r.repo,
    parent: 't-review',
    inputs: { merge: { pr: PR_URL, review_task: 't-review' } },
  })
  const reviewContract = taskContract.parse({
    goal: '审查 PR',
    workspace: 'ws/demo',
    role: 'pr-reviewer',
    executor: 'claude-sdk',
    cwd: r.repo,
    inputs: { review: { pr: PR_URL } },
  })
  const gh = fakeGh({
    pr: { ...fakeGh().state.pr, headRefOid: r.head },
    mergeCommit: MERGE_SHA,
    ...opts.gh,
  })
  return {
    r,
    gh,
    contract,
    self: view(contract, { id: 't-merge', status: 'running' }),
    review: view(reviewContract, {
      id: 't-review',
      created_by: 'supervisor',
      result: taskResult.parse({
        summary: '没有阻塞问题',
        executor: 'claude-sdk',
        node_id: 'n-1',
        review: { verdict: 'approve', reviewed_sha: r.head },
      }),
      ...opts.review,
    }),
    hubCalls: [],
    hubDown: false,
  }
}

async function execute(s: Setup, over: Partial<PrMergeOptions> = {}, signal?: AbortSignal) {
  const clock = instantClock()
  const ex = createPrMergeExecutor({
    home: s.r.home,
    clock,
    gh: s.gh.gh,
    git: { env: gitEnv },
    hub: {
      async showTask(id): Promise<ReturnType<typeof ok<ShowTaskData>> | ReturnType<typeof fail>> {
        s.hubCalls.push(id)
        if (s.hubDown) return fail('retryable', 'hub_unavailable', '中枢不可用')
        const task = id === s.self.id ? s.self : id === s.review.id ? s.review : undefined
        return task ? ok({ task, events: [], replies: [] }) : fail('failure', 'not_found', id)
      },
    },
    ...over,
  })
  const context: ExecutorContext = {
    taskId: 't-merge',
    attempt: 1,
    cwd: s.r.repo,
    nodeId: 'n-test',
    signal: signal ?? new AbortController().signal,
  }
  const run = ex.run(s.contract, context)
  const texts: string[] = []
  for await (const a of run.activity) texts.push(a.text ?? '')
  const done = await run.done
  if (!done.ok) throw new Error(JSON.stringify(done.error))
  return { outcome: done.data, texts, clock }
}

const reason = (o: ExecutorOutcome) =>
  o.outcome === 'failed' || o.outcome === 'done' ? o.result.reason : o.outcome
const mergeCalls = (s: Setup) => s.gh.state.calls.filter((c) => c.startsWith('pr merge'))

describe('合并前的条件核对', () => {
  test('条件全部满足：按 merge_method 合并并要求 head 等于 reviewed_sha，等流水线全部成功后 done 附 run 链接', async () => {
    const s = setup({
      gh: {
        runs: [
          [],
          [ghRun({ status: 'in_progress', conclusion: '' })],
          [
            ghRun(),
            ghRun({
              databaseId: 2,
              name: 'ci',
              url: 'https://github.com/acme/demo/actions/runs/2',
            }),
          ],
        ],
      },
    })
    const { outcome } = await execute(s)
    expect(outcome.outcome).toBe('done')
    if (outcome.outcome !== 'done') return
    expect(mergeCalls(s)).toEqual([`pr merge ${PR_URL} squash ${s.r.head}`])
    expect(outcome.result.artifacts).toEqual([
      { kind: 'pr', ref: PR_URL },
      { kind: 'commit', ref: MERGE_SHA, note: '合并到 main' },
      {
        kind: 'url',
        ref: 'https://github.com/acme/demo/actions/runs/1',
        note: 'deploy：completed/success',
      },
      {
        kind: 'url',
        ref: 'https://github.com/acme/demo/actions/runs/2',
        note: 'ci：completed/success',
      },
    ])
    expect(outcome.result.summary).toContain('流水线全部成功')
    expect(outcome.result.executor).toBe('pr-merge')
    // 核对在合并之前，流水线查询在合并之后，且查询的是默认分支上的合并提交。
    const calls = s.gh.state.calls
    const merged = calls.findIndex((c) => c.startsWith('pr merge'))
    expect(calls.findIndex((c) => c.startsWith('pr checks'))).toBeLessThan(merged)
    expect(calls.findIndex((c) => c.startsWith('run list'))).toBeGreaterThan(merged)
    expect(calls).toContain(`run list acme/demo ${MERGE_SHA} main`)
    expect(s.hubCalls).toEqual(['t-merge', 't-review'])
  })

  test('merge_method 取 workspace 配置', async () => {
    const s = setup({ workspaceExtra: 'supervisor:\n  merge_method: rebase\n' })
    await execute(s)
    expect(mergeCalls(s)).toEqual([`pr merge ${PR_URL} rebase ${s.r.head}`])
  })

  test('审查后又有新提交：failed(head_moved)，不合并', async () => {
    const s = setup()
    s.gh.state.pr.headRefOid = 'd'.repeat(40)
    const { outcome } = await execute(s)
    expect(reason(outcome)).toBe('head_moved')
    expect(mergeCalls(s)).toEqual([])
  })

  test('没有任何检查且未配置 allow_no_checks：failed(checks_not_green)；配置后可以合并', async () => {
    const s = setup({ gh: { checks: 'none' } })
    expect(reason((await execute(s)).outcome)).toBe('checks_not_green')
    expect(mergeCalls(s)).toEqual([])
    const allowed = setup({
      gh: { checks: 'none' },
      workspaceExtra: 'supervisor:\n  allow_no_checks: true\n',
    })
    expect((await execute(allowed)).outcome.outcome).toBe('done')
    expect(mergeCalls(allowed)).toHaveLength(1)
  })

  test('检查进行中、失败、被取消、全部跳过或读取失败：failed(checks_not_green)，不合并', async () => {
    for (const checks of [
      [{ name: 'ci', state: 'IN_PROGRESS', bucket: 'pending' }],
      [
        { name: 'ci', state: 'SUCCESS', bucket: 'pass' },
        { name: 'lint', state: 'FAILURE', bucket: 'fail' },
      ],
      [{ name: 'ci', state: 'CANCELLED', bucket: 'cancel' }],
      [{ name: 'ci', state: 'SKIPPED', bucket: 'skipping' }],
      [{ name: 'ci', state: 'WEIRD', bucket: 'unknown' }],
      'error' as const,
    ]) {
      const s = setup({ gh: { checks } })
      expect(reason((await execute(s)).outcome)).toBe('checks_not_green')
      expect(mergeCalls(s)).toEqual([])
    }
  })

  test('批准时 PR 已关闭或已合并：failed(pr_not_open)', async () => {
    for (const state of ['CLOSED', 'MERGED']) {
      const s = setup()
      s.gh.state.pr.state = state
      expect(reason((await execute(s)).outcome)).toBe('pr_not_open')
      expect(mergeCalls(s)).toEqual([])
    }
  })

  test('base 不是默认分支、草稿或不可合并：不合并', async () => {
    const base = setup()
    base.gh.state.pr.baseRefName = 'release'
    expect(reason((await execute(base)).outcome)).toBe('base_not_default')
    const draft = setup()
    draft.gh.state.pr.isDraft = true
    expect(reason((await execute(draft)).outcome)).toBe('not_mergeable')
    for (const mergeable of ['CONFLICTING', 'UNKNOWN']) {
      const s = setup()
      s.gh.state.pr.mergeable = mergeable
      expect(reason((await execute(s)).outcome)).toBe('not_mergeable')
      expect(mergeCalls(s)).toEqual([])
    }
  })

  test('仓库不一致：PR 链接指向他人仓库、gh 报告的仓库不同、origin 无法识别', async () => {
    const other = setup()
    other.contract = {
      ...other.contract,
      inputs: { merge: { pr: 'https://github.com/evil/demo/pull/7', review_task: 't-review' } },
    }
    other.self = { ...other.self, contract: other.contract }
    expect(reason((await execute(other)).outcome)).toBe('repo_not_in_workspace')
    expect(other.gh.state.calls).toEqual([])
    const renamed = setup({ gh: { nameWithOwner: 'acme/other' } })
    expect(reason((await execute(renamed)).outcome)).toBe('repo_not_in_workspace')
    const local = setup()
    const { sh } = await import('./github-helpers.ts')
    sh(local.r.repo, 'remote', 'set-url', 'origin', local.r.bare)
    expect(reason((await execute(local)).outcome)).toBe('repo_not_in_workspace')
    for (const s of [renamed, local]) expect(mergeCalls(s)).toEqual([])
  })

  test('审查结论不被采信或不是 approve：failed(review_not_approved)', async () => {
    const cases: Array<Partial<TaskView> | ((s: Setup) => void)> = [
      (s) => {
        s.review = {
          ...s.review,
          result: taskResult.parse({
            ...s.review.result,
            review: { verdict: 'changes_requested', blocking: ['x'], reviewed_sha: s.r.head },
          }),
        }
      },
      (s) => {
        s.review = { ...s.review, contract: { ...s.review.contract, role: 'reviewer' } }
      },
      (s) => {
        s.review = { ...s.review, contract: { ...s.review.contract, executor: 'codex-exec' } }
      },
      (s) => {
        s.review = {
          ...s.review,
          contract: {
            ...s.review.contract,
            inputs: { review: { pr: 'https://github.com/acme/demo/pull/8' } },
          },
        }
      },
      { workspace: 'ws/other' },
      { status: 'failed' },
      (s) => {
        s.review = {
          ...s.review,
          result: taskResult.parse({ ...s.review.result, review: undefined }),
        }
      },
    ]
    for (const c of cases) {
      const s = setup(typeof c === 'function' ? {} : { review: c })
      if (typeof c === 'function') c(s)
      expect(reason((await execute(s)).outcome)).toBe('review_not_approved')
      expect(mergeCalls(s)).toEqual([])
      expect(s.gh.state.calls.some((x) => x.startsWith('pr view'))).toBe(false)
    }
    const down = setup()
    down.hubDown = true
    expect(reason((await execute(down)).outcome)).toBe('merge_not_eligible')
  })

  test('本任务不是由 hub / user 建、origin 不是 instruction、parent 不是审查任务：failed(merge_not_eligible)', async () => {
    for (const over of [
      { created_by: 'supervisor' },
      { origin: null },
      { origin: 'autonomous' as const },
    ] satisfies Partial<TaskView>[]) {
      const s = setup()
      s.self = { ...s.self, ...over }
      expect(reason((await execute(s)).outcome)).toBe('merge_not_eligible')
      expect(mergeCalls(s)).toEqual([])
    }
    const parent = setup()
    parent.self = { ...parent.self, contract: { ...parent.self.contract, parent: 't-other' } }
    expect(reason((await execute(parent)).outcome)).toBe('merge_not_eligible')
    const user = setup()
    user.self = { ...user.self, created_by: 'user' }
    expect((await execute(user)).outcome.outcome).toBe('done')
  })

  test('合同缺少 inputs.merge 或不是登记仓库：不合并', async () => {
    const s = setup()
    s.contract = { ...s.contract, inputs: {} }
    expect(reason((await execute(s)).outcome)).toBe('invalid_inputs')
    const cwd = setup()
    cwd.contract = { ...cwd.contract, cwd: cwd.r.root }
    expect(reason((await execute(cwd)).outcome)).toBe('repo_not_in_workspace')
    for (const x of [s, cwd]) expect(x.gh.state.calls).toEqual([])
  })

  test('合并前取消：cancelled，不合并', async () => {
    const s = setup()
    const abort = new AbortController()
    abort.abort()
    const { outcome } = await execute(s, {}, abort.signal)
    expect(outcome.outcome).toBe('cancelled')
    expect(mergeCalls(s)).toEqual([])
  })
})

describe('合并结果', () => {
  test('gh 只打开了自动合并（PR 仍为 OPEN）：关闭自动合并并 failed(merge_failed)', async () => {
    const s = setup({ gh: { mergeBehavior: 'auto' } })
    expect(reason((await execute(s)).outcome)).toBe('merge_failed')
    expect(s.gh.state.calls).toContain(`pr disable-auto ${PR_URL}`)
    expect(s.gh.state.autoEnabled).toBe(false)
    expect(s.gh.state.calls.some((c) => c.startsWith('run list'))).toBe(false)
  })

  test('gh pr merge 报错：PR 未合并时 failed(merge_failed)；实际已合并时照常确认流水线', async () => {
    const s = setup({ gh: { mergeBehavior: 'error' } })
    expect(reason((await execute(s)).outcome)).toBe('merge_failed')
    const merged = setup({ gh: { mergeBehavior: 'error_but_merged', runs: [[ghRun()]] } })
    const { outcome, texts } = await execute(merged)
    expect(outcome.outcome).toBe('done')
    expect(texts.some((t) => t.includes('gh pr merge 报错但 PR 已合并'))).toBe(true)
  })
})

describe('合并后确认发布流水线', () => {
  test('流水线失败：failed(pipeline_failed)，附 run 链接', async () => {
    const s = setup({
      gh: { runs: [[ghRun({ conclusion: 'failure' }), ghRun({ databaseId: 2, name: 'ci' })]] },
    })
    const { outcome } = await execute(s)
    expect(reason(outcome)).toBe('pipeline_failed')
    if (outcome.outcome === 'failed') {
      expect(outcome.result.summary).toContain('deploy：failure')
      expect(outcome.result.artifacts.some((a) => a.kind === 'url')).toBe(true)
    }
  })

  test('全部结束后再查一次：后出现的 run 失败也算失败', async () => {
    const s = setup({
      gh: {
        runs: [
          [ghRun()],
          [ghRun(), ghRun({ databaseId: 3, name: 'deploy-prod', conclusion: 'failure' })],
        ],
      },
    })
    expect(reason((await execute(s)).outcome)).toBe('pipeline_failed')
  })

  test('超时：failed(pipeline_timeout)，附仍在运行的 run 链接；默认 30 分钟', async () => {
    const s = setup({ gh: { runs: [[ghRun({ status: 'in_progress', conclusion: '' })]] } })
    const { outcome, clock } = await execute(s)
    expect(reason(outcome)).toBe('pipeline_timeout')
    expect(clock.elapsed()).toBeGreaterThanOrEqual(30 * 60_000)
    expect(clock.elapsed()).toBeLessThan(31 * 60_000)
    if (outcome.outcome === 'failed') {
      expect(outcome.result.summary).toContain('https://github.com/acme/demo/actions/runs/1')
      expect(outcome.result.artifacts).toContainEqual(
        expect.objectContaining({
          kind: 'url',
          ref: 'https://github.com/acme/demo/actions/runs/1',
        }),
      )
    }
  })

  test('发现窗口内没有任何 run：done 并注明未发现发布流水线；只看合并提交的 run', async () => {
    const s = setup({ gh: { runs: [[ghRun({ headSha: 'e'.repeat(40) })]] } })
    const { outcome } = await execute(s, { discoveryMs: 60_000 })
    expect(outcome.outcome).toBe('done')
    if (outcome.outcome === 'done') expect(outcome.result.summary).toContain('未发现发布流水线')
  })

  test('查询一直失败：不当作"没有流水线"，最终 failed(pipeline_timeout)', async () => {
    const s = setup({ gh: { runs: ['error'] } })
    const { outcome } = await execute(s, { pipelineTimeoutMs: 5 * 60_000 })
    expect(reason(outcome)).toBe('pipeline_timeout')
  })
})

describe('判定函数', () => {
  test('evaluateChecks', () => {
    const c = (bucket: string) => ({ name: bucket, state: bucket, bucket })
    expect(evaluateChecks([c('pass'), c('skipping')], false).ok).toBe(true)
    expect(evaluateChecks([], false).ok).toBe(false)
    expect(evaluateChecks([], true).ok).toBe(true)
    expect(evaluateChecks([c('skipping')], false).ok).toBe(false)
    expect(evaluateChecks([c('pass'), c('pending')], true).ok).toBe(false)
  })

  test('evaluateRuns', () => {
    expect(evaluateRuns([ghRun(), ghRun({ conclusion: 'skipped' })])).toBe('success')
    expect(evaluateRuns([ghRun({ status: 'queued', conclusion: '' })])).toBe('pending')
    for (const conclusion of [
      'failure',
      'cancelled',
      'timed_out',
      'action_required',
      'startup_failure',
    ])
      expect(evaluateRuns([ghRun({ conclusion })])).toBe('failed')
  })
})
