import { posix } from 'node:path'

export interface CommandActionMapping {
  prefix: readonly string[]
  action: string
}

/** 增加映射只需追加前缀；调用方也可传入扩展后的表，多个匹配取并集。 */
export const COMMAND_ACTION_MAPPINGS: readonly CommandActionMapping[] = [
  { prefix: ['git', 'push'], action: 'git.push' },
  { prefix: ['gh', 'pr', 'create'], action: 'pr.create' },
  { prefix: ['gh', 'pr', 'merge'], action: 'pr.merge' },
  { prefix: ['wrangler', 'deploy'], action: 'deploy' },
  { prefix: ['wrangler', 'pages', 'deploy'], action: 'deploy' },
  { prefix: ['flow', 'secrets'], action: 'secrets' },
]

/** 识别不确定时视为可能执行任意敏感动作；与判定端共用同一份保护列表。 */
export const SENSITIVE_ACTIONS = [
  'pr.merge',
  'deploy',
  'secrets',
  'policy.edit',
  'config.edit',
  'shell.opaque',
] as const

/**
 * flow MCP 工具（`mcp__flow__<操作名>`）中会扩大权限或替用户做决定的操作，额外识别为具体动作。
 * 只读和写入边界内的操作（见 claude-sdk 的 FLOW_MCP_AUTO_ALLOWED）不在此列。
 */
export const FLOW_MCP_TOOL_PREFIX = 'mcp__flow__'
export const FLOW_TOOL_ACTIONS: Readonly<Record<string, string>> = {
  task_create: 'task.create',
  task_cancel: 'task.cancel',
  task_reply: 'task.reply',
  kb_proposals_accept: 'proposal.decide',
  kb_proposals_reject: 'proposal.decide',
  resource_transfer: 'resource.transfer',
}

/**
 * 受保护的动作：只有具体 workspace 或角色 scope 加精确 action（不含通配符）的规则才能自动放行。
 * 包括识别不确定时的全部敏感动作，以及 flow MCP 中会扩大权限的操作。
 */
export const GUARDED_ACTIONS: readonly string[] = [
  ...SENSITIVE_ACTIONS,
  ...new Set(Object.values(FLOW_TOOL_ACTIONS)),
]

/**
 * 受保护的工具：Codex 越出沙箱的请求、所有 MCP 工具（含第三方）、外发与派生子 agent。
 * 请求涉及这些工具时，参与判定的每个动作都只有精确 action 的规则才能自动放行，
 * `*`、`tool:*`、`tool:mcp__*` 这类通配规则最多判为 draft-approve。
 */
export const GUARDED_TOOLS: readonly string[] = [
  'tool:CodexCommand',
  'tool:WebFetch',
  'tool:WebSearch',
  'tool:Task',
  'tool:Agent',
]
export const isGuardedTool = (action: string): boolean =>
  GUARDED_TOOLS.includes(action) || action.startsWith('tool:mcp__')

interface ParsedCommands {
  commands: string[][]
  opaque: boolean
}

/** 只做静态分词，不执行 shell；保留引号内的空格和分隔符，支持反斜杠续行。 */
function splitCommands(command: string): ParsedCommands {
  const commands: string[][] = []
  let words: string[] = []
  let word = ''
  let started = false
  let quote = ''
  // 即使出现在引号、注释中也保守处理，避免静态分词遗漏动态执行。
  let opaque = /\$\(|`|[<>]\(/.test(command)
  const flushWord = () => {
    if (started) words.push(word)
    word = ''
    started = false
  }
  const flushCommand = () => {
    flushWord()
    if (words.length) commands.push(words)
    words = []
  }
  for (let i = 0; i < command.length; i++) {
    const char = command[i] as string
    const next = command[i + 1]
    if (char === '\\' && quote !== "'" && next !== undefined) {
      if (next === '\n') i++
      else if (!quote || next === '"' || next === '\\' || next === '$' || next === '`') {
        word += next
        started = true
        i++
      } else word += char
    } else if (quote) {
      if (char === quote) quote = ''
      else word += char
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (char === '#' && !started) {
      while (i < command.length && command[i] !== '\n') i++
      flushCommand()
    } else if (';&|()\n'.includes(char)) flushCommand()
    else if (/\s/.test(char)) flushWord()
    else {
      word += char
      started = true
    }
  }
  if (quote || command.endsWith('\\')) opaque = true
  flushCommand()
  return { commands, opaque }
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
type OptionKind = 'value' | 'flag' | 'optional'
type OptionTable = Readonly<Record<string, OptionKind>>

/** 短选项可连写，带值选项支持分离、短选项紧贴与长选项 =value 三种写法。 */
function options(values: string, flags: string, optional = ''): OptionTable {
  return Object.fromEntries([
    ...values
      .split(' ')
      .filter(Boolean)
      .map((name) => [name, 'value']),
    ...flags
      .split(' ')
      .filter(Boolean)
      .map((name) => [name, 'flag']),
    ...optional
      .split(' ')
      .filter(Boolean)
      .map((name) => [name, 'optional']),
  ])
}

// 选项表只用于定位子命令；未知选项或缺值一律标记 opaque，不能猜测并放行。
const GLOBAL_OPTIONS = new Map<string, OptionTable>(
  Object.entries({
    git: options(
      '-C -c --git-dir --work-tree --namespace --config-env --super-prefix --attr-source',
      '-v --version -h --help -p --paginate -P --no-pager --no-replace-objects --no-lazy-fetch --no-optional-locks --no-advice --bare --html-path --man-path --info-path --no-literal-pathspecs --literal-pathspecs --glob-pathspecs --noglob-pathspecs --icase-pathspecs',
      '--exec-path',
    ),
    gh: options('-R --repo --hostname', '-h --help --version'),
  }),
)
const WRAPPER_OPTIONS = new Map<string, OptionTable>(
  Object.entries({
    sudo: options(
      '-u --user -g --group -h --host -p --prompt -C --close-from -D --chdir -R --chroot -T --command-timeout -r --role -t --type',
      '-A --askpass -b --background -E --preserve-env -H --set-home -K --remove-timestamp -k --reset-timestamp -n --non-interactive -P --preserve-groups -S --stdin -s --shell -i --login -V --version -v --validate -l --list',
    ),
    env: options(
      '-u --unset -C --chdir',
      '-i --ignore-environment -0 --null -v --debug --help --version',
    ),
    command: options('', '-p -v -V'),
    timeout: options(
      '-s --signal -k --kill-after',
      '--foreground --preserve-status -v --verbose --help --version',
    ),
    nice: options('-n --adjustment', '--help --version'),
    nohup: options('', '--help --version'),
    time: options(
      '-f --format -o --output',
      '-a --append -p --portability -v --verbose -q --quiet -l -h --help -V --version',
    ),
    exec: options('-a', '-c -l'),
    stdbuf: options('-i --input -o --output -e --error', '--help --version'),
    xargs: options(
      '-a --arg-file -d --delimiter -E -I -L --max-lines -n --max-args -P --max-procs -s --max-chars --process-slot-var -J -R -S',
      '-0 --null -p --interactive -r --no-run-if-empty -t --verbose -x --exit --show-limits --help --version -o --open-tty',
      '-e --eof -i --replace -l',
    ),
  }),
)

function skipOptions(words: string[], table: OptionTable): { rest: string[]; opaque: boolean } {
  let index = 0
  while (index < words.length) {
    const word = words[index] as string
    if (word === '--') return { rest: words.slice(index + 1), opaque: false }
    if (!word.startsWith('-') || word === '-') break
    index++
    const names = word.startsWith('--')
      ? [word.split('=')[0] as string]
      : [...word.slice(1)].map((char) => `-${char}`)
    for (const [offset, name] of names.entries()) {
      const kind = table[name]
      if (!kind) return { rest: words.slice(index - 1), opaque: true }
      if (kind === 'flag') continue
      const attached = word.startsWith('--') ? word.includes('=') : offset < names.length - 1
      if (!attached && kind === 'value') {
        if (index >= words.length) return { rest: [], opaque: true }
        index++
      }
      break
    }
  }
  return { rest: words.slice(index), opaque: false }
}

/** 消去已知包装前缀与环境变量赋值，执行文件的绝对路径归一为文件名。 */
function unwrapCommand(input: string[]): { words: string[]; opaque: boolean } {
  let words = input
  while (words.length) {
    const word = words[0] as string
    if (ASSIGNMENT.test(word)) {
      words = words.slice(1)
      continue
    }
    const executable = posix.basename(word)
    const wrapper = WRAPPER_OPTIONS.get(executable)
    const global = GLOBAL_OPTIONS.get(executable)
    const table = wrapper ?? global
    if (!table) {
      return { words: [executable, ...words.slice(1)], opaque: /[$*?]/.test(word) }
    }
    words = words.slice(1)
    if (executable === 'nice' && /^-\d+$/.test(words[0] ?? '')) words = words.slice(1)
    const parsed = skipOptions(words, table)
    if (parsed.opaque) return { words: [executable, ...parsed.rest], opaque: true }
    if (global) {
      // gh 的继承选项也可以放在 pr 与 create/merge 之间。
      if (executable === 'gh' && parsed.rest[0] === 'pr') {
        const subcommand = skipOptions(parsed.rest.slice(1), global)
        return { words: [executable, 'pr', ...subcommand.rest], opaque: subcommand.opaque }
      }
      return { words: [executable, ...parsed.rest], opaque: false }
    }
    words = parsed.rest
    if (executable === 'timeout') {
      if (!/^\d+(?:\.\d+)?[smhd]?$/.test(words[0] ?? '')) return { words, opaque: true }
      words = words.slice(1)
    }
  }
  return { words: [], opaque: false }
}

export const commandWords = (command: string): string[][] =>
  splitCommands(command)
    .commands.map((words) => unwrapCommand(words).words)
    .filter((words) => words.length > 0)

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'])
const EVALUATORS = new Set(['eval', 'source', '.'])
const SCRIPT_INTERPRETER = /^(?:python(?:\d+(?:\.\d+)*)?|node(?:js)?|ruby|perl)$/

/** 只递归能直接取出的 shell 字符串；解释器代码始终保持 opaque。 */
function nestedScript(words: string[]): { opaque: boolean; script?: string } {
  const executable = words[0] ?? ''
  if (EVALUATORS.has(executable)) {
    return executable === 'eval'
      ? { opaque: true, script: words.slice(1).join(' ') }
      : { opaque: true }
  }
  if (SHELLS.has(executable)) {
    const index = words.findIndex((word, index) => index > 0 && /^-[^-]*c/.test(word))
    const script = index < 0 ? undefined : words[index + 1]
    return script === undefined ? { opaque: true } : { opaque: true, script }
  }
  return { opaque: SCRIPT_INTERPRETER.test(executable) }
}

export const hasCommandPrefix = (words: readonly string[], prefix: readonly string[]): boolean =>
  prefix.length > 0 && prefix.every((word, index) => words[index] === word)

/** 调用方提供的路径先按词法归一；不读取文件，也不解析符号链接（节点侧负责 realpath）。 */
export const normalizePolicyPath = (path: string): string =>
  posix.normalize(path.replaceAll('\\', '/'))

export interface ActionRequest {
  tool: string
  command?: string
  paths?: readonly string[]
}

export interface ClassifyOptions {
  /** flow-home 的路径（可给多个，例如原路径与 realpath）；其下 `config/` 中的路径识别为 config.edit。 */
  flowHomes?: readonly string[]
}

/** 不区分大小写（APFS 默认不区分大小写）。 */
const POLICY_FILE_RE = /(^|\/)config\/policies\.yaml$/i
/** glob、变量展开、命令替换：命令实际作用的文件无法静态确定。 */
const DYNAMIC_RE = /[*?[]|\$[A-Za-z_{(]|`|[<>]\(/
const CONFIG_HINT_RE = /config|polic/i
/** 非打印字符（换行、回车、制表符之外的控制字符与格式字符）：显示内容与实际执行可能不一致。 */
const UNPRINTABLE_RE = /[\p{Cc}\p{Cf}\u2028\u2029]/u
const unprintable = (text: string) => UNPRINTABLE_RE.test(text.replace(/[\t\n\r]/g, ''))

const lower = (p: string) => normalizePolicyPath(p).replace(/\/+$/, '').toLowerCase()

/** 命令来源由适配器决定；只要提供 command 就识别，兼容 Bash 与 Codex 工具命名。 */
export function classifyAction(
  request: ActionRequest,
  mappings: readonly CommandActionMapping[] = COMMAND_ACTION_MAPPINGS,
  opts: ClassifyOptions = {},
): string[] {
  const actions = new Set([`tool:${request.tool}`])
  const flowAction = request.tool.startsWith(FLOW_MCP_TOOL_PREFIX)
    ? FLOW_TOOL_ACTIONS[request.tool.slice(FLOW_MCP_TOOL_PREFIX.length)]
    : undefined
  if (flowAction) actions.add(flowAction)
  const markOpaque = () => {
    for (const action of SENSITIVE_ACTIONS) actions.add(action)
  }
  const configDirs = (opts.flowHomes ?? []).map((home) => `${lower(home)}/config`)
  const pending = [request.command ?? '']
  const seen = new Set<string>()
  // 用队列代替调用栈递归，重复字符串只分析一次。
  for (let index = 0; index < pending.length; index++) {
    const command = pending[index] as string
    if (seen.has(command)) continue
    seen.add(command)
    const folded = command.toLowerCase()
    if (folded.includes('policies.yaml')) actions.add('policy.edit')
    if (folded.includes('flow-home/config') || configDirs.some((d) => folded.includes(d))) {
      actions.add('config.edit')
    }
    // 动态写法可能拼出策略或配置文件（polic*.yaml、${p}ies.yaml）：按不透明处理。
    if (DYNAMIC_RE.test(command) && CONFIG_HINT_RE.test(command)) markOpaque()
    if (unprintable(command)) markOpaque()
    const parsed = splitCommands(command)
    if (parsed.opaque) markOpaque()
    for (const input of parsed.commands) {
      const { words, opaque } = unwrapCommand(input)
      if (opaque) markOpaque()
      const nested = nestedScript(words)
      if (nested.opaque) markOpaque()
      if (nested.script !== undefined) pending.push(nested.script)
      for (const { prefix, action } of mappings) {
        if (hasCommandPrefix(words, prefix)) actions.add(action)
      }
    }
  }
  for (const path of request.paths ?? []) {
    const p = lower(path)
    if (POLICY_FILE_RE.test(p)) actions.add('policy.edit')
    if (configDirs.some((d) => p === d || p.startsWith(`${d}/`))) actions.add('config.edit')
    // 路径本身带 glob 或变量且指向配置时同样无法确定目标。
    if (DYNAMIC_RE.test(path) && CONFIG_HINT_RE.test(path)) markOpaque()
    if (unprintable(path)) markOpaque()
  }
  return [...actions]
}
