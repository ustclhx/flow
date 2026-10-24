import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rm, writeFile } from 'node:fs/promises'
import { flowPaths, HUB_TOKEN_ENV, ok, type Result } from '@flow/core'
import { type RunningHub, runHub } from '@flow/hub'
import { FakeTelegram, USER_ID } from '../../hub/test/telegram-fixtures.ts'
import { initTempHome } from '../../mcp/test/helpers.ts'
import { commands } from '../src/commands/index.ts'
import { runCli } from '../src/run.ts'

/**
 * `flow telegram link`（add-m1-inbox 5.1）：真实中枢（随机端口、临时 FLOW_HOME），Telegram 是假的 HTTP 服务。
 */

let home: string
let hub: RunningHub
let fake: FakeTelegram
const saved: Record<string, string | undefined> = {}
const quiet = { info() {}, warn() {} }

function data<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}

beforeAll(async () => {
  fake = await new FakeTelegram().start()
  home = await initTempHome('flow-telegram-cli-')
  await writeFile(`${flowPaths(home).config}/secrets.sops.yaml`, 'sops: placeholder\n')
  for (const k of ['FLOW_HOME', 'FLOW_ACTOR', HUB_TOKEN_ENV]) saved[k] = process.env[k]
  process.env.FLOW_HOME = home
  delete process.env.FLOW_ACTOR
  delete process.env[HUB_TOKEN_ENV]
  hub = data(
    await runHub({
      home,
      port: 0,
      logger: quiet,
      secrets: {
        watch: false,
        load: async () => ok(new Map([['telegram/bot-token', fake.token]])),
      },
      inbox: { watch: false, telegram: { apiBase: fake.url, pollTimeoutS: 1, env: {} } },
    }),
  )
  await writeFile(flowPaths(home).hubConfig, `port: ${hub.port}\n`)
})

afterAll(async () => {
  await hub?.stop()
  await fake?.close()
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await rm(home, { recursive: true, force: true })
})

describe('flow telegram link', () => {
  test('输出绑定命令与深链接；发送后完成绑定；AI 身份不能申请', async () => {
    const r = await runCli(['telegram', 'link'], commands)
    expect(r.exitCode).toBe(0)
    const code = /\/link ([a-z2-9]{16})/.exec(r.stdout)?.[1]
    expect(code).toBeDefined()
    expect(r.stdout).toContain(`https://t.me/flow_test_bot?start=${code}`)
    expect(r.stdout).toContain('只能使用一次')

    fake.say(`/link ${code}`)
    const deadline = Date.now() + 5000
    while (!fake.to(USER_ID).some((m) => m.text.includes('已绑定')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(fake.to(USER_ID).some((m) => m.text.includes('已绑定'))).toBe(true)

    const ai = await runCli(['telegram', 'link', '--json', '--actor', 'codex'], commands)
    expect(ai.exitCode).toBe(1)
    expect(JSON.parse(ai.stdout || ai.stderr)).toMatchObject({ error: { code: 'user_only' } })
  })
})
