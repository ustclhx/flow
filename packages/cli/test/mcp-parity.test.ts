import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { type Operation, operations } from '@flow/core'
import { toolInputSchema } from '@flow/mcp'
import { callJson, connect, initTempHome } from '../../mcp/test/helpers.ts'
import { commands } from '../src/commands/index.ts'
import { runCli } from '../src/run.ts'

/**
 * CLI ≡ MCP 一致性（knowledge-access "两种接口等价"、tasks 5.1）：对 `operations` 中的**每一个**操作，
 * 用同一份最小合法输入分别经 CLI `--json` 与 MCP 工具调用，比较返回的 JSON 文档。
 * 新增操作会被自动覆盖；输入无法由 schema 自动构造时，在 SAMPLE_INPUTS 中补一份样例。
 * 写操作在两个独立的临时 home 中各执行一次，比较前把 sha、时间戳、随机后缀等易变部分归一化。
 */

type Json = Record<string, unknown>

/**
 * 自动构造不出合理输入的操作，在这里给出样例输入（键为操作名）。
 * kb_journal 给出样例是为了同时覆盖可选的 workspace 选项；capture 走自动构造。
 */
const SAMPLE_INPUTS: Record<string, Json> = {
  kb_journal: { text: '一致性测试日志', workspace: 'ws/product-res' },
}

const ACTOR = 'parity-agent'

/** 由 JSON Schema 构造一个最小样例值：只填必填字段。 */
function sample(schema: Json): unknown {
  if ('const' in schema) return schema.const
  if (Array.isArray(schema.enum)) return schema.enum[0]
  for (const k of ['anyOf', 'oneOf'] as const) {
    const first = (schema[k] as Json[] | undefined)?.find((s) => s.type !== 'null')
    if (first) return sample(first)
  }
  if ('default' in schema) return schema.default
  switch (schema.type) {
    case 'string':
      return 'parity'.padEnd(Number(schema.minLength ?? 0), 'x')
    case 'integer':
    case 'number':
      return Number(schema.minimum ?? 1)
    case 'boolean':
      return true
    case 'array': {
      const n = Math.max(1, Number(schema.minItems ?? 1))
      return Array.from({ length: n }, () => sample((schema.items as Json) ?? { type: 'string' }))
    }
    case 'object': {
      const props = (schema.properties ?? {}) as Record<string, Json>
      const required = (schema.required ?? []) as string[]
      return Object.fromEntries(required.map((k) => [k, sample(props[k] ?? {})]))
    }
    default:
      return 'parity'
  }
}

function sampleInput(op: Operation<never, unknown>): Json {
  return SAMPLE_INPUTS[op.name] ?? (sample(toolInputSchema(op) as Json) as Json)
}

const kebab = (key: string) => key.replace(/[A-Z_]/g, (c) => `-${c === '_' ? '' : c.toLowerCase()}`)

/** 按 CLI 的映射规则（位置参数 + kebab-case 选项）把输入对象还原成 argv。 */
function toArgv(op: Operation<never, unknown>, input: Json): string[] {
  const positional = op.positional ?? []
  const args: string[] = []
  for (const key of positional) {
    const v = input[key]
    if (v === undefined) break
    args.push(...(Array.isArray(v) ? v.map(String) : [String(v)]))
  }
  const opts: string[] = []
  for (const [key, v] of Object.entries(input)) {
    if (positional.includes(key) || v === undefined) continue
    if (typeof v === 'boolean') {
      if (v) opts.push(`--${kebab(key)}`)
    } else if (Array.isArray(v)) {
      for (const item of v) opts.push(`--${kebab(key)}`, String(item))
    } else {
      opts.push(`--${kebab(key)}`, String(v))
    }
  }
  return [...op.cli.split(' '), ...args, ...opts, '--json', '--actor', ACTOR]
}

/** 归一化每次执行都不同的部分：十六进制串（sha、随机后缀）→ `<hex>`，其余数字（日期时间）→ 0。 */
function normalize(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/(?<![A-Za-z0-9])[0-9a-f]{6,}(?![A-Za-z0-9])/g, '<hex>')
      .replace(/[0-9]/g, '0')
  }
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]))
  }
  return value
}

let saved: string | undefined
beforeEach(() => {
  saved = process.env.FLOW_HOME
})
afterEach(() => {
  if (saved === undefined) delete process.env.FLOW_HOME
  else process.env.FLOW_HOME = saved
})

describe('CLI 与 MCP 结果一致', () => {
  test('operations 非空且每个操作都有 CLI 命令', () => {
    expect(operations.length).toBeGreaterThan(0)
    for (const op of operations) expect(commands.some((c) => c.name === op.cli)).toBe(true)
  })

  for (const op of operations) {
    test(`${op.name}（flow ${op.cli}）`, async () => {
      const input = sampleInput(op)
      const parsed = op.input.safeParse(input)
      if (!parsed.success) {
        throw new Error(
          `无法为 ${op.name} 自动构造合法输入，请在 SAMPLE_INPUTS 中补充：${parsed.error.message}`,
        )
      }

      const cliHome = await initTempHome('flow-parity-cli-')
      process.env.FLOW_HOME = cliHome
      const out = await runCli(toArgv(op, input), commands)
      const cliDoc = JSON.parse(out.stdout)

      const mcpHome = await initTempHome('flow-parity-mcp-')
      const client = await connect({ actor: ACTOR, home: mcpHome })
      const { isError, doc: mcpDoc } = await callJson(client, op.name, input)

      expect(isError).toBe(!cliDoc.ok)
      expect(out.exitCode === 0).toBe(cliDoc.ok)
      expect(normalize(mcpDoc)).toEqual(normalize(cliDoc))
      // 同一 home、同一输入的只读操作应逐字节一致；写操作只比较归一化后的结构。
    })
  }

  test('非法输入在两端得到同一个用法错误', async () => {
    const op = operations.find((o) => o.name === 'kb_journal') as Operation<never, unknown>
    const home = await initTempHome('flow-parity-bad-')
    process.env.FLOW_HOME = home
    const out = await runCli(
      [...op.cli.split(' '), '--workspace', 'ws/product-res', '--json', '--actor', ACTOR],
      commands,
    )
    expect(out.exitCode).toBe(2)
    const client = await connect({ actor: ACTOR, home })
    const { isError, doc } = await callJson(client, op.name, { workspace: 'ws/product-res' })
    expect(isError).toBe(true)
    expect(doc).toEqual(JSON.parse(out.stdout))
  })
})
