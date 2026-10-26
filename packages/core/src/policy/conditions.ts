import { posix } from 'node:path'
import { splitCommands } from './actions.ts'

/**
 * 规则条件 `when.push_to: task_branch` 与 `when.gh_scope: workspace_repo` 的判定（design D15）。
 *
 * 这两个条件会让 supervisor 代为批准越出沙箱的推送与 gh 调用，属于安全关键逻辑：
 * 全部是纯函数，**任何不确定都视为不满足**（返回 `{ ok: false, reason }`），宁可交给用户也不误放行。
 * 采用白名单：只接受明确列出的写法，未知选项、shell 元字符、引号等一律不满足。
 */
export type ConditionResult = { ok: true } | { ok: false; reason: string }

const no = (reason: string): { ok: false; reason: string } => ({ ok: false, reason })
const YES: ConditionResult = { ok: true }

export interface PushTarget {
  remote: string
  /** refspec 的来源 ref（无冒号时与 dst 相同）。 */
  src: string
  /** 推送的目标分支名（已去掉 `refs/heads/` 前缀）。 */
  dst: string
}
export type PushTargetResult = ({ ok: true } & PushTarget) | { ok: false; reason: string }

/**
 * 推送命令的字符白名单：不允许引号、反斜杠、`$`、glob、重定向、`~`、串联与注释等任何 shell 元字符，
 * 也不允许非 ASCII 与控制字符。分支名与 remote 名用不到这些字符，出现即视为不确定。
 */
const PUSH_COMMAND_CHARS = /^[A-Za-z0-9 ._/:@=+-]+$/
/** 允许的 `git push` 选项（精确匹配，不接受短选项连写）。 */
const PUSH_ALLOWED_OPTIONS: ReadonlySet<string> = new Set([
  '-u',
  '--set-upstream',
  '-q',
  '--quiet',
  '-v',
  '--verbose',
  '--progress',
  '--no-progress',
])
/** 明确禁止的选项（仅用于给出更具体的原因；白名单之外的选项本来就不满足）。 */
const PUSH_FORBIDDEN_OPTION_RE =
  /^(?:--all|--branches|--mirror|--tags|--follow-tags|--prune|--delete|-d|--receive-pack|--exec|-o|--push-option|-f|--force.*|--repo|--signed|--recurse-submodules)(?:=.*)?$/
/** remote 名：不能是 URL 或路径（含 `/`、`:`，或以 `.`、`-` 开头）。 */
const REMOTE_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/

/** 保守的分支名检查（git check-ref-format 的子集），并排除 `HEAD` 与 `@` 写法。 */
export function isPlainBranchName(name: string): boolean {
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) return false
  if (name === 'HEAD' || name.startsWith('-') || name.startsWith('/') || name.endsWith('/')) {
    return false
  }
  if (name.includes('..') || name.includes('//') || name.endsWith('.lock') || name.endsWith('.')) {
    return false
  }
  return name.split('/').every((segment) => segment.length > 0 && !segment.startsWith('.'))
}

const stripHeads = (ref: string) => (ref.startsWith('refs/heads/') ? ref.slice(11) : ref)

/**
 * 解析推送命令。只接受：整条命令只有一段、就是 `git push`（`git` 不带路径、之前没有环境变量赋值或
 * 包装命令、`git` 与 `push` 之间没有全局选项）、只带白名单选项、恰好一个 remote 名加一个显式 refspec；
 * refspec 不以 `+` 或 `:` 开头，来源与目标都是普通分支名（`HEAD`、`@`、`^`、`~` 视为不确定）。
 */
export function parsePushTarget(command: string): PushTargetResult {
  if (!PUSH_COMMAND_CHARS.test(command)) return no('unsafe_characters')
  const parsed = splitCommands(command)
  if (parsed.opaque) return no('opaque')
  if (parsed.commands.length !== 1) return no('not_single_command')
  const words = parsed.commands[0] as string[]
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? '')) return no('env_prefix')
  if (words[0] !== 'git') return no('not_git_push')
  if (words[1] !== 'push') {
    return (words[1] ?? '').startsWith('-') ? no('git_global_option') : no('not_git_push')
  }
  const positional: string[] = []
  for (const word of words.slice(2)) {
    if (word.startsWith('-')) {
      if (PUSH_FORBIDDEN_OPTION_RE.test(word)) return no('forbidden_option')
      if (!PUSH_ALLOWED_OPTIONS.has(word)) return no('unknown_option')
      continue
    }
    positional.push(word)
  }
  if (positional.length < 2) return no('missing_refspec')
  if (positional.length > 2) return no('multiple_refspecs')
  const [remote, refspec] = positional as [string, string]
  if (!REMOTE_NAME_RE.test(remote)) return no('remote_not_name')
  if (refspec.startsWith('+')) return no('force_refspec')
  if (refspec.startsWith(':')) return no('delete_refspec')
  const parts = refspec.split(':')
  if (parts.length > 2) return no('invalid_refspec')
  const src = parts[0] as string
  const dst = stripHeads(parts[1] ?? src)
  if (src === 'HEAD' || dst === 'HEAD' || src.includes('@') || dst.includes('@')) {
    return no('head_refspec')
  }
  if (!isPlainBranchName(src) || !isPlainBranchName(dst)) return no('invalid_refspec')
  // 无冒号时目标由来源推出；来源若写成 refs/heads/x，目标同为 x。
  return { ok: true, remote, src, dst }
}

export interface PushToInput {
  command: string
  /** 登记仓库中可接受的 remote 名（如 `origin`）。 */
  remotes: readonly string[]
  /** 执行器上报的任务分支（`task.branch_reported`）；缺失即不满足。 */
  taskBranch?: string | undefined
  /** 仓库默认分支；缺失即不满足（无法确认任务分支不是默认分支）。 */
  defaultBranch?: string | undefined
  /** 节点随请求上报的推送环境检查结果；只有严格的 `true` 才满足。 */
  pushEnvOk?: boolean | undefined
}

/** `when.push_to: task_branch`：全部满足才满足。 */
export function pushToTaskBranch(input: PushToInput): ConditionResult {
  if (input.pushEnvOk !== true) return no('push_env_unverified')
  const taskBranch = input.taskBranch
  if (taskBranch === undefined || !isPlainBranchName(taskBranch)) return no('no_task_branch')
  const defaultBranch = input.defaultBranch
  if (defaultBranch === undefined || defaultBranch.trim() === '') return no('no_default_branch')
  if (stripHeads(taskBranch) === stripHeads(defaultBranch)) return no('task_branch_is_default')
  const target = parsePushTarget(input.command)
  if (!target.ok) return target
  if (!input.remotes.includes(target.remote)) return no('remote_not_registered')
  if (target.dst !== taskBranch) return no('not_task_branch')
  return YES
}

// ---------------------------------------------------------------------------
// gh_scope
// ---------------------------------------------------------------------------

/** 不可打印字符（换行、回车、制表符之外的控制字符与格式字符）。 */
const UNPRINTABLE_RE = /[\p{Cc}\p{Cf}\u2028\u2029]/u

/**
 * 检查 shell 会解释的元字符：引号外的 `$ \` \\ < > { } * ? [ ] ~ ; & | ( ) #` 与换行，双引号内的
 * `$ \` \\`，以及未闭合的引号。出现任何一个都视为不确定（变量展开、glob、重定向、串联、后台执行……）。
 * 单引号内的内容按字面处理。
 */
export function hasShellHazard(command: string): boolean {
  if (UNPRINTABLE_RE.test(command.replace(/[\t\n\r]/g, ''))) return true
  let quote = ''
  for (const char of command) {
    if (quote === "'") {
      if (char === "'") quote = ''
    } else if (quote === '"') {
      if (char === '"') quote = ''
      else if ('$`\\'.includes(char)) return true
    } else if (char === "'" || char === '"') quote = char
    else if ('$`\\<>{}*?[]~;&|()#\n\r'.includes(char)) return true
  }
  return quote !== ''
}

type GhOptionKind = 'value' | 'flag'
const ghOptions = (values: string, flags: string): ReadonlyMap<string, GhOptionKind> =>
  new Map<string, GhOptionKind>([
    ...values.split(' ').map((name): [string, GhOptionKind] => [name, 'value']),
    ...flags.split(' ').map((name): [string, GhOptionKind] => [name, 'flag']),
  ])

/**
 * 允许的子命令与选项（白名单）。没有列出的选项（`-R/--repo`、`--recover`、`--web`、`--editor` 等）
 * 一律不满足。短选项只接受单独写法，带值选项接受分离写法与长选项 `=value`。
 */
const GH_PR_SUBCOMMANDS: Readonly<Record<string, ReadonlyMap<string, GhOptionKind>>> = {
  create: ghOptions(
    '-t --title -b --body -F --body-file -B --base -H --head -a --assignee -l --label -m --milestone -p --project -r --reviewer -T --template',
    '-d --draft -f --fill --fill-first --fill-verbose --no-maintainer-edit --dry-run',
  ),
  view: ghOptions('--json -q --jq -t --template', '-c --comments'),
  diff: ghOptions('--color', '--name-only --patch'),
}
/** view / diff 的位置参数：PR 编号或分支名；不接受 URL（可能指向其他仓库）。 */
const GH_PR_SELECTOR_RE = /^(?:[1-9][0-9]*|[A-Za-z0-9._/-]+)$/

export interface GhScopeInput {
  command: string
  /** 节点上报：gh 实际解析出的仓库就是本 workspace 登记仓库；只有严格的 `true` 才满足。 */
  ghEnvOk?: boolean | undefined
  /** 任务工作目录的绝对路径（`--body-file` 只能指向其中）。 */
  cwd?: string | undefined
  /** 解析符号链接；路径不存在时应抛错。未提供时带 `--body-file` 的请求不满足。 */
  realpath?: ((path: string) => string) | undefined
}

const within = (root: string, path: string) =>
  path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)

function bodyFileInsideCwd(value: string, input: GhScopeInput): ConditionResult {
  const { cwd, realpath } = input
  if (value === '' || value === '-' || value.startsWith('~')) return no('body_file_outside_cwd')
  if (!cwd || !posix.isAbsolute(cwd) || !realpath) return no('body_file_unverifiable')
  try {
    const root = realpath(cwd)
    const target = realpath(posix.resolve(cwd, value))
    return within(root, target) ? YES : no('body_file_outside_cwd')
  } catch {
    return no('body_file_unverifiable')
  }
}

/**
 * `when.gh_scope: workspace_repo`：整条命令只有一段 `gh pr create|view|diff`（`gh` 不带路径、之前没有
 * 环境变量赋值或包装命令、`gh` 与 `pr` 之间没有选项）、没有 shell 元字符、只带白名单选项且不带
 * `-R/--repo`；`--head` 不指向其他 owner；view / diff 的选择参数不是 URL；`--body-file/-F` 解析符号
 * 链接后位于 cwd 内；节点上报 `gh_env_ok` 为真。
 */
export function ghScopeWorkspaceRepo(input: GhScopeInput): ConditionResult {
  if (input.ghEnvOk !== true) return no('gh_env_unverified')
  if (hasShellHazard(input.command)) return no('unsafe_characters')
  const parsed = splitCommands(input.command)
  if (parsed.opaque) return no('opaque')
  if (parsed.commands.length !== 1) return no('not_single_command')
  const words = parsed.commands[0] as string[]
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? '')) return no('env_prefix')
  if (words[0] !== 'gh') return no('not_gh_pr')
  if (words[1] !== 'pr') return (words[1] ?? '').startsWith('-') ? no('repo_flag') : no('not_gh_pr')
  const subcommand = words[2] ?? ''
  const table = Object.hasOwn(GH_PR_SUBCOMMANDS, subcommand)
    ? GH_PR_SUBCOMMANDS[subcommand]
    : undefined
  if (!table) return no('not_gh_pr')
  const positional: string[] = []
  const args = words.slice(3)
  for (let index = 0; index < args.length; index++) {
    const word = args[index] as string
    if (!word.startsWith('-') || word === '-') {
      positional.push(word)
      continue
    }
    if (word === '--') return no('unknown_option')
    const name = word.startsWith('--') ? (word.split('=')[0] as string) : word
    if (name === '-R' || name.startsWith('-R') || name === '--repo') return no('repo_flag')
    const kind = table.get(name)
    if (!kind) return no('unknown_option')
    const attached = word.startsWith('--') && word.includes('=')
    if (kind === 'flag') {
      if (attached) return no('unknown_option')
      continue
    }
    let value: string
    if (attached) value = word.slice(name.length + 1)
    else {
      if (index + 1 >= args.length) return no('missing_value')
      index++
      value = args[index] as string
    }
    if ((name === '-H' || name === '--head') && value.includes(':')) return no('foreign_head')
    if (name === '-F' || name === '--body-file') {
      const inside = bodyFileInsideCwd(value, input)
      if (!inside.ok) return inside
    }
  }
  if (subcommand === 'create') {
    if (positional.length > 0) return no('unexpected_argument')
  } else {
    if (positional.length > 1) return no('unexpected_argument')
    const selector = positional[0]
    if (selector !== undefined && (!GH_PR_SELECTOR_RE.test(selector) || selector.includes('..'))) {
      return no('foreign_selector')
    }
  }
  return YES
}
