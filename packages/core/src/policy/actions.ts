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

/** 只做静态分词，不执行 shell；保留引号内的空格和分隔符，支持反斜杠续行。 */
function splitCommands(command: string): string[][] {
  const commands: string[][] = []
  let words: string[] = []
  let word = ''
  let started = false
  let quote = ''
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
  flushCommand()
  return commands
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const SUDO_VALUE_OPTIONS = new Set([
  '-u',
  '--user',
  '-g',
  '--group',
  '-h',
  '--host',
  '-p',
  '--prompt',
  '-C',
  '--chdir',
  '-D',
  '-R',
  '--chroot',
  '-T',
  '--command-timeout',
])
const ENV_VALUE_OPTIONS = new Set(['-u', '--unset', '-C', '--chdir'])

/** 消去已知包装前缀与环境变量赋值，执行文件的绝对路径归一为文件名。 */
function unwrapCommand(words: string[]): string[] {
  let offset = 0
  while (offset < words.length) {
    const word = words[offset] as string
    if (ASSIGNMENT.test(word)) {
      offset++
      continue
    }
    const executable = posix.basename(word)
    if (!['sudo', 'env', 'command'].includes(executable)) {
      return [executable, ...words.slice(offset + 1)]
    }
    offset++
    const valueOptions = executable === 'sudo' ? SUDO_VALUE_OPTIONS : ENV_VALUE_OPTIONS
    while (words[offset]?.startsWith('-')) {
      const option = words[offset++] as string
      if (option === '--') break
      if (executable !== 'command' && valueOptions.has(option)) offset++
    }
  }
  return []
}

export const commandWords = (command: string): string[][] =>
  splitCommands(command)
    .map(unwrapCommand)
    .filter((words) => words.length > 0)

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
  for (const words of commandWords(request.command ?? '')) {
    for (const { prefix, action } of mappings) {
      if (hasCommandPrefix(words, prefix)) actions.add(action)
    }
  }
  if (
    request.paths?.some((path) => /(^|\/)config\/policies\.yaml$/.test(normalizePolicyPath(path)))
  ) {
    actions.add('policy.edit')
  }
  return [...actions]
}
