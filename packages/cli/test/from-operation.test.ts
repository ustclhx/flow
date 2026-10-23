import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineOperation, initFlowHome, ok } from '@flow/core'
import { z } from 'zod'
import { commands } from '../src/commands/index.ts'
import { commandFromOperation } from '../src/from-operation.ts'
import { runCli } from '../src/run.ts'

const probe = defineOperation({
  name: 'kb_probe',
  cli: 'kb probe',
  summary: '回显解析后的输入',
  input: z.object({
    words: z.array(z.string()),
    maxItems: z.number().int().optional(),
    dryRun: z.boolean().optional(),
  }),
  positional: ['words'],
  run: async (input, ctx) => ok({ input, actor: ctx.actor, via: ctx.via }),
})
const probeCommands = [commandFromOperation(probe as never)]

describe('commandFromOperation', () => {
  test('位置参数、kebab-case 选项与数字转换都映射到同一个输入对象', async () => {
    const out = await runCli(
      ['kb', 'probe', 'a', 'b', '--max-items', '3', '--dry-run', '--actor', 'codex', '--json'],
      probeCommands,
    )
    expect(JSON.parse(out.stdout)).toEqual({
      ok: true,
      data: {
        input: { words: ['a', 'b'], maxItems: 3, dryRun: true },
        actor: 'codex',
        via: 'cli',
      },
    })
  })

  test('输入不符合 schema 时为用法错误（退出码 2）', async () => {
    const out = await runCli(['kb', 'probe', '--max-items', 'x', '--json'], probeCommands)
    expect(out.exitCode).toBe(2)
    expect(JSON.parse(out.stdout).error.code).toBe('invalid_arguments')
  })
})

describe('kb journal 与 capture', () => {
  let home: string
  let prev: string | undefined
  beforeEach(async () => {
    home = join(mkdtempSync(join(tmpdir(), 'flow-ops-cli-')), 'home')
    const r = await initFlowHome(home)
    if (!r.ok) throw new Error(r.error.message)
    prev = process.env.FLOW_HOME
    process.env.FLOW_HOME = home
  })
  afterEach(() => {
    if (prev === undefined) delete process.env.FLOW_HOME
    else process.env.FLOW_HOME = prev
  })

  test('flow kb journal 写入当天的 journal 文件', async () => {
    const out = await runCli(['kb', 'journal', '部署完成', '--json', '--actor', 'codex'], commands)
    expect(out.exitCode).toBe(0)
    const { file } = JSON.parse(out.stdout).data
    expect(readFileSync(join(home, file), 'utf8')).toContain('部署完成')
  })

  test('flow capture 不加引号的多个词连成一句，只写 raw/inbox/，brain 不变', async () => {
    const brainBefore = readdirSync(join(home, 'brain')).sort()
    const out = await runCli(['capture', '考虑给东方站', '加日语', '--json'], commands)
    expect(out.exitCode).toBe(0)
    const { file } = JSON.parse(out.stdout).data
    const text = readFileSync(join(home, file), 'utf8')
    expect(text).toContain('考虑给东方站 加日语')
    expect(text).toContain('source: cli')
    expect(readdirSync(join(home, 'brain')).sort()).toEqual(brainBefore)
    expect(existsSync(join(home, 'brain', 'journal'))).toBe(false)
  })
})
