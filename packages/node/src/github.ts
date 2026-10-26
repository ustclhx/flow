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

/**
 * 运行 git（不经 shell）。始终带 `-c core.hooksPath=/dev/null`：检出 PR 内容时不运行仓库里的 hook
 * （post-checkout 等会在沙箱外执行）。
 */
export async function git(
  cwd: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<Result<string>> {
  const run = options.run ?? execRunner
  let out: CommandOutput
  try {
    out = await run('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      timeoutMs: options.timeoutMs ?? 120_000,
      ...(options.env ? { env: options.env } : {}),
    })
  } catch (err) {
    return fail('failure', 'git_failed', `git ${args[0] ?? ''} 无法执行：${(err as Error).message}`)
  }
  if (out.code !== 0) {
    const detail = (out.stderr || out.stdout).trim().slice(0, 500)
    return fail(
      'failure',
      'git_failed',
      `git ${args.join(' ')} 失败（退出码 ${out.code}）：${detail}`,
    )
  }
  return ok(out.stdout)
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
  mergeCommit: z
    .looseObject({ oid: z.string().min(1) })
    .nullable()
    .optional(),
})

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
  prMergeState(pr: string): Promise<Result<z.infer<typeof ghPrMergeState>>>
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
      json(['pr', 'view', pr, '--json', 'state,mergeCommit'], ghPrMergeState, 'pr view'),
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
