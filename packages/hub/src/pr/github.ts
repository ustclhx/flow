import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  fail,
  type GithubConfig,
  git,
  ok,
  parseRemoteUrl,
  type RepoRef,
  type Result,
} from '@raindown/core'

/**
 * pr-watcher 访问 GitHub 的唯一出口（harness-neutral D11；tasks 8.3）。
 *
 * 安全约束（公开仓库的评论是攻击者可控输入）：
 * - 只做只读的 `gh api --method GET <path>`，用中枢所在机器的 gh 登录；
 * - `path` 只由本模块的构造函数拼出：仓库 owner/repo 取自 workspace 登记仓库的 origin，
 *   PR 编号取自订阅的 PR 链接，`since` 取自中枢自己的游标，head sha 取自 GitHub 返回并校验格式。
 *   **任何评论内容都不会成为 gh 的参数**；执行前再按白名单正则校验一次，不符合即拒绝；
 * - 用 execFile 直接传 argv，不经 shell；去掉 GH_REPO / GH_HOST 等能改写目标的环境变量。
 */

/** 只读 GitHub API 查询：返回解析后的 JSON。测试注入假实现，绝不调用真实 gh。 */
export type GhApi = (path: string) => Promise<Result<unknown>>

const SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/
const SHA = /^[0-9a-f]{40}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/

/**
 * 允许交给 gh 的路径：`user`（中枢 gh 登录）、`users/<login>`、`repos/<owner>/<repo>/(pulls|issues)/<n>[/<资源>]`
 * 或 `repos/<owner>/<repo>/commits/<sha>/check-runs`，查询串只含 per_page、page、since 与固定的排序参数。
 */
const SAFE_PATH =
  /^(?:user|users\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})|repos\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/(?:(?:pulls|issues)\/[1-9]\d{0,9}(?:\/(?:comments|reviews))?|issues\/comments|commits\/[0-9a-f]{40}\/check-runs)(?:\?per_page=100&page=[1-9]\d?(?:&sort=updated&direction=asc)?(?:&since=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?)?)$/

export const isSafeApiPath = (path: string): boolean => SAFE_PATH.test(path) && !path.includes('..')

function repoPrefix(repo: RepoRef): string {
  if (repo.host !== 'github.com' || !SEGMENT.test(repo.owner) || !SEGMENT.test(repo.repo)) {
    throw new Error('仓库不是合法的 github.com 仓库')
  }
  if ([repo.owner, repo.repo].some((s) => s === '.' || s === '..')) {
    throw new Error('仓库不是合法的 github.com 仓库')
  }
  return `repos/${repo.owner}/${repo.repo}`
}

function checkNumber(n: number) {
  if (!Number.isSafeInteger(n) || n < 1 || n > 9_999_999_999) throw new Error('PR 编号不合法')
}

const page = (p: number, since?: string, sorted = false) => {
  if (!Number.isInteger(p) || p < 1 || p > 99) throw new Error('页码不合法')
  if (since !== undefined && !ISO.test(since)) throw new Error('since 不合法')
  return `?per_page=100&page=${p}${sorted ? '&sort=updated&direction=asc' : ''}${since === undefined ? '' : `&since=${since}`}`
}

/** gh api 路径构造（参数全部来自登记信息、中枢配置与中枢游标）。 */
export const githubPaths = {
  self() {
    return 'user'
  },
  user(login: string) {
    if (!LOGIN.test(login)) throw new Error('GitHub 用户名不合法')
    return `users/${login}`
  },
  pull(repo: RepoRef, n: number) {
    checkNumber(n)
    return `${repoPrefix(repo)}/pulls/${n}`
  },
  /**
   * PR 对话评论：用仓库级端点按 updated 升序读取（单个 issue 的端点不支持排序），由调用方按 `issue_url`
   * 过滤出本 PR；截断时可以安全提交已取到的前缀，下一轮从那里继续。
   */
  issueComments(repo: RepoRef, p: number, since?: string) {
    return `${repoPrefix(repo)}/issues/comments${page(p, since, true)}`
  },
  /** 代码行评论：按 updated 升序，截断时游标只推进到已取到的部分。 */
  reviewComments(repo: RepoRef, n: number, p: number, since?: string) {
    checkNumber(n)
    return `${repoPrefix(repo)}/pulls/${n}/comments${page(p, since, true)}`
  },
  reviews(repo: RepoRef, n: number, p: number) {
    checkNumber(n)
    return `${repoPrefix(repo)}/pulls/${n}/reviews${page(p)}`
  },
  checkRuns(repo: RepoRef, sha: string, p: number) {
    if (!SHA.test(sha)) throw new Error('head sha 不合法')
    return `${repoPrefix(repo)}/commits/${sha}/check-runs${page(p)}`
  },
}

/** gh 执行器（可注入，测试用来核对 argv）。 */
export type ExecFileLike = (
  file: string,
  args: readonly string[],
  opts: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
  done: (error: Error | null, stdout: string) => void,
) => void

const defaultExec: ExecFileLike = (file, args, opts, done) => {
  execFile(file, [...args], opts, (error, stdout) => done(error, String(stdout)))
}

/** 真实的 gh 查询：路径不在白名单时直接拒绝，不启动进程。 */
export function createGhApi(exec: ExecFileLike = defaultExec): GhApi {
  return (path) =>
    new Promise((resolve) => {
      if (!isSafeApiPath(path)) {
        resolve(fail('usage', 'unsafe_gh_path', 'gh api 路径不在允许范围内'))
        return
      }
      const env = { ...process.env }
      // 目标仓库与主机只取自路径（github.com），不继承能改写目标的环境变量。
      delete env.GH_REPO
      delete env.GH_HOST
      delete env.GH_ENTERPRISE_TOKEN
      delete env.GITHUB_ENTERPRISE_TOKEN
      exec(
        'gh',
        ['api', '--method', 'GET', '-H', 'Accept: application/vnd.github+json', path],
        { env, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            resolve(fail('retryable', 'gh_query_failed', 'gh api 查询失败'))
            return
          }
          try {
            resolve(ok(JSON.parse(stdout) as unknown))
          } catch {
            resolve(fail('retryable', 'gh_query_failed', 'gh api 返回了无效 JSON'))
          }
        },
      )
    })
}

/** 读取登记仓库 origin 地址；读不到时为 undefined。测试注入假实现。 */
export type RepoOriginLookup = (repoPath: string) => Promise<string | undefined>

export function expandHome(path: string, home: () => string = homedir): string {
  return path === '~' ? home() : path.startsWith('~/') ? join(home(), path.slice(2)) : path
}

export const gitOriginLookup: RepoOriginLookup = async (repoPath) => {
  const r = await git(expandHome(repoPath), ['remote', 'get-url', 'origin'])
  const url = r.stdout.trim()
  return r.code === 0 && url ? url : undefined
}

/**
 * workspace 登记仓库中 origin 在 github.com 上的仓库（去重），以及读不出 origin 的仓库数。
 * 有仓库读不出来时，调用方不能据"没有匹配"断定 PR 不在登记仓库（按可重试失败处理）。
 */
export async function registeredGithubRepos(
  repos: readonly string[],
  origin: RepoOriginLookup,
): Promise<{ repos: RepoRef[]; unresolved: number }> {
  const out: RepoRef[] = []
  let unresolved = 0
  for (const path of repos) {
    const url = await origin(path).catch(() => undefined)
    if (!url) {
      unresolved++
      continue
    }
    const ref = parseRemoteUrl(url)
    if (ref?.host !== 'github.com') continue
    if (
      !out.some(
        (r) =>
          r.owner.toLowerCase() === ref.owner.toLowerCase() &&
          r.repo.toLowerCase() === ref.repo.toLowerCase(),
      )
    )
      out.push(ref)
  }
  return { repos: out, unresolved }
}

/**
 * 某个 PR 的有效允许名单（登录名，小写）：配置了 `allowed_users` 时就是它（可以为空）；
 * 否则只有该 PR 所属登记仓库的 owner，且调用方须确认 owner 是个人账号（组织账号不作默认）。
 */
export function allowedLogins(
  github: Pick<GithubConfig, 'allowed_users'>,
  owner: string | undefined,
): string[] {
  return (github.allowed_users ?? (owner ? [owner] : [])).map((n) => n.toLowerCase())
}
