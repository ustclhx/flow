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
  'shell.opaque',
] as const

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

/** 调用方提供的路径先按词法归一；不读取文件，也不解析符号链接。 */
export const normalizePolicyPath = (path: string): string =>
  posix.normalize(path.replaceAll('\\', '/'))

export interface ActionRequest {
  tool: string
  command?: string
  paths?: readonly string[]
}

/** 命令来源由适配器决定；只要提供 command 就识别，兼容 Bash 与 Codex 工具命名。 */
export function classifyAction(
  request: ActionRequest,
  mappings: readonly CommandActionMapping[] = COMMAND_ACTION_MAPPINGS,
): string[] {
  const actions = new Set([`tool:${request.tool}`])
  const pending = [request.command ?? '']
  const seen = new Set<string>()
  const markOpaque = () => {
    for (const action of SENSITIVE_ACTIONS) actions.add(action)
  }
  // 用队列代替调用栈递归，重复字符串只分析一次。
  for (let index = 0; index < pending.length; index++) {
    const command = pending[index] as string
    if (seen.has(command)) continue
    seen.add(command)
    if (command.includes('policies.yaml')) actions.add('policy.edit')
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
  if (
    request.paths?.some((path) => /(^|\/)config\/policies\.yaml$/.test(normalizePolicyPath(path)))
  ) {
    actions.add('policy.edit')
  }
  return [...actions]
}
