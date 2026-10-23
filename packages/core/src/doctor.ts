import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { execCommand, git, hasCommits, hookPath, isRepoRoot } from './git.ts'
import { type Env, flowPaths, GIT_REPOS } from './home.ts'
import { fail, ok, type Result } from './result.ts'

/** 外部工具的最低版本。gitleaks 8.19.0 起提供 `git --staged` 与 `stdin` 子命令。 */
export const MIN_VERSIONS = { git: '2.28.0', gitleaks: '8.19.0' } as const

const INIT_HINT = '运行 flow init 补齐（已有文件不会被覆盖）'

export const INSTALL_HINTS = {
  git: '安装 git：xcode-select --install 或 brew install git',
  gitleaks:
    '安装 gitleaks：brew install gitleaks（其他平台见 https://github.com/gitleaks/gitleaks#installing）',
} as const

export interface DoctorCheck {
  /** 稳定的检查标识，例如 `tool.gitleaks`、`repo.brain`、`hook.raw`。 */
  id: string
  ok: boolean
  message: string
  /** 失败时的修复提示。 */
  hint?: string
}

export interface DoctorReport {
  home: string
  /** `FLOW_HOME` 或 `default`。 */
  homeSource: 'FLOW_HOME' | 'default'
  ok: boolean
  checks: DoctorCheck[]
}

export interface DoctorOptions {
  /** 用于查找外部工具的环境（主要是 PATH）；测试中注入以模拟缺少工具。 */
  env?: Env
}

/** 在 PATH 中查找可执行文件，返回绝对路径。 */
export function findExecutable(name: string, env: Env = process.env): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const p = join(dir, name)
    try {
      if (statSync(p).isFile()) {
        accessSync(p, constants.X_OK)
        return p
      }
    } catch {}
  }
  return null
}

/** 比较 `a.b.c` 版本号：a<b 返回负数。 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

const extractVersion = (text: string): string | null =>
  /(\d+\.\d+(?:\.\d+)?)/.exec(text)?.[1] ?? null

async function checkTool(
  name: keyof typeof MIN_VERSIONS,
  args: string[],
  env: Env,
): Promise<{ check: DoctorCheck; bin: string | null }> {
  const id = `tool.${name}`
  const bin = findExecutable(name, env)
  if (!bin) {
    return {
      bin,
      check: { id, ok: false, message: `未找到 ${name}`, hint: INSTALL_HINTS[name] },
    }
  }
  const r = await execCommand(bin, args, { env })
  const version = extractVersion(r.stdout || r.stderr)
  const min = MIN_VERSIONS[name]
  if (!version || compareVersions(version, min) < 0) {
    return {
      bin,
      check: {
        id,
        ok: false,
        message: `${name} 版本 ${version ?? '未知'} 低于最低要求 ${min}`,
        hint: INSTALL_HINTS[name],
      },
    }
  }
  return { bin, check: { id, ok: true, message: `${name} ${version}（${bin}）` } }
}

/**
 * 检查 flow-home 与外部依赖（flow-home spec：状态检查）。
 * 任何一项未通过时返回 `doctor_failed` 失败，details 中带完整报告。
 */
export async function runDoctor(
  home: string,
  homeSource: DoctorReport['homeSource'],
  opts: DoctorOptions = {},
): Promise<Result<DoctorReport>> {
  const env = opts.env ?? process.env
  const paths = flowPaths(home)
  const checks: DoctorCheck[] = []

  const gitTool = await checkTool('git', ['--version'], env)
  const gitleaksTool = await checkTool('gitleaks', ['version'], env)
  checks.push(gitTool.check, gitleaksTool.check)
  const gitOpts = { env, bin: gitTool.bin ?? 'git' }

  checks.push(
    existsSync(home)
      ? { id: 'home', ok: true, message: `flow-home：${home}` }
      : { id: 'home', ok: false, message: `flow-home 不存在：${home}`, hint: INIT_HINT },
  )

  for (const sub of ['config', 'brain', 'raw', 'state'] as const) {
    const exists = existsSync(paths[sub])
    checks.push(
      exists
        ? { id: `dir.${sub}`, ok: true, message: `${sub}/ 存在` }
        : { id: `dir.${sub}`, ok: false, message: `缺少 ${sub}/`, hint: INIT_HINT },
    )
  }

  for (const repo of GIT_REPOS) {
    const dir = paths[repo]
    if (!existsSync(dir)) continue
    if (!isRepoRoot(dir) || !gitTool.bin) {
      checks.push({
        id: `repo.${repo}`,
        ok: false,
        message: `${repo}/ 不是 git 仓库${gitTool.bin ? '' : '（无法检查：缺少 git）'}`,
        hint: gitTool.bin ? INIT_HINT : INSTALL_HINTS.git,
      })
      continue
    }
    const committed = await hasCommits(dir, gitOpts)
    checks.push(
      committed
        ? { id: `repo.${repo}`, ok: true, message: `${repo}/ 是 git 仓库` }
        : { id: `repo.${repo}`, ok: false, message: `${repo}/ 还没有任何提交`, hint: INIT_HINT },
    )
    const toml = existsSync(join(dir, '.gitleaks.toml'))
    checks.push(
      toml
        ? { id: `gitleaks-config.${repo}`, ok: true, message: `${repo}/.gitleaks.toml 存在` }
        : {
            id: `gitleaks-config.${repo}`,
            ok: false,
            message: `缺少 ${repo}/.gitleaks.toml`,
            hint: INIT_HINT,
          },
    )
    checks.push(await checkHook(repo, dir, gitOpts))
  }

  if (existsSync(paths.state) && gitTool.bin) {
    const r = await git(paths.state, ['rev-parse', '--is-inside-work-tree'], gitOpts)
    const inGit = r.code === 0 && r.stdout.trim() === 'true'
    checks.push(
      inGit
        ? {
            id: 'state.untracked',
            ok: false,
            message: 'state/ 位于某个 git 仓库内，但它不应被纳入版本管理',
            hint: '把 flow-home 移出任何 git 仓库，或删除包含 state/ 的仓库',
          }
        : { id: 'state.untracked', ok: true, message: 'state/ 不在 git 中' },
    )
  }

  for (const [name, p] of [
    ['AGENTS.md', paths.brainAgents],
    ['index.md', paths.brainIndex],
    ['log.md', paths.brainLog],
  ] as const) {
    if (!existsSync(paths.brain)) break
    checks.push(
      existsSync(p)
        ? { id: `brain.${name}`, ok: true, message: `brain/${name} 存在` }
        : { id: `brain.${name}`, ok: false, message: `缺少 brain/${name}`, hint: INIT_HINT },
    )
  }

  const report: DoctorReport = { home, homeSource, ok: checks.every((c) => c.ok), checks }
  if (!report.ok) return fail('failure', 'doctor_failed', formatDoctorReport(report), report)
  return ok(report)
}

async function checkHook(
  repo: string,
  dir: string,
  gitOpts: { env: Env; bin: string },
): Promise<DoctorCheck> {
  const id = `hook.${repo}`
  const p = (await hookPath(dir, 'pre-commit', gitOpts)) ?? join(dir, '.git', 'hooks', 'pre-commit')
  if (!existsSync(p)) {
    return {
      id,
      ok: false,
      message: `${repo}/ 没有安装提交前密钥扫描钩子（${p}）`,
      hint: INIT_HINT,
    }
  }
  try {
    accessSync(p, constants.X_OK)
  } catch {
    return {
      id,
      ok: false,
      message: `${repo}/ 的提交前钩子不可执行（${p}）`,
      hint: `chmod +x ${p}`,
    }
  }
  const content = readFileSync(p, 'utf8')
  if (!content.includes('gitleaks')) {
    return {
      id,
      ok: false,
      message: `${repo}/ 的提交前钩子没有调用 gitleaks（${p}）`,
      hint: '在钩子中加入：gitleaks git --pre-commit --staged --redact --verbose .',
    }
  }
  return { id, ok: true, message: `${repo}/ 已安装提交前密钥扫描钩子` }
}

export function formatDoctorReport(r: DoctorReport): string {
  const lines = [
    `flow-home：${r.home}（来源：${r.homeSource === 'FLOW_HOME' ? 'FLOW_HOME' : '默认'}）`,
  ]
  for (const c of r.checks) {
    lines.push(`${c.ok ? '[ok]  ' : '[fail]'} ${c.message}`)
    if (!c.ok && c.hint) lines.push(`       修复：${c.hint}`)
  }
  lines.push(r.ok ? '全部检查通过' : `${r.checks.filter((c) => !c.ok).length} 项未通过`)
  return lines.join('\n')
}
