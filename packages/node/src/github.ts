import { fail, ok, PR_URL_RE, type Result } from '@flow/core'
import { z } from 'zod'
import { type CommandOutput, type CommandRunner, execRunner } from './codex-orca/orca.ts'

/**
 * PR 审查准备与 pr-merge 执行器共用的 GitHub 与 git 辅助（add-m1-supervisor D10）。
 *
 * - 所有 gh 调用都用 PR 的完整链接或 `HOST/OWNER/REPO` 显式指定仓库，不依赖 gh 按 remote 推断；
 * - 输出一律按 schema 校验，任何解析失败都返回错误（调用方据此判失败，绝不当作通过）；
 * - `run` 可注入：测试用假 gh，绝不调用真实 gh。git 也经同一个 runner 执行，测试中对本地临时仓库运行真实 git。
 */

/** PR 链接拆出的仓库与编号。host、owner、repo 按 GitHub 规则不区分大小写比较。 */
export interface PrRef {
  url: string
  host: string
  owner: string
  repo: string
  number: number
}

/** 仓库标识（host/owner/repo）。 */
export interface RepoRef {
  host: string
  owner: string
  repo: string
}

export function parsePrUrl(url: string): PrRef | undefined {
  if (!PR_URL_RE.test(url)) return undefined
  const m = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(url)
  if (!m?.[1] || !m[2] || !m[3] || !m[4]) return undefined
  const number = Number(m[4])
  if (!Number.isSafeInteger(number)) return undefined
  return { url, host: m[1], owner: m[2], repo: m[3], number }
}

const SEGMENT = /^[A-Za-z0-9_.-]+$/

/**
 * 解析 remote 地址：`https://host/owner/repo(.git)`、`ssh://[user@]host[:port]/owner/repo(.git)`、
 * `[user@]host:owner/repo(.git)`。其他形式（本地路径、file://、多级路径、带凭证的 https）返回 undefined。
 */
export function parseRemoteUrl(url: string): RepoRef | undefined {
  const trimmed = url.trim()
  if (trimmed !== url || url === '') return undefined
  const forms = [
    /^https:\/\/([A-Za-z0-9.-]+(?::\d+)?)\/(.+)$/,
    /^ssh:\/\/(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+)(?::\d+)?\/(.+)$/,
    /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):(?!\/)(.+)$/,
  ]
  const m = forms.map((re) => re.exec(url)).find((x) => x !== null)
  const host = m?.[1]
  const path = m?.[2]
  if (!host || !path) return undefined
  // https 地址的端口保留在 host 中，与 PR 链接的 host（同样可能带端口）原样比较；ssh 的端口不属于仓库标识。
  const parts = path
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split('/')
  if (parts.length !== 2) return undefined
  const [owner, repo] = parts
  if (!owner || !repo || !SEGMENT.test(owner) || !SEGMENT.test(repo)) return undefined
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return undefined
  return { host: host.toLowerCase(), owner, repo }
}

/** 两个仓库是否为同一个（host、owner、repo 不区分大小写）。 */
export function sameRepo(a: RepoRef, b: RepoRef): boolean {
  const eq = (x: string, y: string) => x.toLowerCase() === y.toLowerCase()
  return eq(a.host, b.host) && eq(a.owner, b.owner) && eq(a.repo, b.repo)
}

/** gh `-R` 参数：`HOST/OWNER/REPO`。 */
export const repoSpec = (r: RepoRef) => `${r.host}/${r.owner}/${r.repo}`

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

export interface GitOptions {
  run?: CommandRunner
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

/** 一条 `-c key=value` 形式的 git 配置覆盖。 */
export type GitConfigPair = readonly [key: string, value: string]

/**
 * 运行 git（不经 shell）。始终带 `-c core.hooksPath=/dev/null`：检出 PR 内容时不运行仓库里的 hook
 * （post-checkout 等会在沙箱外执行）；`config` 中的覆盖依次追加为 `-c key=value`。
 */
export async function git(
  cwd: string,
  args: readonly string[],
  options: GitOptions = {},
  config: readonly GitConfigPair[] = [],
  extraEnv: Record<string, string> = {},
): Promise<Result<string>> {
  const run = options.run ?? execRunner
  const env = { ...(options.env ?? process.env), ...extraEnv }
  let out: CommandOutput
  try {
    out = await run(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        ...config.flatMap(([k, v]) => ['-c', `${k}=${v}`]),
        ...args,
      ],
      { cwd, timeoutMs: options.timeoutMs ?? 120_000, env },
    )
  } catch (err) {
    return fail('failure', 'git_failed', `git ${args[0] ?? ''} 无法执行：${(err as Error).message}`)
  }
  if (out.code !== 0) {
    const detail = (out.stderr || out.stdout).trim().slice(0, 500)
    return fail(
      'failure',
      'git_failed',
      `git ${args.join(' ')} 失败（退出码 ${out.code}）：${detail}`,
      { exitCode: out.code, stdout: out.stdout },
    )
  }
  return ok(out.stdout)
}

/** 检出不可信内容时额外注入的环境：git-lfs 不在检出时下载、不运行 smudge。 */
export const UNTRUSTED_CHECKOUT_ENV = { GIT_LFS_SKIP_SMUDGE: '1' } as const

/**
 * 检出与浏览 PR 内容时，中和由配置驱动、会在沙箱外运行的程序（add-m1-supervisor D10）：
 * - `core.hooksPath=/dev/null`：不运行 hook；`core.fsmonitor=false`：不运行 fsmonitor 钩子；
 * - 仓库与用户配置中已登记的每个 filter driver（`filter.<名>.*`）把 smudge、clean、process 置空并设 `required=false`：
 *   PR 的 `.gitattributes` 引用它们时按原样检出，不执行任何命令；
 * - 每个配置了 `textconv` 或 `command` 的 diff driver（`diff.<名>.*`）把两者置空，并设 `diff.external=`。
 *   实测 git 对空的 textconv / command / external 会尝试运行空命令并报错（`cannot run :`），不会执行任何程序：
 *   这类 diff 失败而不是执行配置里的程序（fail-closed）。
 * 读取配置失败时返回失败（调用方不检出）。
 */
export async function untrustedCheckoutConfig(
  repo: string,
  options: GitOptions = {},
): Promise<Result<GitConfigPair[]>> {
  const pairs: GitConfigPair[] = [
    ['core.hooksPath', '/dev/null'],
    ['core.fsmonitor', 'false'],
    ['diff.external', ''],
  ]
  const listed = await git(repo, ['config', '--null', '--get-regexp', '^(filter|diff)\\.'], options)
  let text = ''
  if (listed.ok) text = listed.data
  else {
    // 没有任何匹配时 git config 以 1 退出且没有输出。
    const d = listed.error.details as { exitCode?: unknown; stdout?: unknown } | undefined
    if (d?.exitCode !== 1 || d.stdout !== '') return listed
  }
  const filters = new Set<string>()
  const diffs = new Set<string>()
  // --null：每项为 "key\nvalue\0"；子节名（driver）可能含点，取首段与末段之间的部分。
  for (const item of text.split('\0')) {
    const key = item.split('\n', 1)[0] ?? ''
    const first = key.indexOf('.')
    const last = key.lastIndexOf('.')
    if (first < 0 || last <= first + 1) continue
    const section = key.slice(0, first).toLowerCase()
    const driver = key.slice(first + 1, last)
    const name = key.slice(last + 1).toLowerCase()
    if (section === 'filter') filters.add(driver)
    else if (section === 'diff' && (name === 'textconv' || name === 'command')) diffs.add(driver)
  }
  for (const d of [...filters].sort()) {
    pairs.push(
      [`filter.${d}.smudge`, ''],
      [`filter.${d}.clean`, ''],
      [`filter.${d}.process`, ''],
      [`filter.${d}.required`, 'false'],
    )
  }
  for (const d of [...diffs].sort())
    pairs.push([`diff.${d}.textconv`, ''], [`diff.${d}.command`, ''])
  return ok(pairs)
}

/**
 * 把配置覆盖写成 `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` 环境变量（接在已有的条目之后），
 * 供审查会话中 Claude Code 自己运行的 git 使用。
 */
export function gitConfigEnv(
  pairs: readonly GitConfigPair[],
  base: NodeJS.ProcessEnv = {},
): Record<string, string> {
  const existing = Number.parseInt(base.GIT_CONFIG_COUNT ?? '0', 10)
  const start = Number.isSafeInteger(existing) && existing > 0 ? existing : 0
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(start + pairs.length) }
  pairs.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${start + i}`] = k
    env[`GIT_CONFIG_VALUE_${start + i}`] = v
  })
  return env
}

/**
 * 登记仓库 origin 的仓库标识：读取配置里的 `remote.origin.url` 原值（不经 insteadOf 改写），
 * 必须恰好一个值且能解析为 host/owner/repo。
 */
export async function originRepo(cwd: string, options: GitOptions = {}): Promise<Result<RepoRef>> {
  const r = await git(cwd, ['config', '--get-all', 'remote.origin.url'], options)
  if (!r.ok)
    return fail(
      'failure',
      'repo_not_in_workspace',
      `读取 ${cwd} 的 origin 失败：${r.error.message}`,
    )
  const values = r.data.split('\n').filter((l) => l !== '')
  if (values.length !== 1 || values[0] === undefined)
    return fail('failure', 'repo_not_in_workspace', `${cwd} 的 origin 应恰好有一个地址`)
  const parsed = parseRemoteUrl(values[0])
  if (!parsed)
    return fail('failure', 'repo_not_in_workspace', `无法从 origin 地址识别仓库：${values[0]}`)
  return ok(parsed)
}

// ---------------------------------------------------------------------------
// gh
// ---------------------------------------------------------------------------

export const ghPrView = z.looseObject({
  number: z.number().int(),
  url: z.string(),
  state: z.string(),
  isDraft: z.boolean(),
  baseRefName: z.string().min(1),
  headRefOid: z.string().min(1),
  mergeable: z.string(),
})
export type GhPrView = z.infer<typeof ghPrView>

export const ghPrMergeState = z.looseObject({
  state: z.string(),
  headRefOid: z.string().min(1),
  mergeCommit: z
    .looseObject({ oid: z.string().min(1) })
    .nullable()
    .optional(),
  autoMergeRequest: z.unknown().nullable().optional(),
})
export type GhPrMergeState = z.infer<typeof ghPrMergeState>

/** 一次 GraphQL 查询中检查项上限；超过（或还有下一页）时无法确认全部检查，调用方判失败。 */
export const SNAPSHOT_CHECKS_MAX = 100

const SNAPSHOT_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    defaultBranchRef { name }
    pullRequest(number: $number) {
      number url state isDraft baseRefName headRefOid mergeable mergeStateStatus
      isMergeQueueEnabled isInMergeQueue
      autoMergeRequest { enabledAt }
      commits(last: 1) {
        nodes {
          commit {
            oid
            statusCheckRollup {
              contexts(first: ${SNAPSHOT_CHECKS_MAX}) {
                totalCount
                pageInfo { hasNextPage }
                nodes {
                  __typename
                  ... on CheckRun {
                    name status conclusion detailsUrl startedAt
                    checkSuite { app { slug } workflowRun { event workflow { name } } }
                  }
                  ... on StatusContext { context state targetUrl createdAt }
                }
              }
            }
          }
        }
      }
    }
  }
}`

const snapshotContext = z.union([
  z.looseObject({
    __typename: z.literal('CheckRun'),
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    detailsUrl: z.string().nullable().optional(),
    startedAt: z.string().nullable().optional(),
    checkSuite: z
      .looseObject({
        app: z.looseObject({ slug: z.string().nullable().optional() }).nullable().optional(),
        workflowRun: z
          .looseObject({
            event: z.string().nullable().optional(),
            workflow: z
              .looseObject({ name: z.string().nullable().optional() })
              .nullable()
              .optional(),
          })
          .nullable()
          .optional(),
      })
      .nullable()
      .optional(),
  }),
  z.looseObject({
    __typename: z.literal('StatusContext'),
    context: z.string(),
    state: z.string(),
    targetUrl: z.string().nullable().optional(),
    createdAt: z.string().nullable().optional(),
  }),
])
type SnapshotContext = z.infer<typeof snapshotContext>

/**
 * rollup 可能包含同一检查的多次运行（重新运行后旧的 check run 仍在，gh CLI 的 `pr checks` 同样去重，见
 * cli/cli `pkg/cmd/pr/checks/aggregate.go` 的 eliminateDuplicates）。按与 gh 相同的键去重——CheckRun 为
 * 名称 + app + workflow + event，StatusContext 为 context——只保留最新的一条（按 startedAt / createdAt）。
 * 与 gh 不同：没有开始时间的运行（排队中的重新运行）视为最新，避免旧的成功结果掩盖进行中的重跑。
 */
export function latestChecks(contexts: readonly SnapshotContext[]): SnapshotContext[] {
  const time = (c: SnapshotContext) => {
    const t = c.__typename === 'CheckRun' ? c.startedAt : c.createdAt
    const ms = t ? Date.parse(t) : Number.NaN
    return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms
  }
  const key = (c: SnapshotContext) =>
    c.__typename === 'CheckRun'
      ? `run\0${c.name}\0${c.checkSuite?.app?.slug ?? ''}\0${c.checkSuite?.workflowRun?.workflow?.name ?? ''}\0${c.checkSuite?.workflowRun?.event ?? ''}`
      : `status\0${c.context}`
  const out = new Map<string, SnapshotContext>()
  for (const c of contexts) {
    const k = key(c)
    const prev = out.get(k)
    if (!prev || time(c) > time(prev)) out.set(k, c)
  }
  return [...out.values()]
}

const snapshotResponse = z.looseObject({
  data: z.looseObject({
    repository: z.looseObject({
      nameWithOwner: z.string().min(1),
      defaultBranchRef: z.looseObject({ name: z.string().min(1) }),
      pullRequest: z.looseObject({
        number: z.number().int(),
        url: z.string(),
        state: z.string(),
        isDraft: z.boolean(),
        baseRefName: z.string().min(1),
        headRefOid: z.string().min(1),
        mergeable: z.string(),
        mergeStateStatus: z.string(),
        isMergeQueueEnabled: z.boolean(),
        isInMergeQueue: z.boolean(),
        autoMergeRequest: z.unknown().nullable(),
        commits: z.looseObject({
          nodes: z.array(
            z.looseObject({
              commit: z.looseObject({
                oid: z.string().min(1),
                statusCheckRollup: z
                  .looseObject({
                    contexts: z.looseObject({
                      totalCount: z.number().int(),
                      pageInfo: z.looseObject({ hasNextPage: z.boolean() }),
                      nodes: z.array(snapshotContext),
                    }),
                  })
                  .nullable(),
              }),
            }),
          ),
        }),
      }),
    }),
  }),
})

/**
 * PR 在同一时刻的状态（一次 GraphQL 查询）：head、可合并性、合并队列、自动合并，以及**该 head 提交**的全部检查。
 * 检查与 head 来自同一次读取，不会出现"读检查之后 head 变了"的错位。
 */
export interface PrSnapshot {
  number: number
  url: string
  state: string
  isDraft: boolean
  baseRefName: string
  headRefOid: string
  mergeable: string
  mergeStateStatus: string
  mergeQueue: boolean
  inMergeQueue: boolean
  autoMerge: boolean
  nameWithOwner: string
  defaultBranch: string
  /** 检查所属提交（最新提交）；没有提交时为 undefined。 */
  checksOid: string | undefined
  checks: GhCheck[]
  /** 检查总数超过一次查询的上限或还有下一页：无法确认全部检查。 */
  checksTruncated: boolean
}

/** CheckRun / StatusContext 归到与 `gh pr checks` 相同的 bucket。 */
function bucketOf(c: SnapshotContext): GhCheck {
  if (c.__typename === 'CheckRun') {
    const bucket =
      c.status !== 'COMPLETED'
        ? 'pending'
        : c.conclusion === 'SUCCESS'
          ? 'pass'
          : c.conclusion === 'SKIPPED' || c.conclusion === 'NEUTRAL'
            ? 'skipping'
            : c.conclusion === 'CANCELLED'
              ? 'cancel'
              : 'fail'
    return {
      name: c.name,
      state: c.status === 'COMPLETED' ? (c.conclusion ?? 'UNKNOWN') : c.status,
      bucket,
      ...(c.detailsUrl ? { link: c.detailsUrl } : {}),
    }
  }
  const bucket =
    c.state === 'SUCCESS'
      ? 'pass'
      : c.state === 'PENDING' || c.state === 'EXPECTED'
        ? 'pending'
        : 'fail'
  return { name: c.context, state: c.state, bucket, ...(c.targetUrl ? { link: c.targetUrl } : {}) }
}

export const ghRepoView = z.looseObject({
  nameWithOwner: z.string().min(1),
  defaultBranchRef: z.looseObject({ name: z.string().min(1) }),
})

export const ghCheck = z.looseObject({
  name: z.string(),
  state: z.string(),
  bucket: z.string(),
  link: z.string().optional(),
})
export type GhCheck = z.infer<typeof ghCheck>

export const ghRun = z.looseObject({
  databaseId: z.number().int(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string(),
  url: z.string(),
  headSha: z.string(),
  event: z.string().optional(),
})
export type GhRun = z.infer<typeof ghRun>

export const MERGE_FLAGS = { squash: '--squash', merge: '--merge', rebase: '--rebase' } as const

export interface GitHubCliOptions {
  bin?: string
  run?: CommandRunner
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

/** 审查准备与 pr-merge 用到的 gh 命令。每个方法都显式指定 PR 链接或仓库。 */
export interface GitHubCli {
  prView(pr: string): Promise<Result<GhPrView>>
  prMergeState(pr: string): Promise<Result<GhPrMergeState>>
  /** 同一时刻的 PR 状态与 head 的全部检查（GraphQL）。 */
  prSnapshot(pr: PrRef): Promise<Result<PrSnapshot>>
  prDiff(pr: string): Promise<Result<string>>
  /** PR 的全部检查；`gh` 报告"没有检查"时返回空数组。 */
  prChecks(pr: string): Promise<Result<GhCheck[]>>
  prMerge(pr: string, method: keyof typeof MERGE_FLAGS, headSha: string): Promise<Result<void>>
  /** 取消可能被 `gh pr merge` 打开的自动合并。 */
  prDisableAuto(pr: string): Promise<Result<void>>
  repoView(repo: RepoRef): Promise<Result<z.infer<typeof ghRepoView>>>
  runList(repo: RepoRef, commit: string, branch: string): Promise<Result<GhRun[]>>
}

/** `gh pr checks` 在 PR 没有任何检查时的提示（gh 2.x：`no checks reported on the '<branch>' branch`）。 */
const NO_CHECKS_RE = /no checks reported/i

export function createGitHubCli(options: GitHubCliOptions = {}): GitHubCli {
  const bin = options.bin ?? 'gh'
  const run = options.run ?? execRunner
  const timeoutMs = options.timeoutMs ?? 60_000

  async function exec(args: string[], what: string): Promise<Result<CommandOutput>> {
    try {
      return ok(await run(bin, args, { timeoutMs, ...(options.env ? { env: options.env } : {}) }))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT')
        return fail('failure', 'gh_not_found', `找不到 gh 可执行文件：${bin}`)
      return fail('failure', 'gh_failed', `gh ${what} 无法执行：${(err as Error).message}`)
    }
  }
  const failed = (out: CommandOutput, what: string) =>
    fail(
      'failure',
      'gh_failed',
      `gh ${what} 失败（退出码 ${out.code}）：${(out.stderr || out.stdout).trim().slice(0, 500)}`,
    )
  function parseJson<T>(text: string, schema: z.ZodType<T>, what: string): Result<T> {
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      return fail('failure', 'gh_bad_output', `gh ${what} 的输出不是 JSON`)
    }
    const parsed = schema.safeParse(json)
    if (!parsed.success)
      return fail('failure', 'gh_bad_output', `gh ${what} 的输出格式不符：${parsed.error.message}`)
    return ok(parsed.data)
  }
  async function json<T>(args: string[], schema: z.ZodType<T>, what: string): Promise<Result<T>> {
    const out = await exec(args, what)
    if (!out.ok) return out
    if (out.data.code !== 0) return failed(out.data, what)
    return parseJson(out.data.stdout, schema, what)
  }

  return {
    prView: (pr) =>
      json(
        ['pr', 'view', pr, '--json', 'number,url,state,isDraft,baseRefName,headRefOid,mergeable'],
        ghPrView,
        'pr view',
      ),
    prMergeState: (pr) =>
      json(
        ['pr', 'view', pr, '--json', 'state,headRefOid,mergeCommit,autoMergeRequest'],
        ghPrMergeState,
        'pr view',
      ),
    async prSnapshot(pr) {
      const r = await json(
        [
          'api',
          'graphql',
          '--hostname',
          pr.host,
          '-f',
          `query=${SNAPSHOT_QUERY}`,
          '-f',
          `owner=${pr.owner}`,
          '-f',
          `name=${pr.repo}`,
          '-F',
          `number=${pr.number}`,
        ],
        snapshotResponse,
        'api graphql（PR 状态）',
      )
      if (!r.ok) return r
      const repo = r.data.data.repository
      const p = repo.pullRequest
      const commit = p.commits.nodes.at(-1)?.commit
      const contexts = commit?.statusCheckRollup?.contexts
      return ok({
        number: p.number,
        url: p.url,
        state: p.state,
        isDraft: p.isDraft,
        baseRefName: p.baseRefName,
        headRefOid: p.headRefOid,
        mergeable: p.mergeable,
        mergeStateStatus: p.mergeStateStatus,
        mergeQueue: p.isMergeQueueEnabled,
        inMergeQueue: p.isInMergeQueue,
        autoMerge: p.autoMergeRequest !== null && p.autoMergeRequest !== undefined,
        nameWithOwner: repo.nameWithOwner,
        defaultBranch: repo.defaultBranchRef.name,
        checksOid: commit?.oid,
        checks: latestChecks(contexts?.nodes ?? []).map(bucketOf),
        checksTruncated:
          contexts !== undefined &&
          (contexts.pageInfo.hasNextPage ||
            contexts.totalCount > contexts.nodes.length ||
            contexts.totalCount > SNAPSHOT_CHECKS_MAX),
      })
    },
    async prDiff(pr) {
      const out = await exec(['pr', 'diff', pr], 'pr diff')
      if (!out.ok) return out
      if (out.data.code !== 0) return failed(out.data, 'pr diff')
      return ok(out.data.stdout)
    },
    async prChecks(pr) {
      const what = 'pr checks'
      const out = await exec(['pr', 'checks', pr, '--json', 'name,state,bucket,link'], what)
      if (!out.ok) return out
      // 有失败或进行中的检查时 gh 以非零退出码结束（8 为进行中），但仍输出 JSON：以输出为准。
      if (out.data.stdout.trim() !== '') return parseJson(out.data.stdout, z.array(ghCheck), what)
      if (out.data.code !== 0 && NO_CHECKS_RE.test(out.data.stderr)) return ok([])
      if (out.data.code !== 0) return failed(out.data, what)
      return fail('failure', 'gh_bad_output', 'gh pr checks 没有输出')
    },
    async prMerge(pr, method, headSha) {
      const out = await exec(
        ['pr', 'merge', pr, MERGE_FLAGS[method], '--match-head-commit', headSha],
        'pr merge',
      )
      if (!out.ok) return out
      return out.data.code === 0 ? ok(undefined) : failed(out.data, 'pr merge')
    },
    async prDisableAuto(pr) {
      const out = await exec(['pr', 'merge', pr, '--disable-auto'], 'pr merge --disable-auto')
      if (!out.ok) return out
      return out.data.code === 0 ? ok(undefined) : failed(out.data, 'pr merge --disable-auto')
    },
    repoView: (repo) =>
      json(
        ['repo', 'view', repoSpec(repo), '--json', 'nameWithOwner,defaultBranchRef'],
        ghRepoView,
        'repo view',
      ),
    runList: (repo, commit, branch) =>
      json(
        [
          'run',
          'list',
          '-R',
          repoSpec(repo),
          '--commit',
          commit,
          '--branch',
          branch,
          '--limit',
          '100',
          '--json',
          'databaseId,name,status,conclusion,url,headSha,event',
        ],
        z.array(ghRun),
        'run list',
      ),
  }
}
