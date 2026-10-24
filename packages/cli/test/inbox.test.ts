import { afterEach, expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { flowPaths, HubClient } from '@flow/core'
import { openLedger, type RunningHub, runHub } from '@flow/hub'
import { must } from '../../hub/test/ledger-helpers.ts'
import { callJson, connect, initTempHome } from '../../mcp/test/helpers.ts'
import { commands } from '../src/commands/index.ts'
import { runCli } from '../src/run.ts'

let home: string | undefined
let hub: RunningHub | undefined
const savedHome = process.env.FLOW_HOME
afterEach(async () => {
  await hub?.stop()
  hub = undefined
  if (home) rmSync(join(home, '..'), { recursive: true, force: true })
  home = undefined
  if (savedHome === undefined) delete process.env.FLOW_HOME
  else process.env.FLOW_HOME = savedHome
})

test('flow inbox 默认 list、CJK 表格、短 id act、CLI 固定渠道；MCP 共用中枢身份规则', async () => {
  home = await initTempHome('flow-inbox-cli-')
  process.env.FLOW_HOME = home
  const ledger = await openLedger(flowPaths(home).ledgerDb)
  try {
    for (const [id, level, title] of [
      ['digest', 'digest', '每日摘要'],
      ['decide', 'decide', '等待确认提案'],
      ['interrupt', 'interrupt', '立即处理问题'],
    ] as const) {
      must(
        ledger.append(
          {
            type: 'inbox.item_created',
            workspace: 'ws/product-res',
            payload: {
              item_id: `ask.${id}`,
              level,
              source: 'supervisor',
              source_ref: id,
              title,
              body: '正文',
              actions: [],
            },
          },
          { actor: 'codex' },
        ),
      )
    }
  } finally {
    ledger.close()
  }
  hub = must(
    await runHub({
      home,
      port: 0,
      logger: { info() {}, warn() {}, error() {} } as never,
      inbox: { watch: false },
    }),
  )
  writeFileSync(flowPaths(home).hubConfig, `port: ${hub.port}\n`)
  const client = new HubClient({ home, actor: 'user' })
  const items = must(await client.listInbox()).items
  const table = await runCli(['inbox'], commands)
  expect(table.exitCode).toBe(0)
  expect(table.stdout).toBe((await runCli(['inbox', 'list'], commands)).stdout)
  expect(table.stdout.split('\n')[0]).toMatch(/ID\s+级别\s+来源\s+Workspace\s+标题\s+创建时间/)
  const rows = table.stdout.trim().split('\n').slice(2)
  expect(rows).toHaveLength(3)
  for (const [index, item] of items.entries()) {
    for (const value of [
      item.short_id,
      item.level,
      item.source,
      'ws/product-res',
      item.title,
      item.created_at,
    ]) {
      expect(rows[index]).toContain(value)
    }
  }
  expect(items.map((i) => i.level)).toEqual(['interrupt', 'decide', 'digest'])
  const mcp = await connect({ home, actor: 'codex' })
  try {
    const listed = await callJson(mcp, 'inbox_list', {})
    expect(listed.doc).toEqual(JSON.parse((await runCli(['inbox', '--json'], commands)).stdout))
    const denied = await callJson(mcp, 'inbox_act', { id: items[0]?.id, action: 'approve' })
    expect(denied.doc).toMatchObject({ error: { code: 'user_only' } })
    const dismissed = await runCli(
      ['inbox', 'act', items[0]?.short_id as string, 'dismiss', '--via', 'telegram', '--json'],
      commands,
    )
    expect(dismissed.exitCode).toBe(0)
    expect(JSON.parse(dismissed.stdout).data.item.closed).toMatchObject({
      via: 'cli',
      cause_actor: 'user',
    })
    const own = await callJson(mcp, 'inbox_act', {
      id: items[1]?.short_id,
      action: 'dismiss',
      via: 'web',
    })
    expect(own.doc).toMatchObject({
      ok: true,
      data: { item: { closed: { cause_actor: 'codex', via: 'web' } } },
    })
  } finally {
    await mcp.close()
  }
})
