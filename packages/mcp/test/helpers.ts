import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { initRaindownHome } from '@raindown/core'
import { stringify } from 'yaml'
import { createRaindownMcpServer, type RaindownMcpServerOptions } from '../src/index.ts'

/**
 * 新建并初始化一个临时 raindown-home（绝不触碰真实的 ~/raindown-home），
 * 并定义 `ws/product-res` 与 `ws/xuanxue-saas` 两个产品 workspace。
 */
export async function initTempHome(prefix = 'raindown-mcp-'): Promise<string> {
  const home = join(mkdtempSync(join(tmpdir(), prefix)), 'home')
  const r = await initRaindownHome(home)
  if (!r.ok) throw new Error(r.error.message)
  const dir = join(home, 'config', 'workspaces')
  mkdirSync(dir, { recursive: true })
  for (const id of ['product-res', 'xuanxue-saas']) {
    const ws = { id, kind: 'product', name: id, description: `${id} workspace`, repos: [] }
    writeFileSync(join(dir, `${id}.yaml`), stringify(ws))
  }
  return home
}

/** 用 SDK 的 Client 经内存传输连接一个 Raindown MCP 服务。 */
export async function connect(opts: RaindownMcpServerOptions): Promise<Client> {
  const server = createRaindownMcpServer(opts)
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'raindown-test', version: '0.0.0' })
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])
  return client
}

/** 调用工具并解析其唯一的 text 内容为 JSON 文档。 */
export async function callJson(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; doc: Record<string, unknown> & { ok: boolean } }> {
  const res = await client.callTool({ name, arguments: args })
  const content = res.content as { type: string; text: string }[]
  if (content.length !== 1 || content[0]?.type !== 'text') {
    throw new Error(`工具返回内容应是一段 text：${JSON.stringify(content)}`)
  }
  return { isError: res.isError === true, doc: JSON.parse(content[0].text) }
}
