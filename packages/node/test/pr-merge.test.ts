import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  fail,
  ok,
  type Result,
  type ShowTaskData,
  type TaskContract,
  type TaskView,
  taskContract,
  taskResult,
} from '@flow/core'
import { DEFAULT_ROLE_FILES } from '../../core/src/role-templates.ts'
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
  TASK_BRANCH,
  type TempRepo,
  tempRepo,
} from './github-helpers.ts'
import { bench } from './harness.ts'
import { waitFor } from './wait.ts'

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
  /** 列表中额外出现的任务（例如同一 PR 更新的审查）。 */
  others: TaskView[]
  /** 开出 PR 的 dev 任务（已 done、带任务分支与启动前的仓库快照）。 */
  dev: TaskView
}

function setup(
  opts: { workspaceExtra?: string; gh?: Partial<FakeGhState>; review?: Partial<TaskView> } = {},
): Setup {
  const r = tempRepo(opts.workspaceExtra ?? '')
  repos.push(r)
  // 角色模板：pr-merge 按当前角色配置核对开出 PR 的任务的有效类别。
  mkdirSync(join(r.home, 'config', 'roles'), { recursive: true })
  for (const [name, text] of Object.entries(DEFAULT_ROLE_FILES)) {
    writeFileSync(join(r.home, 'config', 'roles', name), text)
  }
  const contract = taskContract.parse({
    goal: '合并已审查的 PR',
    workspace: 'ws/demo',
    role: 'merger',
    executor: 'pr-merge',
    cwd: r.repo,
    parent: 't-review',
    inputs: { merge: { pr: PR_URL, review_task: 't-review', branch: TASK_BRANCH } },
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
    others: [],
    dev: view(
      taskContract.parse({
        goal: '实现功能',
        workspace: 'ws/demo',
        role: 'dev',
        executor: 'codex-orca',
        cwd: r.repo,
      }),
      {
        id: 't-dev',
        created_by: 'supervisor',
        branch: TASK_BRANCH,
        repo_snapshot: { remote_url: 'https://github.com/acme/demo.git', default_branch: 'main' },
        result: taskResult.parse({
          summary: '开了 PR',
          executor: 'codex-orca',
          node_id: 'n-1',
          artifacts: [{ kind: 'pr', ref: PR_URL }],
        }),
      },
    ),
  }
}

async function execute(s: Setup, over: Partial<PrMergeOptions> = {}, signal?: AbortSignal) {
  const { done, texts, clock } = await executeRaw(s, over, signal)
  if (!done.ok) throw new Error(JSON.stringify(done.error))
  return { outcome: done.data, texts, clock }
}

async function executeRaw(s: Setup, over: Partial<PrMergeOptions> = {}, signal?: AbortSignal) {
  const clock = instantClock()
  const ex = createPrMergeExecutor({
    home: s.r.home,
    clock,
    gh: s.gh.gh,
    git: { env: gitEnv },
    hub: fakeHub(s),
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
  return { done: await run.done, texts, clock }
}

function fakeHub(s: Setup) {
  return {
    async showTask(id: string): Promise<Result<ShowTaskData>> {
      s.hubCalls.push(id)
      if (s.hubDown) return fail('retryable', 'hub_unavailable', '中枢不可用')
      const task = id === s.self.id ? s.self : id === s.review.id ? s.review : undefined
      return task ? ok({ task, events: [], replies: [] }) : fail('failure', 'not_found', id)
    },
    async listTasks(q: { status?: string }): Promise<Result<{ tasks: TaskView[] }>> {
      s.hubCalls.push(`list:${q.status ?? ''}`)
      if (s.hubDown) return fail('retryable', 'hub_unavailable', '中枢不可用')
      const all = [...s.others, s.dev, s.review, s.self]
      return ok({ tasks: q.status ? all.filter((t) => t.status === q.status) : all })
    },
  }
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
    // 快照（head 与检查同一时刻）→ 合并前再读 head → 合并 → 流水线。
    expect(calls.slice(0, merged)).toEqual([`pr snapshot ${PR_URL}`, `pr view ${PR_URL}`])
    expect(calls.findIndex((c) => c.startsWith('run list'))).toBeGreaterThan(merged)
    expect(calls).toContain(`run list acme/demo ${MERGE_SHA} main`)
    expect(s.hubCalls).toEqual([
      't-merge',
      't-review',
      'list:done',
      'list:queued',
      'list:running',
      'list:verifying',
      'list:blocked',
    ])
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

  test('fork PR 或 head 分支不是开出它的任务的分支：不合并', async () => {
    const fork = setup()
    fork.gh.state.pr.isCrossRepository = true
    expect(reason((await execute(fork)).outcome)).toBe('repo_not_in_workspace')
    expect(mergeCalls(fork)).toEqual([])
    const other = setup()
    other.gh.state.pr.headRefName = 'attacker/branch'
    expect(reason((await execute(other)).outcome)).toBe('head_branch_mismatch')
    expect(mergeCalls(other)).toEqual([])
    // 合同缺少 inputs.merge.branch：invalid_inputs，不读 PR
    const missing = setup()
    missing.contract = {
      ...missing.contract,
      inputs: { merge: { pr: PR_URL, review_task: 't-review' } },
    } as typeof missing.contract
    expect(reason((await execute(missing)).outcome)).toBe('invalid_inputs')
    expect(missing.gh.state.calls).toEqual([])
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
      inputs: {
        merge: {
          pr: 'https://github.com/evil/demo/pull/7',
          review_task: 't-review',
          branch: TASK_BRANCH,
        },
      },
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

  test('开出 PR 的任务启动前的仓库快照：找不到任务、没有快照或快照是别的仓库 → repo_not_in_workspace', async () => {
    const cases: Array<(s: Setup) => void> = [
      (s) => {
        s.dev = { ...s.dev, status: 'failed' }
      },
      (s) => {
        s.dev = { ...s.dev, branch: 'flow/other' }
      },
      (s) => {
        s.dev = { ...s.dev, repo_snapshot: null }
      },
      // 候选与中枢一致：origin 不是 instruction、有效类别不是 write 的不算开出 PR 的任务。
      (s) => {
        s.dev = { ...s.dev, origin: 'autonomous' }
      },
      (s) => {
        s.dev = {
          ...s.dev,
          contract: { ...s.dev.contract, role: 'pr-reviewer', executor: 'claude-sdk' },
        }
      },
      // 多个候选时每一个都要有匹配的快照。
      (s) => {
        s.others.push({ ...s.dev, id: 't-dev-2', repo_snapshot: null })
      },
      (s) => {
        // worker 启动前登记仓库指向别的仓库（之后被改成与 PR 一致也不行）。
        s.dev = { ...s.dev, repo_snapshot: { remote_url: 'https://github.com/evil/demo.git' } }
      },
    ]
    for (const edit of cases) {
      const s = setup()
      edit(s)
      const { outcome } = await execute(s)
      expect(reason(outcome)).toBe('repo_not_in_workspace')
      expect(mergeCalls(s)).toEqual([])
    }
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
  })

  test('中枢不可达：failed(merge_unverifiable)，摘要写明未合并、可重试', async () => {
    const down = setup()
    down.hubDown = true
    const { outcome } = await execute(down)
    expect(reason(outcome)).toBe('merge_unverifiable')
    if (outcome.outcome === 'failed')
      expect(outcome.result.summary).toContain('未合并，中枢不可达，可重试')
    expect(down.gh.state.calls).toEqual([])
  })

  test('同一 PR 还有未结束的审查任务：failed(review_not_approved)', async () => {
    for (const status of ['queued', 'running', 'verifying', 'blocked'] as const) {
      const s = setup()
      s.others = [{ ...s.review, id: 't-review-next', status, result: null, finished_at: null }]
      const { outcome } = await execute(s)
      expect(reason(outcome)).toBe('review_not_approved')
      if (outcome.outcome === 'failed') expect(outcome.result.summary).toContain('t-review-next')
      expect(mergeCalls(s)).toEqual([])
    }
    // 链接大小写不同也算同一 PR。
    const cased = setup()
    cased.others = [
      {
        ...cased.review,
        id: 't-review-cased',
        status: 'queued',
        result: null,
        finished_at: null,
        contract: {
          ...cased.review.contract,
          inputs: { review: { pr: 'https://github.com/ACME/demo/pull/7' } },
        },
      },
    ]
    expect(reason((await execute(cased)).outcome)).toBe('review_not_approved')
    // 其他 PR 的进行中审查不影响。
    const s = setup()
    s.others = [
      {
        ...s.review,
        id: 't-review-other',
        status: 'running',
        contract: {
          ...s.review.contract,
          inputs: { review: { pr: 'https://github.com/acme/demo/pull/8' } },
        },
      },
    ]
    expect((await execute(s)).outcome.outcome).toBe('done')
  })

  test('审查任务不是该 PR 最新一次可信审查：failed(review_not_approved)', async () => {
    const s = setup()
    // 同一 PR 后来又有一次可信审查（不论结论）。
    s.others = [
      {
        ...s.review,
        id: 't-review-2',
        finished_at: '2026-10-26T09:00:00.000Z',
        result: taskResult.parse({
          ...s.review.result,
          review: { verdict: 'changes_requested', blocking: ['x'], reviewed_sha: s.r.head },
        }),
      },
    ]
    const { outcome } = await execute(s)
    expect(reason(outcome)).toBe('review_not_approved')
    if (outcome.outcome === 'failed') expect(outcome.result.summary).toContain('t-review-2')
    expect(mergeCalls(s)).toEqual([])
    // 不可信的"审查"（其他角色）不影响判断。
    const ok2 = setup()
    ok2.others = [
      {
        ...ok2.review,
        id: 't-fake',
        finished_at: '2026-10-26T09:00:00.000Z',
        contract: { ...ok2.review.contract, role: 'reviewer' },
      },
    ]
    expect((await execute(ok2)).outcome.outcome).toBe('done')
  })

  test('审查任务读不到（非可重试错误）：failed(review_not_approved)', async () => {
    const s = setup()
    s.review = { ...s.review, id: 't-other' }
    expect(reason((await execute(s)).outcome)).toBe('review_not_approved')
  })

  test('resolveSupervisor 失败或没有该 workspace：failed(merge_not_eligible)', async () => {
    const s = setup()
    expect(
      reason(
        (await execute(s, { resolveSupervisor: async () => fail('failure', 'x', '读取失败') }))
          .outcome,
      ),
    ).toBe('merge_not_eligible')
    expect(
      reason((await execute(s, { resolveSupervisor: async () => ok(undefined) })).outcome),
    ).toBe('merge_not_eligible')
    expect(mergeCalls(s)).toEqual([])
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

  test('合同 timeout_s 小于 40 分钟：failed(timeout_too_short)，不合并', async () => {
    const s = setup()
    s.contract = { ...s.contract, timeout_s: 2399 }
    expect(reason((await execute(s)).outcome)).toBe('timeout_too_short')
    expect(s.gh.state.calls).toEqual([])
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

describe('同一时刻的状态与竞态', () => {
  test('读完检查后 head 变了：合并前重读发现，failed(head_moved)，不合并', async () => {
    const s = setup()
    s.gh.state.headAfterSnapshot = 'e'.repeat(40)
    const { outcome } = await execute(s)
    expect(reason(outcome)).toBe('head_moved')
    expect(mergeCalls(s)).toEqual([])
  })

  test('检查属于另一个提交（快照中的检查不是 reviewed_sha 的）：failed(head_moved)', async () => {
    const s = setup({ gh: { checksOid: 'f'.repeat(40) } })
    expect(reason((await execute(s)).outcome)).toBe('head_moved')
    expect(mergeCalls(s)).toEqual([])
  })

  test('检查超过一次查询的上限：failed(checks_not_green)', async () => {
    const s = setup({ gh: { checksTruncated: true } })
    expect(reason((await execute(s)).outcome)).toBe('checks_not_green')
    expect(mergeCalls(s)).toEqual([])
  })

  test('启用合并队列：failed(merge_queue_unsupported)，不发起合并', async () => {
    const s = setup({ gh: { mergeQueue: true } })
    expect(reason((await execute(s)).outcome)).toBe('merge_queue_unsupported')
    expect(mergeCalls(s)).toEqual([])
  })

  test('mergeable 为 UNKNOWN 时短暂重试：之后可合并则继续，一直 UNKNOWN 则 not_mergeable', async () => {
    const s = setup({ gh: { mergeableSeq: ['UNKNOWN', 'UNKNOWN', 'MERGEABLE'] } })
    expect((await execute(s)).outcome.outcome).toBe('done')
    expect(s.gh.state.calls.filter((c) => c.startsWith('pr snapshot'))).toHaveLength(3)
    const stuck = setup({ gh: { mergeableSeq: ['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN'] } })
    expect(reason((await execute(stuck)).outcome)).toBe('not_mergeable')
    expect(stuck.gh.state.calls.filter((c) => c.startsWith('pr snapshot'))).toHaveLength(4)
    expect(mergeCalls(stuck)).toEqual([])
  })

  test('pr_unverifiable：读取失败、编号不符、链接不符（大小写不敏感）', async () => {
    const err = setup({ gh: { checks: 'error' } })
    expect(reason((await execute(err)).outcome)).toBe('pr_unverifiable')
    const num = setup()
    num.gh.state.pr.number = 8
    expect(reason((await execute(num)).outcome)).toBe('pr_unverifiable')
    const url = setup()
    url.gh.state.pr.url = 'https://github.com/acme/demo/pull/77'
    expect(reason((await execute(url)).outcome)).toBe('pr_unverifiable')
    for (const x of [err, num, url]) expect(mergeCalls(x)).toEqual([])
    const upper = setup()
    upper.gh.state.pr.url = 'https://github.com/ACME/Demo/pull/7'
    expect((await execute(upper)).outcome.outcome).toBe('done')
  })
})

describe('合并结果', () => {
  test('合并后出现本次触发的自动合并（PR 仍为 OPEN）：关闭它并 failed(merge_failed)', async () => {
    const s = setup({ gh: { mergeBehavior: 'auto' } })
    expect(reason((await execute(s)).outcome)).toBe('merge_failed')
    expect(s.gh.state.calls).toContain(`pr disable-auto ${PR_URL}`)
    expect(s.gh.state.autoEnabled).toBe(false)
    expect(s.gh.state.calls.some((c) => c.startsWith('run list'))).toBe(false)
  })

  test('自动合并在本次之前就存在（别人设置的）：不去关闭它', async () => {
    const s = setup({ gh: { mergeBehavior: 'error', autoBefore: true } })
    expect(reason((await execute(s)).outcome)).toBe('merge_failed')
    expect(s.gh.state.calls).not.toContain(`pr disable-auto ${PR_URL}`)
  })

  test('合并后一直读不回状态：failed(merge_unverified)，摘要写明 PR 可能已合并', async () => {
    const s = setup({ gh: { mergeStateFailures: Number.POSITIVE_INFINITY } })
    const { outcome } = await execute(s)
    expect(reason(outcome)).toBe('merge_unverified')
    if (outcome.outcome === 'failed') expect(outcome.result.summary).toContain('PR 可能已合并')
    expect(s.gh.state.calls.filter((c) => c.startsWith('pr view state'))).toHaveLength(4)
    // 短暂失败后读到：照常继续。
    const flaky = setup({ gh: { mergeStateFailures: 2, runs: [[ghRun()]] } })
    expect((await execute(flaky)).outcome.outcome).toBe('done')
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

describe('流水线的事件、取消与心跳', () => {
  test('只计 push 与 workflow_run 事件的 run', async () => {
    const s = setup({ gh: { runs: [[ghRun({ event: 'pull_request', conclusion: 'failure' })]] } })
    const { outcome } = await execute(s, { discoveryMs: 60_000 })
    expect(outcome.outcome).toBe('done')
    if (outcome.outcome === 'done') expect(outcome.result.summary).toContain('未发现发布流水线')
    const wr = setup({ gh: { runs: [[ghRun({ event: 'workflow_run', conclusion: 'failure' })]] } })
    expect(reason((await execute(wr)).outcome)).toBe('pipeline_failed')
  })

  test('cancelled 的 run：failed(pipeline_failed) 并注明可能被更新的提交取代', async () => {
    const s = setup({ gh: { runs: [[ghRun({ conclusion: 'cancelled' })]] } })
    const { outcome } = await execute(s)
    expect(reason(outcome)).toBe('pipeline_failed')
    if (outcome.outcome === 'failed')
      expect(outcome.result.summary).toContain('被同一并发组中更新的提交取代')
  })

  test('每次轮询都上报心跳', async () => {
    const s = setup({ gh: { runs: [[ghRun({ status: 'in_progress', conclusion: '' })]] } })
    const { texts } = await execute(s, { pipelineTimeoutMs: 10 * 60_000 })
    const beats = texts.filter((t) => t.startsWith('等待流水线'))
    // 15 秒一次，10 分钟约 40 次。
    expect(beats.length).toBeGreaterThanOrEqual(40)
  })

  test('合并后被取消：cancelled 的结果带合并提交与 artifacts', async () => {
    const s = setup({ gh: { runs: [[ghRun({ status: 'in_progress', conclusion: '' })]] } })
    const abort = new AbortController()
    const origList = s.gh.gh.runList
    s.gh.gh.runList = async (...args) => {
      abort.abort()
      return origList(...args)
    }
    const { outcome } = await execute(s, {}, abort.signal)
    expect(outcome.outcome).toBe('cancelled')
    if (outcome.outcome !== 'cancelled') return
    expect(outcome.message).toContain(MERGE_SHA)
    expect(outcome.result?.artifacts).toContainEqual({
      kind: 'commit',
      ref: MERGE_SHA,
      note: '合并到 main',
    })
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

describe('经节点运行：等待流水线期间不被判为无进展', () => {
  test('默认 15 分钟无进展阈值下等待 20 分钟仍为 running，最终 failed(pipeline_timeout)；merger 模板 no_progress_minutes ≥ 35', async () => {
    const minutes = /^no_progress_minutes:\s*(\d+)$/m.exec(DEFAULT_ROLE_FILES['merger.yaml'] ?? '')
    expect(Number(minutes?.[1])).toBeGreaterThanOrEqual(35)

    const s = setup({ gh: { runs: [[ghRun({ status: 'in_progress', conclusion: '' })]] } })
    let polling = false
    const list = s.gh.gh.runList
    s.gh.gh.runList = async (...args) => {
      polling = true
      return list(...args)
    }
    let target: NodeClock = instantClock()
    const clock: NodeClock = {
      now: () => target.now(),
      setTimeout: (cb, ms) => target.setTimeout(cb, ms),
    }
    const hub = fakeHub(s)
    const executor = createPrMergeExecutor({
      home: s.r.home,
      clock,
      gh: s.gh.gh,
      git: { env: gitEnv },
      hub: {
        listTasks: hub.listTasks,
        // 节点分配的任务 id 不是 t-merge：除审查任务外都返回本任务。
        showTask: (id) => hub.showTask(id === s.review.id ? id : s.self.id),
      },
    })
    const b = await bench({ executors: [executor] })
    target = b.clock
    try {
      // 中枢校验 parent 存在：测试台中不建审查任务，parent 的核对由注入的假中枢（本任务视图）完成。
      const { parent: _parent, ...withoutParent } = s.contract
      const id = await b.create({ ...withoutParent, cwd: s.r.repo })
      await waitFor(() => polling, '开始等待流水线')
      for (let i = 0; i < 20; i++) await b.clock.advance(60_000)
      const t = b.task(id)
      expect(t.status).toBe('running')
      expect(b.types(id)).not.toContain('task.blocked')
      const beats = b.ledger.taskActivity(id).filter((a) => a.text?.startsWith('等待流水线'))
      expect(beats.length).toBeGreaterThan(20)
      const end = await b.until(id, (x) => x.status === 'failed', 20 * 60_000)
      expect(end.result?.reason).toBe('pipeline_timeout')
      expect(b.types(id)).not.toContain('task.blocked')
    } finally {
      await b.close()
    }
  })
})
