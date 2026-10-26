import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { flowPaths, HUB_TOKEN_ENV, type Result } from '@flow/core'
import { openLedger, type RunningHub, runHub } from '@flow/hub'
import { initTempHome } from '../../mcp/test/helpers.ts'
import { commands } from '../src/commands/index.ts'
import { runCli } from '../src/run.ts'

/**
 * `flow ask`、`flow supervisor wake [--release]`、`flow supervisor status`（add-m1-supervisor 3.4）：
 * 真实中枢（随机端口、临时 FLOW_HOME，flow init 生成的 supervisor 角色），不启动节点。
 */

let home: string
let hub: RunningHub
const saved: Record<string, string | undefined> = {}
const quiet = { info() {}, warn() {} }

function data<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

beforeAll(async () => {
  home = await initTempHome('flow-supervisor-cli-')
  const repo = join(home, '..', 'repo')
  mkdirSync(repo, { recursive: true })
  const yaml = (id: string, extra = '') =>
    `id: ${id}\nkind: product\nname: ${id}\ndescription: ${id}\nrepos: [${JSON.stringify(repo)}]\n${extra}`
  writeFileSync(join(home, 'config', 'workspaces', 'product-res.yaml'), yaml('product-res'))
  writeFileSync(
    join(home, 'config', 'workspaces', 'xuanxue-saas.yaml'),
    yaml('xuanxue-saas', 'supervisor:\n  enabled: false\n'),
  )
  for (const k of ['FLOW_HOME', 'FLOW_ACTOR', HUB_TOKEN_ENV]) saved[k] = process.env[k]
  process.env.FLOW_HOME = home
  delete process.env.FLOW_ACTOR
  delete process.env[HUB_TOKEN_ENV]
  hub = data(await runHub({ home, port: 0, logger: quiet, inbox: { watch: false, channels: [] } }))
  await writeFile(flowPaths(home).hubConfig, `port: ${hub.port}\n`)
})

afterAll(async () => {
  await hub?.stop()
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await rm(join(home, '..'), { recursive: true, force: true })
})

describe('flow ask / flow supervisor', () => {
  test('flow ask 输出唤醒任务；再次唤醒已排队；status 显示当前唤醒与队列；--release；AI 身份 user_only；未启用', async () => {
    const ask = await runCli(['ask', 'product-res', '修一下', 'README', '--json'], commands)
    expect(ask.exitCode).toBe(0)
    const asked = JSON.parse(ask.stdout).data
    expect(asked).toMatchObject({
      state: 'started',
      wake: { origin: 'instruction', generation: 1 },
    })

    const again = await runCli(['supervisor', 'wake', 'product-res'], commands)
    expect(again.exitCode).toBe(0)
    expect(again.stdout).toContain('已排队，前面有一次唤醒在运行')

    const status = await runCli(['supervisor', 'status', 'product-res'], commands)
    expect(status.exitCode).toBe(0)
    expect(status.stdout).toContain(`当前唤醒：${asked.wake.task_id}`)
    expect(status.stdout).toContain('队列：instruction 1')

    const release = await runCli(
      ['supervisor', 'wake', 'product-res', '--release', 'autonomous', '--json'],
      commands,
    )
    expect(JSON.parse(release.stdout).data.state).toBe('empty')
    const badQueue = await runCli(
      ['supervisor', 'wake', 'product-res', '--release', 'reply'],
      commands,
    )
    expect(badQueue.exitCode).toBe(2)

    const ai = await runCli(['ask', 'product-res', '越权', '--json', '--actor', 'codex'], commands)
    expect(ai.exitCode).toBe(1)
    expect(JSON.parse(ai.stdout || ai.stderr)).toMatchObject({ error: { code: 'user_only' } })

    const disabled = await runCli(['ask', 'xuanxue-saas', '看看支付', '--json'], commands)
    expect(disabled.exitCode).toBe(1)
    expect(JSON.parse(disabled.stdout || disabled.stderr)).toMatchObject({
      error: { code: 'supervisor_disabled' },
    })

    await hub.stop()
    const ledger = await openLedger(flowPaths(home).ledgerDb)
    const instr = ledger.eventsAfter(0, {}, 10_000).filter((e) => e.type === 'user.instruction')
    ledger.close()
    expect(instr).toHaveLength(2)
    expect(instr[0]).toMatchObject({
      workspace: 'ws/product-res',
      actor: 'user',
      payload: { text: '修一下 README', via: 'cli' },
    })
  })
})
