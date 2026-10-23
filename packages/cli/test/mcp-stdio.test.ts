import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { operations } from '@flow/core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { initTempHome } from '../../mcp/test/helpers.ts'

/** 真实进程：`bun packages/cli/src/main.ts mcp --actor test-agent`，经 stdio 连接。 */
const main = fileURLToPath(new URL('../src/main.ts', import.meta.url))

describe('flow mcp（真实进程）', () => {
  test('stdio 连接：列出工具并调用 kb_journal', async () => {
    const home = await initTempHome('flow-mcp-stdio-')
    const env = Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
    )
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [main, 'mcp', '--actor', 'test-agent'],
      env: { ...env, FLOW_HOME: home },
      stderr: 'pipe',
    })
    const client = new Client({ name: 'flow-stdio-test', version: '0.0.0' })
    await client.connect(transport)
    try {
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name)).toEqual(operations.map((o) => o.name))
      const res = await client.callTool({ name: 'kb_journal', arguments: { text: 'stdio 日志' } })
      expect(res.isError).toBeFalsy()
      const doc = JSON.parse((res.content as { text: string }[])[0]?.text ?? '')
      expect(doc.ok).toBe(true)
      const text = readFileSync(join(home, doc.data.file), 'utf8')
      expect(text).toContain('stdio 日志')
      expect(text).toContain('test-agent')
    } finally {
      await client.close()
    }
  }, 20_000)

  test('缺少 --actor 或 actor 为 user：用法错误，退出码 2，stdout 为空', async () => {
    const home = await initTempHome('flow-mcp-stdio-')
    for (const extra of [[], ['--actor', 'user']]) {
      const r = spawnSync(process.execPath, [main, 'mcp', ...extra], {
        env: { ...process.env, FLOW_HOME: home },
        input: '',
        encoding: 'utf8',
      })
      expect(r.status).toBe(2)
      expect(r.stdout).toBe('')
      expect(r.stderr).toContain('actor')
    }
  })
})
