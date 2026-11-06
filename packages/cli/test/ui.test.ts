import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rm, writeFile } from 'node:fs/promises'
import { HUB_TOKEN_ENV, ok, type Result, raindownPaths } from '@raindown/core'
import { type RunningHub, runHub } from '@raindown/hub'
import { initTempHome } from '../../mcp/test/helpers.ts'
import { commands } from '../src/commands/index.ts'
import { createUiCommand } from '../src/commands/ui.ts'
import { runCli } from '../src/run.ts'

/**
 * `raindown ui`（add-m1-inbox 6.1）：真实中枢（随机端口）、临时 RAINDOWN_HOME；打开浏览器的动作被注入替换。
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
  home = await initTempHome('raindown-ui-cli-')
  for (const k of ['RAINDOWN_HOME', 'RAINDOWN_ACTOR', HUB_TOKEN_ENV]) saved[k] = process.env[k]
  process.env.RAINDOWN_HOME = home
  delete process.env.RAINDOWN_ACTOR
  delete process.env[HUB_TOKEN_ENV]
  hub = data(
    await runHub({
      home,
      port: 0,
      logger: quiet,
      secrets: { watch: false },
      inbox: { watch: false },
    }),
  )
  await writeFile(raindownPaths(home).hubConfig, `port: ${hub.port}\n`)
})

afterAll(async () => {
  await hub?.stop()
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await rm(home, { recursive: true, force: true })
})

describe('raindown ui', () => {
  test('打开一次性登录链接；链接换到会话 cookie 后进入页面，再次使用失效', async () => {
    const opened: string[] = []
    const ui = createUiCommand(async (url) => {
      opened.push(url)
      return ok(undefined)
    })
    const r = await runCli(['ui', '--json'], [ui])
    expect(r.exitCode).toBe(0)
    const url = opened[0] ?? ''
    expect(url).toMatch(
      new RegExp(`^http://127\\.0\\.0\\.1:${hub.port}/ui/login\\?code=[A-Za-z0-9_-]{43}$`),
    )
    expect(JSON.parse(r.stdout).data).toMatchObject({ url, opened: true })

    const login = await fetch(url, { redirect: 'manual' })
    expect(login.status).toBe(303)
    const cookie = /raindown_ui_session=[^;]+/.exec(login.headers.get('set-cookie') ?? '')?.[0]
    expect(cookie).toBeDefined()
    const page = await fetch(`${hub.url}/ui`, { headers: { Cookie: cookie ?? '' } })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('需要我的')
    expect((await fetch(url, { redirect: 'manual' })).status).toBe(401)
    // 没有会话直接访问：只提示登录。
    const direct = await fetch(`${hub.url}/ui`)
    expect(direct.status).toBe(401)
    expect(await direct.text()).toContain('请运行 raindown ui 登录')
  })

  test('--print 只输出链接；AI 身份不能申请登录码', async () => {
    const printed = await runCli(['ui', '--print'], commands)
    expect(printed.exitCode).toBe(0)
    expect(printed.stdout).toContain(`http://127.0.0.1:${hub.port}/ui/login?code=`)
    const ai = await runCli(['ui', '--print', '--json', '--actor', 'codex'], commands)
    expect(ai.exitCode).toBe(1)
    expect(JSON.parse(ai.stdout || ai.stderr)).toMatchObject({ error: { code: 'user_only' } })
  })
})
