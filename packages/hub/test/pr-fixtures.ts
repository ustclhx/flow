import { join } from 'node:path'
import {
  defaultSupervisorConfig,
  fail,
  type GithubConfig,
  ok,
  type Result,
  type TaskContractInput,
} from '@raindown/core'
import type { WorkspaceInfo } from '../src/ledger/tasks.ts'
import type { GhApi } from '../src/pr/github.ts'
import { createPrSubscriptionReactor } from '../src/pr/subscriptions.ts'
import { createPrWatcher } from '../src/pr/watcher.ts'
import { contract, must, startTask, tempLedger, WS } from './ledger-helpers.ts'
import { FakeClock } from './server-fixtures.ts'

/** PR 订阅测试共用：假的 GitHub（只响应白名单路径）、临时账本与任务。 */

export const OWNER = 'acme'
export const PR = 'https://github.com/acme/demo/pull/40'
export const BRANCH = 'raindown/t-dev'
export const HEAD = 'c'.repeat(40)
export const T0 = Date.parse('2026-10-24T00:00:00Z')

export interface FakeComment {
  id: number
  user: { login: string; type?: string } | null
  body: string
  updated_at: string
  html_url?: string
  path?: string
}
export interface FakeReview {
  id: number
  user: { login: string; type?: string } | null
  body: string
  state: string
  submitted_at: string
}
export interface FakeCheck {
  id: number
  name: string
  status: string
  conclusion: string | null
  completed_at: string | null
  app?: { slug: string }
  output?: { title?: string; summary?: string }
}

/** 假的 GitHub：按路径返回数据，记录所有调用；`failing` 为 true 时所有查询失败。 */
export class FakeGitHub {
  calls: string[] = []
  failing = false
  pull = {
    state: 'open',
    closed_at: null as string | null,
    merged_at: null as string | null,
    head: {
      ref: BRANCH,
      sha: HEAD,
      repo: { full_name: 'acme/demo' } as { full_name: string } | null,
    },
    base: { repo: { full_name: 'acme/demo' } },
  }
  issueComments: FakeComment[] = []
  reviewComments: FakeComment[] = []
  reviews: FakeReview[] = []
  checks: FakeCheck[] = []

  api: GhApi = async (path): Promise<Result<unknown>> => {
    this.calls.push(path)
    if (this.failing) return fail('retryable', 'gh_query_failed', 'gh api 查询失败')
    const url = new URL(`https://api.github.com/${path}`)
    const since = url.searchParams.get('since')
    const page = Number(url.searchParams.get('page') ?? '1')
    const paged = <T>(items: T[]) => (page === 1 ? items : [])
    const after = (items: FakeComment[]) =>
      paged(items.filter((c) => !since || Date.parse(c.updated_at) >= Date.parse(since)))
    if (/\/pulls\/\d+$/.test(url.pathname)) return ok(this.pull)
    if (/\/issues\/\d+\/comments$/.test(url.pathname)) return ok(after(this.issueComments))
    if (/\/pulls\/\d+\/comments$/.test(url.pathname)) return ok(after(this.reviewComments))
    if (/\/pulls\/\d+\/reviews$/.test(url.pathname)) return ok(paged(this.reviews))
    if (/\/check-runs$/.test(url.pathname))
      return ok({ total_count: this.checks.length, check_runs: paged(this.checks) })
    return fail('failure', 'not_found', `未知路径 ${path}`)
  }
}

export interface PrSetupOptions {
  github?: GithubConfig | undefined
  origin?: string | undefined
  contract?: Partial<TaskContractInput>
}

/** 建临时账本、一个已开始的 codex-orca 开发任务，以及订阅反应器与 pr-watcher（均未启动）。 */
export async function prSetup(o: PrSetupOptions = {}) {
  const clock = new FakeClock(T0)
  const l = await tempLedger({ now: clock.now })
  const repo = join(l.dir, 'repo')
  const gh = new FakeGitHub()
  const github: GithubConfig | undefined = 'github' in o ? o.github : { watch: true }
  const workspace: WorkspaceInfo = {
    ref: WS,
    repos: [repo],
    supervisor: defaultSupervisorConfig(),
    ...(github ? { github } : {}),
  }
  const origin = 'origin' in o ? o.origin : `git@github.com:${OWNER}/demo.git`
  const workspaces = async (ref: string) => (ref === WS ? workspace : null)
  const reactor = createPrSubscriptionReactor({ ledger: l.store, workspaces })
  const watcher = createPrWatcher({
    ledger: l.store,
    workspaces,
    gh: gh.api,
    origin: async (path) => (path === repo ? origin : undefined),
    clock,
  })
  const dev = contract({ executor: 'codex-orca', cwd: repo, ...o.contract })
  must(
    l.store.append(
      { type: 'task.created', task_id: 'dev', workspace: WS, payload: { contract: dev } },
      { actor: 'user' },
    ),
  )
  startTask(l.store, 'dev')
  const branch = () =>
    must(
      l.store.append(
        {
          type: 'task.branch_reported',
          task_id: 'dev',
          workspace: WS,
          payload: { branch: BRANCH, worktree: join(l.dir, 'wt') },
        },
        { actor: 'node:n1' },
      ),
    )
  /** worker 以 ready 上报 PR（开出 PR）。 */
  const reportPr = (url = PR) =>
    must(
      l.store.append(
        {
          type: 'task.reported',
          task_id: 'dev',
          workspace: WS,
          payload: {
            status: 'ready',
            summary: '已开 PR',
            deliverables: [url],
            attempt: 1,
            lease_id: 'l-dev-1',
          },
        },
        { actor: 'node:n1' },
      ),
    )
  const cleanup = async () => {
    await watcher.stop()
    await reactor.stop()
    l.cleanup()
  }
  return { ...l, clock, gh, repo, workspace, reactor, watcher, branch, reportPr, cleanup }
}

export const iso = (ms: number) => new Date(ms).toISOString()
