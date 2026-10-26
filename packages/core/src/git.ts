import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fail, ok, type Result } from './result.ts'

/**
 * git 命令行的薄封装（design D6：调用 git CLI，让提交前钩子自然生效）。
 * 只用 `node:child_process`，保持 Node 兼容（design D12）。
 */

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export interface ExecOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  /** 写入子进程 stdin 的内容。 */
  input?: string
}

/** 运行任意外部命令并收集输出；命令不存在时 code 为 127。 */
export function execCommand(
  bin: string,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: (opts.env ?? process.env) as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      stdout += d
    })
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      stderr += d
    })
    child.on('error', (err: NodeJS.ErrnoException) => {
      resolve({ code: err.code === 'ENOENT' ? 127 : 1, stdout, stderr: stderr || err.message })
    })
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
    child.stdin.on('error', () => {})
    child.stdin.end(opts.input ?? '')
  })
}

export interface GitOptions extends ExecOptions {
  /** git 可执行文件，默认 `git`。 */
  bin?: string
}

/** 在 `cwd` 下运行 `git <args>`。 */
export function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<ExecResult> {
  return execCommand(opts.bin ?? 'git', args, { ...opts, cwd })
}

export interface GitAuthor {
  name: string
  email: string
}

/** Flow 提交的作者：`Flow (<actor>) <flow@localhost>`（design D6）。 */
export const flowAuthor = (actor: string): GitAuthor => ({
  name: `Flow (${actor})`,
  email: 'flow@localhost',
})

/** 以 `-c` 传入身份，不修改任何全局或仓库配置；关闭签名，避免自动提交被交互打断。 */
const identityArgs = (author: GitAuthor): string[] => [
  '-c',
  `user.name=${author.name}`,
  '-c',
  `user.email=${author.email}`,
  '-c',
  'commit.gpgsign=false',
]

/** `dir` 本身是否是一个 git 仓库的根（存在 `.git`）。 */
export const isRepoRoot = (dir: string): boolean => existsSync(join(dir, '.git'))

export async function gitInit(dir: string, opts: GitOptions = {}): Promise<Result<void>> {
  const r = await git(dir, ['init', '-q', '-b', 'main'], opts)
  return r.code === 0
    ? ok(undefined)
    : fail('failure', 'git_failed', `git init 失败：${r.stderr.trim()}`)
}

/** 仓库是否已有提交。任何 git 失败都按"没有提交"处理；需要区分出错时用 `headState`。 */
export async function hasCommits(dir: string, opts: GitOptions = {}): Promise<boolean> {
  const r = await git(dir, ['rev-parse', '--verify', '-q', 'HEAD'], opts)
  return r.code === 0
}

/**
 * HEAD 的状态：`present` 有提交；`unborn` HEAD 指向一个还不存在的分支（新仓库，尚无提交）；
 * `error` 其他任何情况（不是仓库、HEAD 损坏、git 无法运行……），调用方应当报错而不是当作空仓库。
 */
export async function headState(
  dir: string,
  opts: GitOptions = {},
): Promise<'present' | 'unborn' | 'error'> {
  // `^{commit}`：要求对象确实存在且是提交，而不只是引用里写着一个 sha。
  const r = await git(dir, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], opts)
  if (r.code === 0) return 'present'
  // `-q` 下引用不存在时退出码为 1 且无输出；不是仓库等错误为 128。
  if (r.code !== 1) return 'error'
  const ref = await git(dir, ['symbolic-ref', '-q', 'HEAD'], opts)
  const name = ref.stdout.trim()
  if (ref.code !== 0 || !name.startsWith('refs/heads/')) return 'error'
  // 分支引用确实不存在才是 unborn；引用存在却解析不出提交说明仓库损坏。
  const shown = await git(dir, ['show-ref', '--verify', '-q', name], opts)
  return shown.code === 1 ? 'unborn' : 'error'
}

/** 当前生效的 pre-commit 钩子路径（考虑 `core.hooksPath`）。 */
export async function hookPath(
  dir: string,
  hook: string,
  opts: GitOptions = {},
): Promise<string | null> {
  const r = await git(dir, ['rev-parse', '--git-path', `hooks/${hook}`], opts)
  if (r.code !== 0) return null
  const p = r.stdout.trim()
  return p.startsWith('/') ? p : join(dir, p)
}

export interface CommitOptions extends GitOptions {
  message: string
  author: GitAuthor
  /** 只提交这些路径（相对仓库根）；省略时提交已暂存的全部内容。 */
  paths?: string[]
  allowEmpty?: boolean
  /** 跳过提交前钩子；只用于内容完全来自 Flow 模板的提交。 */
  noVerify?: boolean
}

/** 暂存并提交；成功时返回新提交的 sha。 */
export async function gitCommit(
  dir: string,
  opts: CommitOptions,
): Promise<Result<{ sha: string }>> {
  const { message, author, paths, allowEmpty, noVerify, ...exec } = opts
  if (paths && paths.length > 0) {
    const add = await git(dir, ['add', '--', ...paths], exec)
    if (add.code !== 0) return fail('failure', 'git_failed', `git add 失败：${add.stderr.trim()}`)
  }
  const args = [...identityArgs(author), 'commit', '-q', '-m', message]
  if (allowEmpty) args.push('--allow-empty')
  if (noVerify) args.push('--no-verify')
  if (paths && paths.length > 0) args.push('--', ...paths)
  const r = await git(dir, args, exec)
  if (r.code !== 0) {
    return fail('failure', 'git_commit_failed', `git commit 失败：${(r.stderr || r.stdout).trim()}`)
  }
  const head = await git(dir, ['rev-parse', 'HEAD'], exec)
  return ok({ sha: head.stdout.trim() })
}
