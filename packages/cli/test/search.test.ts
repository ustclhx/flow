import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { initFlowHome, kbGetOp, kbQueryOp, kbSearchOp } from '@flow/core'
import { tempHome, writeEntry } from '../../core/test/helpers.ts'
import { commands } from '../src/commands/index.ts'
import { runCli } from '../src/run.ts'

describe('检索操作的 CLI 等价性', () => {
  let home: string
  let previousHome: string | undefined
  const context = () => ({ home, actor: 'codex', via: 'mcp' as const })
  beforeEach(async () => {
    home = tempHome('flow-search-cli-')
    previousHome = process.env.FLOW_HOME
    process.env.FLOW_HOME = home
    const initialized = await initFlowHome(home)
    if (!initialized.ok) throw new Error(initialized.error.message)
    writeEntry(
      home,
      'products/east',
      {
        type: 'product',
        title: '干支日',
        summary: '东方站',
        owner: 'ws/xuanxue-saas',
      },
      '干支日 域名',
    )
  })
  afterEach(() => {
    if (previousHome === undefined) delete process.env.FLOW_HOME
    else process.env.FLOW_HOME = previousHome
    rmSync(dirname(home), { recursive: true, force: true })
  })

  test('search：末尾多词合并、默认值、选项和短查询的 data 与直接调用完全相同', async () => {
    for (const [args, input] of [
      [['干支日'], { query: '干支日' }],
      [['域名'], { query: '域名' }],
      [
        ['干支日', '域名', '--limit', '1', '--type', 'product', '--no-include-journal'],
        { query: '干支日 域名', limit: 1, type: 'product', includeJournal: false },
      ],
    ] as const) {
      const direct = await kbSearchOp.run(input, context())
      const cli = await runCli(['kb', 'search', ...args, '--json'], commands)
      expect(cli.exitCode).toBe(0)
      expect(direct.ok).toBe(true)
      expect(JSON.parse(cli.stdout).data).toEqual(direct.ok ? direct.data : undefined)
    }
  })

  test('get 与 query：CLI data 与直接调用完全相同', async () => {
    const get = await kbGetOp.run({ id: 'products/east' }, context())
    const query = await kbQueryOp.run(
      { filters: ['type=product', 'owner=ws/xuanxue-saas'] },
      context(),
    )
    const cliGet = await runCli(['kb', 'get', 'products/east', '--json'], commands)
    const cliQuery = await runCli(
      ['kb', 'query', 'type=product', 'owner=ws/xuanxue-saas', '--json'],
      commands,
    )
    expect(cliGet.exitCode).toBe(0)
    expect(cliQuery.exitCode).toBe(0)
    expect(get.ok).toBe(true)
    expect(query.ok).toBe(true)
    expect(JSON.parse(cliGet.stdout).data).toEqual(get.ok ? get.data : undefined)
    expect(JSON.parse(cliQuery.stdout).data).toEqual(query.ok ? query.data : undefined)
  })

  test('缺失条目退出 1，非法过滤条件和输入退出 2', async () => {
    const missing = await runCli(['kb', 'get', 'missing', '--json'], commands)
    expect(missing.exitCode).toBe(1)
    expect(JSON.parse(missing.stdout).error.code).toBe('not_found')
    const invalid = await runCli(['kb', 'query', 'type', '--json'], commands)
    expect(invalid.exitCode).toBe(2)
    expect(JSON.parse(invalid.stdout).error.code).toBe('invalid_filter')
    for (const args of [[], ['干支日', '--limit', '0'], ['干支日', '--limit', 'bad']]) {
      expect((await runCli(['kb', 'search', ...args, '--json'], commands)).exitCode).toBe(2)
    }
  })
})
