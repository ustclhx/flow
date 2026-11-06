import {
  clipText,
  compareCursor,
  fail,
  GITHUB_LOGIN_RE,
  type GithubConfig,
  githubHtmlUrl,
  makeCursor,
  normalizePrUrl,
  ok,
  PR_EVENT_CONTEXT_TEXT_MAX,
  PR_EVENT_TEXT_MAX,
  PR_REQUEST_KINDS,
  PR_SUBSCRIPTION_RETENTION_DAYS,
  type PrEventKind,
  type PrEventPayload,
  type PrNotAllowedReason,
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
  allowedLogins,
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
 *   写 `pr.event`；**每种内容各自提交**（一类查询失败不阻塞其他类），游标随事件落账，重启后不重复送达。
 *   有效游标取"已落账游标"与"最早有效订阅时间"中较晚者：订阅之前的历史内容不送达；
 *   以游标时间往前 1 秒重查、按已入账游标去重，避免同一秒内的竞态漏读；
 * - 分页达到上限仍未取完时：按 updated 升序的端点只推进到已取到的部分，其余端点本类本次失败并报告，
 *   不让游标越过没有读到的内容；
 * - 单个 PR 查询失败只记在该 PR 上、下一轮重试；连续 3 次失败才作为系统问题出现在 hub status 并告警；
 * - `allowed`（只有它算"请求"）由这里计算，全部满足才为 true：PR 评论或代码行评论（审查正文、CI 只作上下文）、
 *   人类账号（不是 bot、不是配置的 worker 身份）、账号数字 id 在该 PR 的有效名单中、评论没有被编辑过、
 *   且中枢 gh 登录不与名单共享（共享或无法确认时 fail closed，见 `identity`）；
 * - 攻击者驱动的账本增长有上限：每个 PR 每次轮询、每天入账的非请求事件条数有限，非请求文字只存 500 字；
 * - PR 不在登记仓库或登记仓库读不出 origin 时按失败报告，不自动退订；author 订阅的 PR 不是由任务分支开出 →
 *   取消（not_task_branch）；PR 关闭或合并满 14 天 → 取消（pr_closed）。
 */

export const PR_POLL_BASE_MS = 2 * 60_000
export const PR_POLL_MAX_MS = 10 * 60_000
export const PR_FAILURES_REPORTED = 3
export const PR_MAX_PAGES = 10
/** 中枢 gh 登录的重新核对间隔。 */
export const PR_IDENTITY_REFRESH_MS = 30 * 60_000
/** GitHub 账号（id、类型）缓存时间。 */
export const PR_USER_CACHE_MS = 6 * 60 * 60_000
/** 每个 PR 每次轮询最多入账的非请求事件。 */
export const PR_CONTEXT_PER_POLL = 20
/** 每个 PR 每天最多入账的非请求事件；超出的丢弃并在 hub status 报告。 */
export const PR_CONTEXT_PER_DAY = 200

const user = z
  .object({ login: z.string(), id: z.number().optional(), type: z.string().optional() })
  .nullable()
  .optional()
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
  created_at: z.string().optional(),
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
const ghUser = z.object({ login: z.string(), id: z.number(), type: z.string().optional() })

export interface PrWatchError {
  workspace: string
  pr: string
  failures: number
  message: string
  since: string
}

export interface PrWatchStatus {
  watched: number
  errors: PrWatchError[]
  /** 中枢 gh 登录；查询失败时 ok 为 false（按共享身份处理）。 */
  identity: { ok: boolean; login: string | null; message?: string } | null
  /** 因共享身份而不把任何评论算作请求的 workspace，附原因与解除方法。 */
  shared: { workspace: string; reason: string }[]
  warnings: string[]
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
  status(): PrWatchStatus
}

const key = (workspace: string, pr: string) => `${workspace}\n${pr}`
const iso = (ms: number) => new Date(ms).toISOString()
const cursorTime = (c: string) => Date.parse(c.split('|')[0] ?? '')

type ActorKind = PrEventPayload['actor_kind']

/** 账号分类：GitHub App、`[bot]` 后缀或 type=Bot 为 bot；配置的 worker 身份为 agent。 */
function actorOf(
  u: z.infer<typeof user>,
  workerIdentity: string | undefined,
): { actor: string; id?: number; kind: ActorKind } {
  const login = u?.login ?? ''
  const bot = u?.type === 'Bot' || login.endsWith('[bot]')
  const name = login.replace(/\[bot\]$/, '')
  const actor = GITHUB_LOGIN_RE.test(name) ? (bot ? `${name}[bot]` : name) : 'unknown'
  const agent =
    workerIdentity !== undefined &&
    actor !== 'unknown' &&
    actor.toLowerCase() === workerIdentity.toLowerCase()
  return {
    actor,
    ...(u?.id !== undefined && u.id > 0 ? { id: u.id } : {}),
    kind: agent ? 'agent' : bot ? 'bot' : 'human',
  }
}

/** 先遮蔽疑似密钥再截断，截断时附原始字符数。 */
function textOf(raw: string, max: number): { text: string; chars?: number } {
  const redacted = redactSecrets(raw)
  return redacted.length > max
    ? { text: clipText(redacted, max), chars: redacted.length }
    : { text: redacted }
}

const htmlUrl = (value: string | null | undefined, fallback: string) =>
  githubHtmlUrl.safeParse(value).success ? (value as string) : fallback

/** 一条候选内容（分类与游标在入账前计算）。 */
interface Candidate {
  kind: PrEventKind
  at: string
  id: number
  who: { actor: string; id?: number; kind: ActorKind }
  raw: string
  url: string | null | undefined
  state?: string
  edited?: boolean
}

const SHARED_HINT =
  '为 worker 配置独立的 GitHub bot 账号或 App（github.worker_identity），并让 allowed_users 只含你本人'

export function createPrWatcher(o: PrWatcherOptions): PrWatcher {
  const { ledger } = o
  const clock = o.clock ?? systemClock
  const origin = o.origin ?? gitOriginLookup
  const tickMs = o.tickMs ?? 15_000
  const states = new Map<string, WatchState>()
  const shared = new Map<string, string>()
  const warnings = new Map<string, string>()
  /** 每个 PR 当天已入账与已丢弃的非请求事件数。 */
  const daily = new Map<string, { day: string; used: number; dropped: Set<string> }>()
  const users = new Map<string, { at: number; info: { id: number; type?: string } | null }>()
  let identity:
    | { at: number; ok: true; login: string; id: number }
    | {
        at: number
        ok: false
        message: string
      }
    | null = null
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

  /** 中枢 gh 登录（定期重新核对）；查询失败按共享身份处理。 */
  async function selfIdentity() {
    if (identity && clock.now() - identity.at < PR_IDENTITY_REFRESH_MS) return identity
    const r = await o.gh(githubPaths.self())
    const parsed = r.ok ? ghUser.safeParse(r.data) : undefined
    identity = parsed?.success
      ? { at: clock.now(), ok: true, login: parsed.data.login, id: parsed.data.id }
      : { at: clock.now(), ok: false, message: '无法查询中枢的 gh 登录（gh api user）' }
    return identity
  }

  /** 按登录名查 GitHub 账号的 id 与类型（缓存）；id 变化时告警。 */
  async function userInfo(login: string) {
    const k = login.toLowerCase()
    const cached = users.get(k)
    if (cached && clock.now() - cached.at < PR_USER_CACHE_MS) return cached.info
    let path: string
    try {
      path = githubPaths.user(login)
    } catch {
      return null
    }
    const r = await o.gh(path)
    const parsed = r.ok ? ghUser.safeParse(r.data) : undefined
    if (!parsed?.success) return cached?.info ?? null
    const info = { id: parsed.data.id, ...(parsed.data.type ? { type: parsed.data.type } : {}) }
    if (cached?.info && cached.info.id !== info.id) {
      o.logger?.warn('GitHub 用户名对应的账号 id 已变化', {
        login,
        from: cached.info.id,
        to: info.id,
      })
      warnings.set(
        `id:${k}`,
        `GitHub 用户 ${login} 的账号 id 已从 ${cached.info.id} 变为 ${info.id}`,
      )
    }
    users.set(k, { at: clock.now(), info })
    return info
  }

  /** 分页读取数组资源；任一页失败整体失败。达到页数上限且末页已满时 truncated 为 true。 */
  async function pages<T>(
    build: (page: number) => string,
    schema: z.ZodType<T>,
    unwrap?: (data: unknown) => unknown,
  ): Promise<Result<{ items: T[]; truncated: boolean; total?: number }>> {
    const out: T[] = []
    let total: number | undefined
    for (let p = 1; p <= PR_MAX_PAGES; p++) {
      const r = await o.gh(build(p))
      if (!r.ok) return r
      if (unwrap) {
        const t = (r.data as { total_count?: unknown } | null)?.total_count
        if (typeof t === 'number') total = t
      }
      const parsed = z.array(schema).safeParse(unwrap ? unwrap(r.data) : r.data)
      if (!parsed.success) return fail('failure', 'gh_invalid', 'GitHub 返回格式不符')
      out.push(...parsed.data)
      if (parsed.data.length < 100)
        return ok({ items: out, truncated: false, ...(total !== undefined ? { total } : {}) })
    }
    return ok({ items: out, truncated: true, ...(total !== undefined ? { total } : {}) })
  }

  function unsubscribe(
    workspace: string,
    pr: string,
    reason: 'pr_closed' | 'not_task_branch',
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

  /** 该 PR 的有效名单（数字 id）与共享身份判定。 */
  async function allowance(
    workspace: string,
    github: GithubConfig,
    repo: RepoRef,
  ): Promise<{ ids: Set<number>; shared: string | null }> {
    let logins: string[]
    if (github.allowed_users === undefined) {
      // 默认只取该 PR 所属登记仓库的 owner，且只在 owner 是个人账号时。
      const owner = await userInfo(repo.owner)
      if (owner?.type !== 'User') {
        warnings.set(
          `org:${workspace}:${repo.owner}`,
          `${workspace}：仓库 owner ${repo.owner} ${owner ? '不是个人账号' : '无法查询'}，默认允许名单为空；请在 github.allowed_users 中显式列出`,
        )
        logins = []
      } else logins = allowedLogins(github, repo.owner)
    } else logins = allowedLogins(github, undefined)
    const ids = new Set<number>()
    for (const login of logins) {
      const info = await userInfo(login)
      if (info) ids.add(info.id)
      else warnings.set(`user:${login}`, `无法解析允许名单中的 GitHub 用户 ${login}（不算请求）`)
    }
    if (!ids.size) return { ids, shared: null }
    const self = await selfIdentity()
    if (!self.ok)
      return { ids, shared: `${self.message}，无法确认 worker 不以名单内身份发言；${SHARED_HINT}` }
    if (!ids.has(self.id)) return { ids, shared: null }
    const wi = github.worker_identity
    const lifted =
      wi !== undefined &&
      wi.toLowerCase() !== self.login.toLowerCase() &&
      !logins.includes(wi.toLowerCase())
    return lifted
      ? { ids, shared: null }
      : {
          ids,
          shared: `中枢 gh 登录 ${self.login} 在允许名单中，worker 以它发的评论会被当作你本人的请求；在此之前 PR 评论只作上下文，不恢复任务、不交回、不唤醒 supervisor。解除：${SHARED_HINT}`,
        }
  }

  /** 轮询一个 PR；返回是否读到新内容。失败时返回错误说明（已入账的种类不回滚）。 */
  async function poll(
    workspace: string,
    pr: string,
    github: GithubConfig,
    repos: { repos: RepoRef[]; unresolved: number },
  ): Promise<Result<boolean>> {
    const repo = prRepoOf(pr)
    const number = Number(pr.split('/').at(-1))
    if (!repo) return ok(false)
    const registered = repos.repos.find((r) => sameRepo(r, repo))
    if (!registered) {
      // 不自动退订：origin 暂时读不出来或登记仓库调整都可能是临时的。
      return repos.unresolved > 0
        ? fail('retryable', 'repo_unresolved', '有登记仓库读不出 origin，暂时无法确认 PR 所在仓库')
        : fail('failure', 'repo_not_registered', 'PR 不在本 workspace 登记的仓库中')
    }
    // 仓库标识一律取登记仓库 origin 解析出的值（不取 PR 链接或评论内容）。
    const meta = await o.gh(githubPaths.pull(registered, number))
    if (!meta.ok) return meta
    const parsedMeta = pullMeta.safeParse(meta.data)
    if (!parsedMeta.success) return fail('failure', 'gh_invalid', 'PR 信息格式不符')
    const m = parsedMeta.data
    const closedAt = m.merged_at ?? m.closed_at ?? null
    if (
      closedAt &&
      clock.now() - Date.parse(closedAt) > PR_SUBSCRIPTION_RETENTION_DAYS * 86_400_000
    ) {
      unsubscribe(workspace, pr, 'pr_closed')
      return ok(false)
    }
    const prState: PrEventPayload['pr_state'] = m.merged_at
      ? 'merged'
      : m.state === 'closed'
        ? 'closed'
        : 'open'
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
    if (!subs.length) return ok(false)
    const { ids, shared: sharedReason } = await allowance(workspace, github, registered)
    if (sharedReason) shared.set(workspace, sharedReason)
    else shared.delete(workspace)
    const baseline = makeCursor(
      subs.map((s) => s.subscribed_at).sort()[0] ?? iso(clock.now()),
      0,
    ) as string
    const cursors = ledger.prCursors(workspace, pr)
    const day = iso(clock.now()).slice(0, 10)
    const k = key(workspace, pr)
    let budget = daily.get(k)
    if (budget?.day !== day) {
      budget = { day, used: 0, dropped: new Set<string>() }
      daily.set(k, budget)
    }
    let pollBudget = PR_CONTEXT_PER_POLL
    let wrote = false
    const errors: string[] = []

    /** 本类的有效游标、重查窗口起点与窗口内已入账的游标。 */
    const window = (kind: PrEventKind) => {
      const stored = cursors[kind]
      const effective = stored && compareCursor(stored, baseline) > 0 ? stored : baseline
      const start =
        stored && effective === stored ? cursorTime(stored) - 1000 : cursorTime(baseline)
      const seen = new Set(
        stored && effective === stored
          ? ledger.prEventCursorsSince(workspace, pr, kind, iso(start))
          : [],
      )
      return { effective, start, seen, since: iso(start) }
    }

    const classify = (
      c: Candidate,
    ): Pick<PrEventPayload, 'allowed'> & { not_allowed?: PrNotAllowedReason } => {
      const reason: PrNotAllowedReason | undefined =
        c.who.kind === 'bot'
          ? 'bot'
          : c.who.kind === 'agent'
            ? 'agent'
            : !PR_REQUEST_KINDS.includes(c.kind)
              ? 'kind'
              : c.who.id === undefined || !ids.has(c.who.id)
                ? 'not_listed'
                : c.edited
                  ? 'edited'
                  : sharedReason
                    ? 'shared_identity'
                    : undefined
      return reason ? { allowed: false, not_allowed: reason } : { allowed: true }
    }

    /** 筛出本类的新内容并入账（各类独立提交）。 */
    const commit = (kind: PrEventKind, candidates: Candidate[]) => {
      const w = window(kind)
      // 同一条评论多次编辑只保留最新一次。
      const latest = new Map<number, Candidate>()
      for (const c of candidates) {
        const prev = latest.get(c.id)
        if (!prev || Date.parse(c.at) >= Date.parse(prev.at)) latest.set(c.id, c)
      }
      const fresh: (Candidate & { cursor: string })[] = []
      for (const c of latest.values()) {
        const cursor = makeCursor(c.at, c.id)
        if (!cursor || w.seen.has(cursor)) continue
        const later = compareCursor(cursor, w.effective) > 0
        const raced = cursorTime(cursor) >= w.start && compareCursor(cursor, baseline) > 0
        if (later || raced) fresh.push({ ...c, cursor })
      }
      fresh.sort((a, b) => compareCursor(a.cursor, b.cursor))
      const drafts: EventInput[] = []
      for (const c of fresh) {
        const verdict = classify(c)
        if (!verdict.allowed) {
          if (pollBudget <= 0) break // 本次轮询的配额用完：后面的（含请求）下一轮再读，游标不越过它们。
          if ((budget as { used: number }).used >= PR_CONTEXT_PER_DAY) {
            ;(budget as { dropped: Set<string> }).dropped.add(c.cursor)
            continue
          }
          pollBudget--
          ;(budget as { used: number }).used++
        }
        const payload: PrEventPayload = {
          pr,
          kind,
          actor: c.who.actor,
          ...(c.who.id !== undefined ? { actor_id: c.who.id } : {}),
          actor_kind: c.who.kind,
          ...verdict,
          pr_state: prState,
          ...(c.state ? { state: c.state } : {}),
          ...textOf(c.raw, verdict.allowed ? PR_EVENT_TEXT_MAX : PR_EVENT_CONTEXT_TEXT_MAX),
          url: htmlUrl(c.url, pr),
          cursor: c.cursor,
        }
        drafts.push({ type: 'pr.event', workspace, payload })
      }
      if (!drafts.length) return
      const written = ledger.appendMany(drafts, { actor: 'hub' })
      if (written.ok) wrote = true
      else errors.push(`${kind}：${written.error.message}`)
    }

    const wi = github.worker_identity
    const issue = await pages(
      (p) => githubPaths.issueComments(registered, number, p, window('issue_comment').since),
      comment,
    )
    if (!issue.ok) errors.push(`issue_comment：${issue.error.message}`)
    else if (issue.data.truncated) errors.push('issue_comment：新评论超过分页上限，本次未入账')
    else
      commit(
        'issue_comment',
        issue.data.items.map((c) => ({
          kind: 'issue_comment',
          at: c.updated_at,
          id: c.id,
          who: actorOf(c.user, wi),
          raw: c.body ?? '',
          url: c.html_url,
          edited: c.created_at !== undefined && c.created_at !== c.updated_at,
        })),
      )
    const reviewComments = await pages(
      (p) => githubPaths.reviewComments(registered, number, p, window('review_comment').since),
      comment,
    )
    if (!reviewComments.ok) errors.push(`review_comment：${reviewComments.error.message}`)
    // 按 updated 升序：截断时只推进到已取到的部分，其余下一轮继续。
    else
      commit(
        'review_comment',
        reviewComments.data.items.map((c) => ({
          kind: 'review_comment',
          at: c.updated_at,
          id: c.id,
          who: actorOf(c.user, wi),
          raw: c.path ? `[${c.path}] ${c.body ?? ''}` : (c.body ?? ''),
          url: c.html_url,
          edited: c.created_at !== undefined && c.created_at !== c.updated_at,
        })),
      )
    const reviews = await pages((p) => githubPaths.reviews(registered, number, p), review)
    if (!reviews.ok) errors.push(`review：${reviews.error.message}`)
    else if (reviews.data.truncated) errors.push('review：审查超过分页上限，本次未入账')
    else
      commit(
        'review',
        reviews.data.items.flatMap((r) => {
          const state = r.state.toLowerCase()
          if (!/^[a-z_]{1,64}$/.test(state) || state === 'pending' || !r.submitted_at) return []
          return [
            {
              kind: 'review' as const,
              at: r.submitted_at,
              id: r.id,
              who: actorOf(r.user, wi),
              raw: r.body?.trim() ? r.body : `审查结论：${state}`,
              url: r.html_url,
              state,
            },
          ]
        }),
      )
    if (/^[0-9a-f]{40}$/.test(m.head.sha)) {
      const checks = await pages(
        (p) => githubPaths.checkRuns(registered, m.head.sha, p),
        checkRun,
        (data) => (data as { check_runs?: unknown } | null)?.check_runs,
      )
      if (!checks.ok) errors.push(`check_run：${checks.error.message}`)
      else if (checks.data.truncated || (checks.data.total ?? 0) > checks.data.items.length)
        errors.push('check_run：检查数超过分页上限，本次未入账')
      else
        commit(
          'check_run',
          checks.data.items.flatMap((c) => {
            if (c.status !== 'completed' || !c.completed_at) return []
            const conclusion = (c.conclusion ?? 'unknown').toLowerCase()
            const slug = c.app?.slug ?? 'checks'
            return [
              {
                kind: 'check_run' as const,
                at: c.completed_at,
                id: c.id,
                who: {
                  actor: GITHUB_LOGIN_RE.test(slug) ? `${slug}[bot]` : 'checks[bot]',
                  kind: 'bot' as const,
                },
                raw: [`${c.name}：${conclusion}`, c.output?.title ?? '', c.output?.summary ?? '']
                  .filter(Boolean)
                  .join('\n'),
                url: c.html_url,
                ...(/^[a-z_]{1,64}$/.test(conclusion) ? { state: conclusion } : {}),
              },
            ]
          }),
        )
    }
    if (budget.dropped.size) {
      warnings.set(
        `drop:${k}`,
        `${pr}（${workspace}）今天的非请求内容超过 ${PR_CONTEXT_PER_DAY} 条上限，已丢弃 ${budget.dropped.size} 条`,
      )
    }
    if (errors.length) return fail('retryable', 'pr_poll_partial', errors.join('；'))
    return ok(wrote)
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
      { github: GithubConfig; repos: { repos: RepoRef[]; unresolved: number } } | null
    >()
    let polled = 0
    for (const [k, { workspace, pr }] of wanted) {
      if (stopped) break
      let state = states.get(k)
      if (state && state.nextAt > now) continue
      if (!configs.has(workspace)) {
        const ws = await o.workspaces(workspace)
        configs.set(
          workspace,
          ws?.github?.watch
            ? { github: ws.github, repos: await registeredGithubRepos(ws.repos, origin) }
            : null,
        )
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
      const result = await poll(workspace, pr, config.github, config.repos).catch(
        (error: unknown) => fail('failure', 'pr_poll_failed', String(error)),
      )
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
        identity: identity
          ? identity.ok
            ? { ok: true, login: identity.login }
            : { ok: false, login: null, message: identity.message }
          : null,
        shared: [...shared].map(([workspace, reason]) => ({ workspace, reason })),
        warnings: [...warnings.values()],
      }
    },
  }
}
