import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CommandOutput, CommandRunner } from '../src/codex-orca/orca.ts'

/**
 * 本地临时 git 仓库（D15 推送与 gh 环境检查的测试用）：
 * - 独立的 HOME / XDG_CONFIG_HOME，`GIT_CONFIG_NOSYSTEM=1`，不读写用户真实的 git 配置；
 * - `origin` 只是一个地址（不联网），`refs/remotes/origin/HEAD` 指向 `origin/main`；
 * - 另建一个 worktree（分支 `ustclhx/t-1`），模拟 codex-orca 的 Orca worktree；
 * - gh 是假的：`gh repo view --json nameWithOwner` 返回 `ghRepo`（为 undefined 时失败）。
 */
export interface GitFixture {
  root: string
  repo: string
  worktree: string
  env: NodeJS.ProcessEnv
  git(args: string[], cwd?: string): string
  run: CommandRunner
  gh: { repo: string | undefined; calls: number }
  cleanup(): void
}

export const ORIGIN_URL = 'https://github.com/acme/demo.git'
export const TASK_BRANCH = 'ustclhx/t-1'

export function gitFixture(): GitFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'flow-git-env-')))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, '.gitconfig'),
    '[user]\n\tname = Flow Test\n\temail = flow@example.com\n[init]\n\tdefaultBranch = main\n[credential]\n\thelper = cache\n',
  )
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    XDG_CONFIG_HOME: join(root, 'xdg'),
    GIT_CONFIG_NOSYSTEM: '1',
    LANG: 'C',
  }
  const repo = join(root, 'repo')
  const worktree = join(root, 'wt')
  const git = (args: string[], cwd = repo) =>
    execFileSync('git', args, { cwd, env, encoding: 'utf8' })
  mkdirSync(repo)
  git(['init', '-q'])
  writeFileSync(join(repo, 'README.md'), '# demo\n')
  git(['add', 'README.md'])
  git(['commit', '-q', '-m', 'init'])
  git(['remote', 'add', 'origin', ORIGIN_URL])
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD'])
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  git(['worktree', 'add', '-q', '-b', TASK_BRANCH, worktree])
  const gh = { repo: 'acme/demo' as string | undefined, calls: 0 }
  const run: CommandRunner = (bin, args, options) => {
    if (bin === 'gh') {
      gh.calls++
      if (args.join(' ') !== 'repo view --json nameWithOwner' || gh.repo === undefined) {
        return Promise.resolve({ code: 1, stdout: '', stderr: 'gh: 失败' })
      }
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify({ nameWithOwner: gh.repo }),
        stderr: '',
      })
    }
    return new Promise<CommandOutput>((resolve, reject) => {
      execFile(
        bin,
        [...args],
        // 被测代码传入的环境优先（安全 git 会固定 GIT_DIR 等）；没有时用夹具的隔离环境。
        { cwd: options.cwd, env: options.env ?? env, timeout: options.timeoutMs, encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return reject(err)
          const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
          resolve({ code, stdout: String(stdout), stderr: String(stderr) })
        },
      )
    })
  }
  return {
    root,
    repo,
    worktree,
    env,
    git,
    run,
    gh,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}
