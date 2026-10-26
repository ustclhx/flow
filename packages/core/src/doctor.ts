import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { z } from 'zod'
import { checkDaemonPlists, launchAgentsDirectory } from './daemon/plist.ts'
import { type DoctorSdk, inspectClaudeSdk } from './doctor-sdk.ts'
import type { execCommand } from './git.ts'
import { isRepoRoot } from './git.ts'
import { type Env, flowPaths, GIT_REPOS } from './home.ts'
import { fail, ok, type Result } from './result.ts'
import {
  CLAUDE_READ_REQUIRED_DISALLOWED,
  CLAUDE_SDK_KNOWN_PERMISSION_KEYS,
  CODEX_EXEC_KNOWN_PERMISSION_KEYS,
  CODEX_EXEC_READ_SAFE_CONFIG_KEYS,
  canCreateRole,
  effectiveRoleKind,
  findSupervisorRole,
  inferRoleKind,
  KNOWN_EXECUTORS,
  loadRoles,
  type Role,
  SUPERVISOR_ACTOR,
} from './roles.ts'

/** gitleaks 需 staged/stdin；Codex 需 exec --json/resume；Codex、Orca 下限取已验证的 fixture 版本。 */
export const MIN_VERSIONS = {
  git: '2.28.0',
  gitleaks: '8.19.0',
  codex: '0.164.0',
  orca: '1.4.218',
} as const

const INIT_HINT = '运行 flow init 补齐（已有文件不会被覆盖）'

export const INSTALL_HINTS = {
  codex: '安装或更新 Codex CLI，并确保 codex 在节点的 PATH 中',
  orca: '安装或更新 Orca，并确保 orca 在节点的 PATH 中；运行 Orca 应用后重试',
  git: '安装 git：xcode-select --install 或 brew install git',
  gitleaks:
    '安装 gitleaks：brew install gitleaks（其他平台见 https://github.com/gitleaks/gitleaks#installing）',
} as const

export interface DoctorCheck {
  /** 稳定的检查标识，例如 `tool.gitleaks`、`repo.brain`、`hook.raw`。 */
  id: string
  ok: boolean
  /** info / warning 不影响退出码；旧检查省略时，失败按 error、成功按 info。 */
  severity?: 'error' | 'warning' | 'info'
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
  /** 测试必须注入临时目录，避免读取真实的 LaunchAgents。 */
  launchAgentsDir?: string
  /** 用于查找外部工具的环境（主要是 PATH）；测试中注入以模拟缺少工具。 */
  env?: Env
  /** 所有外部命令（包括 git）；缺省 argv 执行，10 秒超时、最多 1MB 输出。 */
  runCommand?: typeof execCommand
  findExecutable?: typeof findExecutable
  /** 测试注入模拟 SDK，绝不加载或运行真实 Claude。 */
  inspectClaudeSdk?: () => Promise<DoctorSdk | null>
  /** 凭证只检查文件是否存在；测试必须注入临时用户目录。 */
  userHome?: string
  platform?: NodeJS.Platform
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

const doctorCommand: typeof execCommand = (bin, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(
      bin,
      args,
      { ...opts, timeout: 10_000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr })
      },
    )
  })

async function checkTool(
  name: keyof typeof MIN_VERSIONS,
  args: string[],
  env: Env,
  run: typeof execCommand,
  find: typeof findExecutable,
  roles?: string[],
): Promise<{ check: DoctorCheck; bin: string | null }> {
  const id = `tool.${name}`
  if (roles?.length === 0) {
    return {
      bin: null,
      check: { id, ok: false, severity: 'info', message: `${name} 没有角色引用，跳过检查` },
    }
  }
  const bin = find(name, env)
  const suffix = roles ? `（角色：${roles.join('、')}）` : ''
  if (!bin) {
    return {
      bin,
      check: {
        id,
        ok: false,
        severity: 'error',
        message: `未找到 ${name}${suffix}`,
        hint: INSTALL_HINTS[name],
      },
    }
  }
  const r = await run(bin, args, { env })
  const version = extractVersion(`${r.stdout}\n${r.stderr}`)
  const min = MIN_VERSIONS[name]
  if (r.code !== 0 || !version || compareVersions(version, min) < 0) {
    return {
      bin,
      check: {
        id,
        ok: false,
        severity: r.code === 0 && version && roles ? 'warning' : 'error',
        message: `${name}${r.code !== 0 ? ' 版本命令失败' : !version ? ' 版本无法解析' : ` 版本 ${version} 低于最低要求 ${min}`}${suffix}`,
        hint: INSTALL_HINTS[name],
      },
    }
  }
  return { bin, check: { id, ok: true, message: `${name} ${version}（${bin}）${suffix}` } }
}

const orcaTerminals = z.object({
  ok: z.literal(true),
  result: z.object({ terminals: z.array(z.object({})) }),
})

async function checkExecutors(
  roles: Role[],
  env: Env,
  opts: DoctorOptions,
  run: typeof execCommand,
  find: typeof findExecutable,
): Promise<DoctorCheck[]> {
  const users = (...executors: string[]) =>
    roles.filter((r) => executors.includes(r.executor)).map((r) => r.name)
  const codex = await checkTool(
    'codex',
    ['--version'],
    env,
    run,
    find,
    users('codex-orca', 'codex-exec'),
  )
  const orcaRoles = users('codex-orca')
  const orca = await checkTool('orca', ['--version'], env, run, find, orcaRoles)
  const checks = [codex.check, orca.check]
  const dependency = (
    id: string,
    available: boolean,
    message: string,
    usedBy: string[],
    hint?: string,
  ): DoctorCheck => ({
    id,
    ok: available,
    severity: !available && usedBy.length > 0 ? 'error' : 'info',
    message: `${message}（${usedBy.length ? `角色：${usedBy.join('、')}` : '没有角色引用'}）`,
    ...(!available && hint ? { hint } : {}),
  })
  if (orca.bin) {
    const r = await run(orca.bin, ['terminal', 'list', '--json'], { env })
    let available = false
    try {
      available = r.code === 0 && orcaTerminals.safeParse(JSON.parse(r.stdout)).success
    } catch {
      // 非 JSON / 不合法信封按不可用报告，不把终端内容或命令输出带进报告。
    }
    checks.push(
      dependency(
        'orca.app',
        available,
        available ? 'Orca 应用可连接' : '无法连接 Orca 应用或 terminal list 返回无效 JSON',
        orcaRoles,
        '启动 Orca 应用后重试 orca terminal list --json；若仍失败，检查 CLI 与应用版本是否匹配',
      ),
    )
  }

  const claudeRoles = users('claude-sdk')
  if (claudeRoles.length === 0) {
    checks.push(dependency('tool.claude-sdk', false, 'Claude Agent SDK 跳过检查', claudeRoles))
    return checks
  }
  let sdk: DoctorSdk | undefined
  try {
    sdk = (await (opts.inspectClaudeSdk ?? inspectClaudeSdk)()) ?? undefined
    checks.push(
      dependency(
        'tool.claude-sdk',
        Boolean(sdk),
        sdk
          ? `Claude Agent SDK ${sdk.version} 可 import（node 声明：${sdk.expectedVersion}）`
          : 'Claude Agent SDK 未安装（无法从 @flow/node 解析）',
        claudeRoles,
        '在 Flow 仓库运行 bun install --frozen-lockfile，安装 @flow/node 声明的 SDK',
      ),
    )
  } catch {
    checks.push(
      dependency(
        'tool.claude-sdk',
        false,
        'Claude Agent SDK 无法 import 或包版本无法解析',
        claudeRoles,
        '在 Flow 仓库运行 bun install --frozen-lockfile，确保 @anthropic-ai/claude-agent-sdk 安装完整',
      ),
    )
  }
  const claude = find('claude', env)
  checks.push(
    dependency(
      'tool.claude',
      Boolean(sdk?.cliPath),
      sdk?.cliPath
        ? `SDK 原生 claude CLI 存在：${sdk.cliPath}`
        : `SDK 原生 claude CLI 缺失${claude ? `（PATH 有 ${claude}，SDK 不自动使用它）` : '；PATH 也未找到 claude'}`,
      claudeRoles,
      '重新安装 SDK 的当前平台可选依赖（不要使用 --omit=optional）；doctor 不执行 claude',
    ),
  )

  const userHome = opts.userHome ?? env.HOME ?? homedir()
  const configDir = env.CLAUDE_CONFIG_DIR ?? join(userHome, '.claude')
  const credentialEnv = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
  ].some((key) => Boolean(env[key]))
  const credentialFile = existsSync(join(configDir, '.credentials.json'))
  const auth = dependency(
    'claude.credentials',
    credentialEnv || credentialFile,
    credentialEnv || credentialFile
      ? 'Claude 凭证来源存在（未验证有效性）'
      : '未发现 Claude 凭证环境变量或 .credentials.json',
    claudeRoles,
    '在节点运行环境配置 Claude 登录或凭证；仅检测存在性，不读取内容、不发起 API 调用',
  )
  // macOS 登录也可能只保存在 Keychain，无法仅通过文件存在性断定未登录。
  if (!auth.ok && (opts.platform ?? process.platform) === 'darwin' && find('security', env)) {
    auth.severity = 'warning'
    auth.message += '；macOS Keychain 登录状态未检查，请人工确认'
  }
  checks.push(auth)
  return checks
}

/**
 * 检查 flow-home 与外部依赖（flow-home spec：状态检查）。
 * 有 error 未通过时返回 `doctor_failed` 失败，details 中带完整报告。
 */
export async function runDoctor(
  home: string,
  homeSource: DoctorReport['homeSource'],
  opts: DoctorOptions = {},
): Promise<Result<DoctorReport>> {
  const env = opts.env ?? process.env
  const run = opts.runCommand ?? doctorCommand
  const find = opts.findExecutable ?? findExecutable
  const paths = flowPaths(home)
  const checks: DoctorCheck[] = []

  const gitTool = await checkTool('git', ['--version'], env, run, find)
  const gitleaksTool = await checkTool('gitleaks', ['version'], env, run, find)
  checks.push(gitTool.check, gitleaksTool.check)
  const gitRun = (cwd: string, args: string[]) => run(gitTool.bin ?? 'git', args, { env, cwd })

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
    const committed = (await gitRun(dir, ['rev-parse', '--verify', '-q', 'HEAD'])).code === 0
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
    checks.push(await checkHook(repo, dir, gitRun))
  }

  if (existsSync(paths.state) && gitTool.bin) {
    const r = await gitRun(paths.state, ['rev-parse', '--is-inside-work-tree'])
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

  const roles = await loadRoles(home)
  if (!roles.ok) {
    checks.push({ id: 'roles.config', ok: false, message: roles.error.message })
  } else {
    for (const error of roles.data.errors) {
      checks.push({
        id: `roles.config.${error.file}.${error.field ?? ''}`,
        ok: false,
        message: `${error.file}${error.field ? `：${error.field}` : ''}：${error.message}`,
        hint: '修正角色配置后重新运行 flow doctor',
      })
    }
    for (const role of roles.data.roles) {
      const known = (KNOWN_EXECUTORS as readonly string[]).includes(role.executor)
      checks.push({
        id: `role.${role.name}.executor`,
        ok: known,
        message: `config/roles/${role.name}.yaml：executor ${role.executor}${known ? '' : ' 不存在'}`,
        ...(known ? {} : { hint: `将 executor 改为 ${KNOWN_EXECUTORS.join('、')} 之一` }),
      })
      // supervisor 与 merge 类别的任务由中枢按类别限定创建者（hub / user），不看 creatable_by。
      const byKind = ['supervisor', 'merge'].includes(effectiveRoleKind(role))
      if (!role.creatable_by?.length && !byKind) {
        checks.push({
          id: `role.${role.name}.creatable_by`,
          ok: false,
          severity: 'info',
          message: `config/roles/${role.name}.yaml：creatable_by 缺省或为空，仅 user 可创建该角色的任务`,
          hint: '需要允许本机 AI 身份创建时，加上 creatable_by（例如 ["*"] 或 ["reviewer"]）；见 docs/executors.md',
        })
      }
    }
    checks.push(...checkRoleKinds(roles.data.roles))
  }

  checks.push(...(await checkExecutors(roles.ok ? roles.data.roles : [], env, opts, run, find)))

  for (const plist of checkDaemonPlists(opts.launchAgentsDir ?? launchAgentsDirectory())) {
    if (!plist.installed) continue
    checks.push({
      id: `daemon.${plist.label}`,
      ok: !plist.error && plist.bunExists && plist.cliExists,
      message:
        plist.error ??
        `${plist.label}：bun ${plist.bunExists ? '有效' : '失效'}（${plist.bunPath}），入口 ${plist.cliExists ? '有效' : '失效'}（${plist.cliPath}）`,
      hint: '重新运行 flow daemon install 更新 plist 中的路径',
    })
  }

  const normalized: DoctorCheck[] = checks.map((c) => ({
    ...c,
    severity: c.severity ?? (c.ok ? 'info' : 'error'),
  }))
  const report: DoctorReport = {
    home,
    homeSource,
    ok: normalized.every((c) => c.ok || c.severity !== 'error'),
    checks: normalized,
  }
  if (!report.ok) return fail('failure', 'doctor_failed', formatDoctorReport(report), report)
  return ok(report)
}

/** 可直接复制进已有 dev.yaml 的片段（design D14：升级用户）。 */
export const DEV_CREATABLE_BY_SNIPPET = `creatable_by:\n  - ${SUPERVISOR_ACTOR}`

/** claude-sdk 角色推断为 read 所需的权限片段（design D9），放在 permissions 下。 */
export const CLAUDE_READ_ONLY_SNIPPET = [
  'permissions:',
  '  setting_sources: []',
  '  disallowedTools:',
  ...CLAUDE_READ_REQUIRED_DISALLOWED.map((t) => `    - ${t}`),
].join('\n')

const codexExecReadHint = `permissions 中写 sandbox: read-only（或不写，缺省即只读）；config 只允许 ${CODEX_EXEC_READ_SAFE_CONFIG_KEYS.join('、')}，其他键（如 notify、mcp_servers.*）一律删除；permissions 不要有 ${CODEX_EXEC_KNOWN_PERMISSION_KEYS.join('、')} 以外的键`

const claudeReadHint = `不设 writable_paths、permissions 只含 ${CLAUDE_SDK_KNOWN_PERMISSION_KEYS.join('、')}、不允许写工具与 Bash 规则，并确保 permissions 包含（已有列表时合并）：\n${CLAUDE_READ_ONLY_SNIPPET}`

/** 角色有效类别（design D9）、supervisor 唯一且只读、dev 的 creatable_by 升级提示。 */
function checkRoleKinds(roles: Role[]): DoctorCheck[] {
  const checks: DoctorCheck[] = []
  for (const role of roles) {
    const inferred = inferRoleKind(role)
    const effective = effectiveRoleKind(role)
    const file = `config/roles/${role.name}.yaml`
    const loosened = role.kind !== undefined && role.kind !== effective
    checks.push({
      id: `role.${role.name}.kind`,
      ok: !loosened,
      severity: loosened ? 'warning' : 'info',
      message: loosened
        ? `${file}：声明 kind: ${role.kind} 比按配置推断的 ${inferred} 宽松，声明只能收紧，有效类别为 ${effective}`
        : `${file}：有效类别 ${effective}（推断 ${inferred}${role.kind ? `，声明 ${role.kind}` : ''}）`,
      ...(loosened
        ? {
            hint:
              role.executor === 'claude-sdk' && role.kind === 'read'
                ? claudeReadHint
                : role.executor === 'codex-exec' && role.kind === 'read'
                  ? codexExecReadHint
                  : `删除 kind 或改为 ${effective}；要降低类别，请收紧执行器权限配置`,
          }
        : {}),
    })
  }
  const supervisor = findSupervisorRole(roles)
  if (!supervisor.ok) {
    const writable = supervisor.error.code === 'supervisor_role_writable'
    checks.push({
      id: 'roles.supervisor',
      ok: false,
      severity: 'error',
      message: `${supervisor.error.message}；中枢不会唤醒 supervisor`,
      hint: writable
        ? `supervisor 只应有 Read、Grep、Glob 与 Flow MCP（参考 flow init 生成的 supervisor.yaml）；${claudeReadHint}`
        : '只保留一个 kind: supervisor 角色',
    })
    if (!writable) return checks
  }
  const hasSupervisor = roles.some((r) => effectiveRoleKind(r) === 'supervisor')
  const dev = roles.find((r) => r.name === 'dev')
  if (hasSupervisor && dev && !canCreateRole(dev, SUPERVISOR_ACTOR)) {
    checks.push({
      id: 'role.dev.supervisor',
      ok: false,
      severity: 'warning',
      message:
        'config/roles/dev.yaml：creatable_by 不包含 supervisor，supervisor 无法创建 dev 任务',
      hint: `在 dev.yaml 中加入（已有 creatable_by 时把 supervisor 追加到列表）：\n${DEV_CREATABLE_BY_SNIPPET}`,
    })
  }
  return checks
}

async function checkHook(
  repo: string,
  dir: string,
  gitRun: (cwd: string, args: string[]) => ReturnType<typeof execCommand>,
): Promise<DoctorCheck> {
  const id = `hook.${repo}`
  const r = await gitRun(dir, ['rev-parse', '--git-path', 'hooks/pre-commit'])
  const path = r.stdout.trim()
  const p =
    r.code === 0
      ? path.startsWith('/')
        ? path
        : join(dir, path)
      : join(dir, '.git', 'hooks', 'pre-commit')
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
    const tag = c.ok
      ? '[ok]  '
      : c.severity === 'warning'
        ? '[warn]'
        : c.severity === 'info'
          ? '[info]'
          : '[fail]'
    lines.push(`${tag} ${c.message}`)
    // 多行提示（例如可复制的 yaml 片段）的后续行与首行对齐。
    if (!c.ok && c.hint) lines.push(`       修复：${c.hint.split('\n').join('\n         ')}`)
  }
  const errors = r.checks.filter((c) => !c.ok && (c.severity ?? 'error') === 'error').length
  const warnings = r.checks.filter((c) => !c.ok && c.severity === 'warning').length
  lines.push(
    `${r.ok ? '全部检查通过' : `${errors} 项未通过`}${warnings ? `（${warnings} 项警告）` : ''}`,
  )
  return lines.join('\n')
}
