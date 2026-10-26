import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fail, ok, type Result } from '@flow/core'
import type { GhCheck, GhPrView, GhRun, GitHubCli, RepoRef } from '../src/index.ts'

/**
 * 审查准备与 pr-merge 测试共用：本地临时仓库（绝不访问真实远端）与注入的假 gh（绝不调用真实 gh）。
 *
 * 仓库布局：`origin.git`（裸仓库，带 `refs/pull/7/head`）、`repo`（登记仓库）。`remote.origin.url` 配成
 * `https://github.com/acme/demo.git`（执行器据此识别仓库），再用仓库本地的 `url.<裸仓库>.insteadOf`
 * 让 fetch 实际取自本地裸仓库。
 */

export const PR_URL = 'https://github.com/acme/demo/pull/7'
export const ORIGIN_URL = 'https://github.com/acme/demo.git'
export const REPO: RepoRef = { host: 'github.com', owner: 'acme', repo: 'demo' }

export const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Flow Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Flow Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
}

export const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    env: gitEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()

export interface TempRepo {
  root: string
  home: string
  repo: string
  bare: string
  /** refs/pull/7/head 指向的提交。 */
  head: string
  /** main 的提交。 */
  base: string
  /** 在 PR 上再推一个提交，返回新的 head。 */
  pushToPr(): string
}

/** 临时 flow-home（workspace ws/demo 登记 repo）与本地仓库。 */
export function tempRepo(workspaceExtra = ''): TempRepo {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'flow-gh-')))
  const home = join(root, 'home')
  const repo = join(root, 'repo')
  const bare = join(root, 'origin.git')
  mkdirSync(join(home, 'config', 'workspaces'), { recursive: true })
  mkdirSync(join(home, 'state'), { recursive: true })
  writeFileSync(
    join(home, 'config', 'workspaces', 'demo.yaml'),
    `id: demo\nname: Demo\ndescription: 测试\nkind: product\nrepos:\n  - ${repo}\n${workspaceExtra}`,
  )
  mkdirSync(repo)
  sh(root, 'init', '-q', '--bare', '-b', 'main', bare)
  sh(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'README.md'), '主干\n')
  sh(repo, 'add', '.')
  sh(repo, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'base')
  const base = sh(repo, 'rev-parse', 'HEAD')
  sh(repo, 'remote', 'add', 'origin', ORIGIN_URL)
  sh(repo, 'config', `url.${bare}.insteadOf`, ORIGIN_URL)
  sh(repo, 'push', '-q', 'origin', 'main')
  // PR 分支：一个改动加上 .github 下的 CI 配置，推到 refs/pull/7/head；登记仓库的工作区留在 main。
  sh(repo, 'checkout', '-q', '-b', 'feature')
  mkdirSync(join(repo, '.github', 'workflows'), { recursive: true })
  writeFileSync(join(repo, '.github', 'workflows', 'ci.yml'), 'on: push\n')
  writeFileSync(join(repo, 'feature.ts'), 'export const x = 1\n')
  sh(repo, 'add', '.')
  sh(repo, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'feature')
  const head = sh(repo, 'rev-parse', 'HEAD')
  sh(repo, 'push', '-q', 'origin', 'HEAD:refs/pull/7/head')
  sh(repo, 'checkout', '-q', 'main')
  const pushToPr = () => {
    sh(repo, 'checkout', '-q', 'feature')
    writeFileSync(join(repo, 'feature.ts'), 'export const x = 2\n')
    sh(repo, '-c', 'commit.gpgsign=false', 'commit', '-q', '-am', 'more')
    const next = sh(repo, 'rev-parse', 'HEAD')
    sh(repo, 'push', '-q', '-f', 'origin', 'HEAD:refs/pull/7/head')
    sh(repo, 'checkout', '-q', 'main')
    return next
  }
  return { root, home, repo, bare, head, base, pushToPr }
}

export interface FakeGhState {
  pr: GhPrView
  diff: string
  checks: GhCheck[] | 'none' | 'error'
  defaultBranch: string
  nameWithOwner: string
  /** 合并的行为：merge 成功并给出合并提交；auto 只打开自动合并；error 报错且不合并。 */
  mergeBehavior: 'merge' | 'auto' | 'error' | 'error_but_merged'
  mergeCommit: string
  /** 第 n 次 run list 返回的结果（超过时重复最后一项）。 */
  runs: Array<GhRun[] | 'error'>
  calls: string[]
  merged: boolean
  autoEnabled: boolean
}

export function fakeGh(over: Partial<FakeGhState> = {}): { gh: GitHubCli; state: FakeGhState } {
  const state: FakeGhState = {
    pr: {
      number: 7,
      url: PR_URL,
      state: 'OPEN',
      isDraft: false,
      baseRefName: 'main',
      headRefOid: 'a'.repeat(40),
      mergeable: 'MERGEABLE',
    },
    diff: 'diff --git a/feature.ts b/feature.ts\n+export const x = 1\n',
    checks: [{ name: 'ci', state: 'SUCCESS', bucket: 'pass', link: 'https://ci/1' }],
    defaultBranch: 'main',
    nameWithOwner: 'acme/demo',
    mergeBehavior: 'merge',
    mergeCommit: 'c'.repeat(40),
    runs: [[]],
    calls: [],
    merged: false,
    autoEnabled: false,
    ...over,
  }
  let runCalls = 0
  const gh: GitHubCli = {
    async prView(pr) {
      state.calls.push(`pr view ${pr}`)
      return ok({ ...state.pr, state: state.merged ? 'MERGED' : state.pr.state })
    },
    async prMergeState(pr) {
      state.calls.push(`pr view state ${pr}`)
      return ok(
        state.merged
          ? { state: 'MERGED', mergeCommit: { oid: state.mergeCommit } }
          : { state: state.pr.state, mergeCommit: null },
      )
    },
    async prDiff(pr) {
      state.calls.push(`pr diff ${pr}`)
      return ok(state.diff)
    },
    async prChecks(pr): Promise<Result<GhCheck[]>> {
      state.calls.push(`pr checks ${pr}`)
      if (state.checks === 'none') return ok([])
      if (state.checks === 'error') return fail('failure', 'gh_failed', 'gh pr checks 失败')
      return ok(state.checks)
    },
    async prMerge(pr, method, sha) {
      state.calls.push(`pr merge ${pr} ${method} ${sha}`)
      if (sha !== state.pr.headRefOid)
        return fail('failure', 'gh_failed', 'Head branch was modified')
      switch (state.mergeBehavior) {
        case 'merge':
          state.merged = true
          return ok(undefined)
        case 'auto':
          state.autoEnabled = true
          return ok(undefined)
        case 'error':
          return fail('failure', 'gh_failed', 'merge failed')
        case 'error_but_merged':
          state.merged = true
          return fail('failure', 'gh_failed', 'timeout')
      }
    },
    async prDisableAuto(pr) {
      state.calls.push(`pr disable-auto ${pr}`)
      state.autoEnabled = false
      return ok(undefined)
    },
    async repoView(repo) {
      state.calls.push(`repo view ${repo.host}/${repo.owner}/${repo.repo}`)
      return ok({
        nameWithOwner: state.nameWithOwner,
        defaultBranchRef: { name: state.defaultBranch },
      })
    },
    async runList(repo, commit, branch) {
      state.calls.push(`run list ${repo.owner}/${repo.repo} ${commit} ${branch}`)
      const r = state.runs[Math.min(runCalls++, state.runs.length - 1)] ?? []
      if (r === 'error') return fail('failure', 'gh_failed', 'run list 失败')
      return ok(r)
    },
  }
  return { gh, state }
}

export const run = (over: Partial<GhRun> = {}): GhRun => ({
  databaseId: 1,
  name: 'deploy',
  status: 'completed',
  conclusion: 'success',
  url: 'https://github.com/acme/demo/actions/runs/1',
  headSha: 'c'.repeat(40),
  event: 'push',
  ...over,
})
