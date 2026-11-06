import {
  clipText,
  compareCursor,
  fail,
  GITHUB_LOGIN_RE,
  githubHtmlUrl,
  makeCursor,
  normalizePrUrl,
  PR_EVENT_TEXT_MAX,
  PR_SUBSCRIPTION_RETENTION_DAYS,
  type PrEventKind,
  type PrEventPayload,
  prRepoOf,
  type RepoRef,
  type Result,
  redactSecrets,
  sameRepo,
} from '@raindown/core'
import { z } from 'zod'
import type { EventInput, LedgerStore } from '../ledger/store.ts'
import type { WorkspaceLookup } from '../ledger/tasks.ts'
import { type HubClock, systemClock } from '../server/clock.ts'
import type { HubLogger } from '../server/maintenance.ts'
import {
  effectiveAllowedUsers,
  type GhApi,
  githubPaths,
  gitOriginLookup,
  type RepoOriginLookup,
  registeredGithubRepos,
} from './github.ts'

/**
 * 中枢 pr-watcher（harness-neutral D11；tasks 8.3）。
 *
 * - 只对 `github.watch: true` 的 workspace、且有有效订阅的 PR 轮询：每 2 分钟一次，连续无变化时
 *   逐次加倍退避到 10 分钟，读到新内容后回到 2 分钟；
 * - 读取 PR 状态、check runs、reviews、issue comments 与 review comments，按各自游标只取新内容，
 *   写 `pr.event`（同一 PR 一次轮询的事件在一个事务里写入，游标随事件落账，重启后不重复送达）。
 *   首次轮询以订阅时间为起点：订阅之前的历史内容不送达；
 * - 单个 PR 查询失败只记在该 PR 上、下一轮重试；连续 3 次失败才作为系统问题出现在 hub status 并告警；
 * - `allowed` 由这里按 `github.allowed_users`（缺省为登记仓库 owner）计算：只有人类账号才可能 allowed；
 * - PR 不在登记仓库 → 取消订阅（repo_not_registered）；author 订阅的 PR 不是由任务分支开出 →
 *   取消（not_task_branch）；PR 关闭或合并满 14 天 → 取消（pr_closed）。
 */

export const PR_POLL_BASE_MS = 2 * 60_000
export const PR_POLL_MAX_MS = 10 * 60_000
export const PR_FAILURES_REPORTED = 3
const MAX_PAGES = 5

const user = z.object({ login: z.string(), type: z.string().optional() }).nullable().optional()
const pullMeta = z.object({
  state: z.string(),
  closed_at: z.string().nullable().optional(),
  merged_at: z.string().nullable().optional(),
  head: z.object({
    ref: z.string(),
    sha: z.string(),
    repo: z.object({ full_name: z.string() }).nullable().optional(),
  }),
  base: z.object({ repo: z.object({ full_name: z.string() }) }),
})
const comment = z.object({
  id: z.number(),
  user,
  body: z.string().nullable().optional(),
  html_url: z.string().optional(),
  updated_at: z.string(),
  path: z.string().optional(),
})
const review = z.object({
  id: z.number(),
  user,
  body: z.string().nullable().optional(),
  state: z.string(),
  html_url: z.string().optional(),
  submitted_at: z.string().nullable().optional(),
})
const checkRun = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
  html_url: z.string().nullable().optional(),
  app: z.object({ slug: z.string() }).nullable().optional(),
  output: z
    .object({ title: z.string().nullable().optional(), summary: z.string().nullable().optional() })
    .nullable()
    .optional(),
})

export interface PrWatchError {
  workspace: string
  pr: string
  failures: number
  message: string
  since: string
}

interface WatchState {
  workspace: string
  pr: string
  nextAt: number
  intervalMs: number
  failures: number
  failingSince: number | null
  lastError: string
}

export interface PrWatcherOptions {
  ledger: LedgerStore
  workspaces: WorkspaceLookup
  gh: GhApi
  origin?: RepoOriginLookup
  clock?: HubClock
  logger?: Pick<HubLogger, 'warn'>
  /** 检查到期 PR 的间隔（毫秒），默认 15 秒。 */
  tickMs?: number
}

export interface PrWatcher {
  start(): void
  stop(): Promise<void>
  /** 立即轮询所有到期的 PR（测试与启动时用）；返回本轮轮询的 PR 数。 */
  tick(): Promise<number>
  status(): { watched: number; errors: PrWatchError[] }
}

const key = (workspace: string, pr: string) => `${workspace}\n${pr}`
const iso = (ms: number) => new Date(ms).toISOString()

/** 账号是否为机器人：GitHub App、`[bot]` 后缀或 type=Bot。 */
function actorOf(u: z.infer<typeof user>): { actor: string; kind: 'human' | 'bot' } {
  const login = u?.login ?? ''
  const bot = u?.type === 'Bot' || login.endsWith('[bot]')
  const name = login.replace(/\[bot\]$/, '')
  if (!GITHUB_LOGIN_RE.test(name)) return { actor: 'unknown', kind: bot ? 'bot' : 'human' }
  return { actor: bot ? `${name}[bot]` : name, kind: bot ? 'bot' : 'human' }
}

/** 先遮蔽疑似密钥再截断，截断时附原始字符数。 */
function textOf(raw: string): { text: string; chars?: number } {
  const redacted = redactSecrets(raw)
  return redacted.length > PR_EVENT_TEXT_MAX
    ? { text: clipText(redacted, PR_EVENT_TEXT_MAX), chars: redacted.length }
    : { text: redacted }
}

const htmlUrl = (value: string | null | undefined, fallback: string) =>
  githubHtmlUrl.safeParse(value).success ? (value as string) : fallback

export function createPrWatcher(o: PrWatcherOptions): PrWatcher {
  const { ledger } = o
  const clock = o.clock ?? systemClock
  const origin = o.origin ?? gitOriginLookup
  const tickMs = o.tickMs ?? 15_000
  const states = new Map<string, WatchState>()
  let stopped = false
  let running: Promise<number> | null = null
  let cancelTimer: (() => void) | undefined

  function schedule() {
    if (stopped) return
    cancelTimer = clock.setTimeout(async () => {
      cancelTimer = undefined
      await tick().catch((error: unknown) => o.logger?.warn('PR 轮询失败', String(error)))
      schedule()
    }, tickMs)
  }

  /** 分页读取数组资源；任一页失败整体失败。 */
  async function pages<T>(
    build: (page: number) => string,
    schema: z.ZodType<T>,
    unwrap?: (data: unknown) => unknown,
  ): Promise<Result<T[]>> {
    const out: T[] = []
    for (let p = 1; p <= MAX_PAGES; p++) {
      const r = await o.gh(build(p))
      if (!r.ok) return r
      const parsed = z.array(schema).safeParse(unwrap ? unwrap(r.data) : r.data)
      if (!parsed.success) {
        return fail('failure', 'gh_invalid', 'GitHub 返回格式不符')
      }
      out.push(...parsed.data)
      if (parsed.data.length < 100) break
    }
    return { ok: true, data: out }
  }

  function unsubscribe(
    workspace: string,
    pr: string,
    reason: 'pr_closed' | 'not_task_branch' | 'repo_not_registered',
    only?: (taskId: string) => boolean,
  ) {
    for (const sub of ledger.activePrSubscriptions(workspace)) {
      if (sub.pr !== pr || (only && !only(sub.task_id))) continue
      const r = ledger.append(
        { type: 'pr.unsubscribed', task_id: sub.task_id, workspace, payload: { pr, reason } },
        { actor: 'hub' },
      )
      if (!r.ok) o.logger?.warn('取消 PR 订阅失败', { task_id: sub.task_id, pr, error: r.error })
    }
  }

  /** 轮询一个 PR；返回是否读到新内容。失败时返回错误说明（不抛出）。 */
  async function poll(
    workspace: string,
    pr: string,
    repos: RepoRef[],
    allowed: Set<string>,
  ): Promise<Result<boolean>> {
    const repo = prRepoOf(pr)
    const number = Number(pr.split('/').at(-1))
    if (!repo) return { ok: true, data: false }
    const registered = repos.find((r) => sameRepo(r, repo))
    if (!registered) {
      unsubscribe(workspace, pr, 'repo_not_registered')
      return { ok: true, data: false }
    }
    // 仓库标识一律取登记仓库 origin 解析出的值（不取 PR 链接或评论内容）。
    const meta = await o.gh(githubPaths.pull(registered, number))
    if (!meta.ok) return meta
    const parsedMeta = pullMeta.safeParse(meta.data)
    if (!parsedMeta.success) {
      return fail('failure', 'gh_invalid', 'PR 信息格式不符')
    }
    const m = parsedMeta.data
    const closedAt = m.merged_at ?? m.closed_at ?? null
    if (
      closedAt &&
      clock.now() - Date.parse(closedAt) > PR_SUBSCRIPTION_RETENTION_DAYS * 86_400_000
    ) {
      unsubscribe(workspace, pr, 'pr_closed')
      return { ok: true, data: false }
    }
    // author 订阅只认由任务分支开出、且不是 fork 的 PR。
    const sameBase =
      m.head.repo?.full_name !== undefined &&
      m.head.repo.full_name.toLowerCase() === m.base.repo.full_name.toLowerCase()
    unsubscribe(workspace, pr, 'not_task_branch', (taskId) => {
      const sub = ledger.prSubscriptions(taskId).findLast((s) => s.pr === pr && s.active)
      if (sub?.role !== 'author') return false
      const task = ledger.getTask(taskId)
      return !task?.branch || task.branch !== m.head.ref || !sameBase
    })
    const subs = ledger.activePrSubscriptions(workspace).filter((s) => s.pr === pr)
    if (!subs.length) return { ok: true, data: false }
    const baseline = makeCursor(
      subs.map((s) => s.subscribed_at).sort()[0] ?? iso(clock.now()),
      0,
    ) as string
    const cursors = ledger.prCursors(workspace, pr)
    const cursorOf = (kind: PrEventKind) => cursors[kind] ?? baseline
    const sinceOf = (kind: PrEventKind) => cursorOf(kind).split('|')[0]
    const fresh: PrEventPayload[] = []
    const push = (
      kind: PrEventKind,
      at: string | null | undefined,
      id: number,
      who: { actor: string; kind: 'human' | 'bot' },
      raw: string,
      url: string | null | undefined,
      state?: string,
    ) => {
      if (!at) return
      const cursor = makeCursor(at, id)
      if (!cursor || compareCursor(cursor, cursorOf(kind)) <= 0) return
      fresh.push({
        pr,
        kind,
        actor: who.actor,
        actor_kind: who.kind,
        allowed:
          who.kind === 'human' && who.actor !== 'unknown' && allowed.has(who.actor.toLowerCase()),
        ...(state ? { state } : {}),
        ...textOf(raw),
        url: htmlUrl(url, pr),
        cursor,
      })
    }
    const issueComments = await pages(
      (p) => githubPaths.issueComments(registered, number, p, sinceOf('issue_comment')),
      comment,
    )
    if (!issueComments.ok) return issueComments
    for (const c of issueComments.data) {
      push('issue_comment', c.updated_at, c.id, actorOf(c.user), c.body ?? '', c.html_url)
    }
    const reviewComments = await pages(
      (p) => githubPaths.reviewComments(registered, number, p, sinceOf('review_comment')),
      comment,
    )
    if (!reviewComments.ok) return reviewComments
    for (const c of reviewComments.data) {
      const body = c.body ?? ''
      push(
        'review_comment',
        c.updated_at,
        c.id,
        actorOf(c.user),
        c.path ? `[${c.path}] ${body}` : body,
        c.html_url,
      )
    }
    const reviews = await pages((p) => githubPaths.reviews(registered, number, p), review)
    if (!reviews.ok) return reviews
    for (const r of reviews.data) {
      const state = r.state.toLowerCase()
      if (!/^[a-z_]{1,64}$/.test(state) || state === 'pending') continue
      push(
        'review',
        r.submitted_at,
        r.id,
        actorOf(r.user),
        r.body?.trim() ? r.body : `审查结论：${state}`,
        r.html_url,
        state,
      )
    }
    if (/^[0-9a-f]{40}$/.test(m.head.sha)) {
      const checks = await pages(
        (p) => githubPaths.checkRuns(registered, m.head.sha, p),
        checkRun,
        (data) => (data as { check_runs?: unknown } | null)?.check_runs,
      )
      if (!checks.ok) return checks
      for (const c of checks.data) {
        if (c.status !== 'completed') continue
        const conclusion = (c.conclusion ?? 'unknown').toLowerCase()
        const slug = c.app?.slug ?? 'checks'
        const body = [`${c.name}：${conclusion}`, c.output?.title ?? '', c.output?.summary ?? '']
          .filter(Boolean)
          .join('\n')
        push(
          'check_run',
          c.completed_at,
          c.id,
          { actor: GITHUB_LOGIN_RE.test(slug) ? `${slug}[bot]` : 'checks[bot]', kind: 'bot' },
          body,
          c.html_url,
          /^[a-z_]{1,64}$/.test(conclusion) ? conclusion : undefined,
        )
      }
    }
    if (!fresh.length) return { ok: true, data: false }
    fresh.sort((a, b) => compareCursor(a.cursor, b.cursor))
    const drafts: EventInput[] = fresh.map((payload) => ({ type: 'pr.event', workspace, payload }))
    const written = ledger.appendMany(drafts, { actor: 'hub' })
    if (!written.ok) return written
    return { ok: true, data: true }
  }

  async function tickOnce(): Promise<number> {
    const now = clock.now()
    const subs = ledger.activePrSubscriptions()
    const wanted = new Map<string, { workspace: string; pr: string }>()
    for (const s of subs) {
      const pr = normalizePrUrl(s.pr)
      if (pr) wanted.set(key(s.workspace, pr), { workspace: s.workspace, pr })
    }
    for (const k of [...states.keys()]) if (!wanted.has(k)) states.delete(k)
    const configs = new Map<
      string,
      { watch: boolean; repos: RepoRef[]; allowed: Set<string> } | null
    >()
    let polled = 0
    for (const [k, { workspace, pr }] of wanted) {
      if (stopped) break
      let state = states.get(k)
      if (state && state.nextAt > now) continue
      if (!configs.has(workspace)) {
        const ws = await o.workspaces(workspace)
        if (!ws?.github?.watch) configs.set(workspace, null)
        else {
          const repos = await registeredGithubRepos(ws.repos, origin)
          configs.set(workspace, {
            watch: true,
            repos,
            allowed: effectiveAllowedUsers(ws.github, repos),
          })
        }
      }
      const config = configs.get(workspace)
      if (!config) {
        states.delete(k)
        continue
      }
      if (!state) {
        state = {
          workspace,
          pr,
          nextAt: now,
          intervalMs: PR_POLL_BASE_MS,
          failures: 0,
          failingSince: null,
          lastError: '',
        }
        states.set(k, state)
      }
      polled++
      let result: Result<boolean>
      if (!config.repos.length) {
        // 登记仓库的 origin 读不出来：可能是暂时的（目录未挂载），按失败计数，不取消订阅。
        result = fail('retryable', 'repo_unresolved', '无法解析登记仓库的 origin')
      } else {
        result = await poll(workspace, pr, config.repos, config.allowed).catch((error: unknown) =>
          fail('failure', 'pr_poll_failed', String(error)),
        )
      }
      const at = clock.now()
      if (result.ok) {
        state.failures = 0
        state.failingSince = null
        state.lastError = ''
        // 读到新内容回到 2 分钟；无变化时按当前间隔等待，下一次再加倍（2、4、8、10…分钟）。
        if (result.data) state.intervalMs = PR_POLL_BASE_MS
        state.nextAt = at + state.intervalMs
        if (!result.data) state.intervalMs = Math.min(PR_POLL_MAX_MS, state.intervalMs * 2)
      } else {
        state.failures++
        state.failingSince ??= at
        state.lastError = redactSecrets(result.error.message)
        state.intervalMs = PR_POLL_BASE_MS
        state.nextAt = at + PR_POLL_BASE_MS
        if (state.failures === PR_FAILURES_REPORTED) {
          o.logger?.warn('PR 连续查询失败', { workspace, pr, message: state.lastError })
        }
      }
    }
    return polled
  }

  function tick(): Promise<number> {
    if (running) return running
    running = tickOnce().finally(() => {
      running = null
    })
    return running
  }

  return {
    start() {
      if (stopped || cancelTimer) return
      void tick().catch((error: unknown) => o.logger?.warn('PR 轮询失败', String(error)))
      schedule()
    },
    async stop() {
      stopped = true
      cancelTimer?.()
      cancelTimer = undefined
      await running?.catch(() => 0)
    },
    tick,
    status() {
      return {
        watched: states.size,
        errors: [...states.values()]
          .filter((s) => s.failures >= PR_FAILURES_REPORTED)
          .map((s) => ({
            workspace: s.workspace,
            pr: s.pr,
            failures: s.failures,
            message: s.lastError,
            since: iso(s.failingSince ?? clock.now()),
          })),
      }
    },
  }
}
