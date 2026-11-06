import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initRaindownHome, raindownPaths } from '@raindown/core'
import { runHub } from '@raindown/hub'
import { createFakeExecutor, startNode } from '@raindown/node'
import { commands } from '../src/commands/index.ts'
import { runCli } from '../src/run.ts'

/** `raindown node list`（node-protocol "查看节点"）：临时 RAINDOWN_HOME，真实中枢与节点。 */
let saved: string | undefined
let home: string
const stops: Array<() => Promise<void>> = []
const quiet = { info() {}, warn() {}, error() {} }

beforeEach(async () => {
  saved = process.env.RAINDOWN_HOME
  home = join(mkdtempSync(join(tmpdir(), 'raindown-cli-node-')), 'home')
  process.env.RAINDOWN_HOME = home
  const init = await initRaindownHome(home)
  if (!init.ok) throw new Error(init.error.message)
})

afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop()
  if (saved === undefined) delete process.env.RAINDOWN_HOME
  else process.env.RAINDOWN_HOME = saved
})

test('raindown node list：输出节点 id、能力与最近活动时间', async () => {
  const hub = await runHub({ home, port: 0, logger: quiet as never })
  if (!hub.ok) throw new Error(hub.error.message)
  stops.push(hub.data.stop)
  writeFileSync(
    raindownPaths(home).nodeConfig,
    `hub_url: ${hub.data.url}\ncapabilities: [browser]\n`,
  )
  const node = await startNode({ home, logger: quiet, hostname: 'cli-host', waitS: 1 })
  if (!node.ok) throw new Error(node.error.message)
  stops.push(node.data.stop)

  let out = ''
  for (let i = 0; i < 100 && !out.includes(node.data.nodeId); i++) {
    out = (await runCli(['node', 'list'], commands)).stdout
    if (!out.includes(node.data.nodeId)) await new Promise((r) => setTimeout(r, 20))
  }
  expect(out).toContain(node.data.nodeId)
  expect(out).toContain('cli-host')
  expect(out).toContain('browser, executor:fake')
  expect(out).toMatch(/\d{4}-\d{2}-\d{2}T/)

  const json = JSON.parse((await runCli(['node', 'list', '--json'], commands)).stdout)
  expect(json.data.nodes[0]).toMatchObject({
    node_id: node.data.nodeId,
    hostname: 'cli-host',
    executors: [
      { type: 'fake', mode: 'headless', capabilities: createFakeExecutor().adapterCapabilities },
    ],
  })
})

test('raindown node list：中枢从未启动时返回可重试错误（退出码 3）', async () => {
  const r = await runCli(['node', 'list'], commands)
  expect(r.exitCode).toBe(3)
})
