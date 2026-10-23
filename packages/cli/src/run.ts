import { parseArgs } from 'node:util'
import { fail, ok, type Result, VERSION } from '@flow/core'
import type { Command, OptionSpec } from './command.ts'
import { type Rendered, render } from './output.ts'

const GLOBAL_OPTIONS: Record<string, OptionSpec> = {
  json: { type: 'boolean', description: '输出机器可读的 JSON' },
  actor: { type: 'string', description: '操作者标识，默认 user' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'V' },
}

/** 解析 argv 并执行匹配的命令。纯函数式入口，便于测试；进程副作用只在 main.ts。 */
export async function runCli(argv: string[], commands: Command<unknown>[]): Promise<Rendered> {
  const json = argv.includes('--json')
  const positionals = argv.filter((a) => !a.startsWith('-'))
  const command = matchCommand(positionals, commands)

  if (!command) {
    if (argv.includes('--version') || argv.includes('-V')) {
      return render(ok({ version: VERSION }), { json, human: (d) => d.version })
    }
    if (positionals.length === 0 || argv.includes('--help') || argv.includes('-h')) {
      return render(ok(helpText(commands)), { json, human: (d) => d })
    }
    return render(fail('usage', 'unknown_command', `未知命令：${positionals.join(' ')}`), {
      json,
    })
  }

  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: argv,
      options: { ...GLOBAL_OPTIONS, ...(command.options ?? {}) } as never,
      allowPositionals: true,
      strict: true,
    })
  } catch (err) {
    return render(fail('usage', 'invalid_arguments', (err as Error).message), { json })
  }

  const { json: _j, actor, help, version: _v, ...options } = parsed.values
  if (help) {
    return render(ok(commandHelp(command)), { json, human: (d) => d })
  }
  const args = parsed.positionals.slice(command.name.split(' ').length)
  let result: Result<unknown>
  try {
    result = await command.run({
      args,
      options: options as Record<string, string | boolean | string[] | undefined>,
      actor: typeof actor === 'string' && actor !== '' ? actor : 'user',
      actorGiven: typeof actor === 'string' && actor !== '',
    })
  } catch (err) {
    result = fail('failure', 'internal_error', (err as Error).message)
  }
  return render(result, {
    json,
    ...(command.human ? { human: command.human } : {}),
    ...(command.humanError ? { humanError: command.humanError } : {}),
  })
}

/** 取能匹配的最长命令路径，例如 `kb proposals accept` 优先于 `kb proposals`。 */
function matchCommand(positionals: string[], commands: Command<unknown>[]) {
  let best: Command<unknown> | undefined
  for (const c of commands) {
    const parts = c.name.split(' ')
    const matches = parts.every((p, i) => positionals[i] === p)
    if (matches && (!best || parts.length > best.name.split(' ').length)) best = c
  }
  return best
}

function helpText(commands: Command<unknown>[]): string {
  const width = Math.max(0, ...commands.map((c) => c.name.length))
  const lines = commands
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`)
  return [
    `flow ${VERSION}`,
    '',
    '用法：flow <命令> [选项]',
    '',
    '命令：',
    ...lines,
    '',
    '全局选项：--json  --actor <name>  --help  --version',
  ].join('\n')
}

function commandHelp(c: Command<unknown>): string {
  const opts = Object.entries(c.options ?? {}).map(
    ([k, v]) => `  --${k}${v.type === 'string' ? ' <value>' : ''}  ${v.description ?? ''}`,
  )
  return [`flow ${c.usage ?? c.name}`, '', c.summary, ...(opts.length ? ['', ...opts] : [])].join(
    '\n',
  )
}
