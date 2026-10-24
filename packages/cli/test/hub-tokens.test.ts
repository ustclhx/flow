import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rm, writeFile } from 'node:fs/promises'
import { flowPaths, HUB_TOKEN_ENV, HubClient, type Result } from '@flow/core'
import { type RunningHub, runHub } from '@flow/hub'
import { initTempHome } from '../../mcp/test/helpers.ts'
import { commands } from '../src/commands/index.ts'
import { runCli } from '../src/run.ts'

/**
 * `flow hub token issue|list|revoke`（add-m1-inbox 1.3，design D9）：真实中枢（随机端口）、临时 FLOW_HOME。
 */

let home: string
let hub: RunningHub
const saved: Record<string, string | undefined> = {}
const quiet = { info() {}, warn() {} }

function data<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const cli = async (...argv: string[]) => {
  const r = await runCli([...argv, '--json'], commands)
  return { code: r.exitCode, doc: JSON.parse(r.stdout || r.stderr) }
}

beforeAll(async () => {
  home = await initTempHome('flow-hub-tokens-cli-')
  for (const k of ['FLOW_HOME', 'FLOW_ACTOR', HUB_TOKEN_ENV]) saved[k] = process.env[k]
  process.env.FLOW_HOME = home
  delete process.env.FLOW_ACTOR
  delete process.env[HUB_TOKEN_ENV]
  hub = data(await runHub({ home, port: 0, logger: quiet, secrets: { watch: false } }))
  await writeFile(flowPaths(home).hubConfig, `port: ${hub.port}\n`)
})

afterAll(async () => {
  await hub?.stop()
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await rm(home, { recursive: true, force: true })
})

describe('flow hub token', () => {
  test('issue 只输出一次明文；list 不含明文；revoke 立即生效', async () => {
    const issued = await cli('hub', 'token', 'issue', 'grok', '--note', 'Grok Bot', '--remote')
    expect(issued.code).toBe(0)
    const { token, secret } = issued.doc.data as {
      token: { id: string; actor: string; note: string; remote: boolean }
      secret: string
    }
    expect(token).toMatchObject({ actor: 'grok', note: 'Grok Bot', remote: true })

    // 带绑定 token 的进程（FLOW_HUB_TOKEN）身份固定为 grok。
    const bound = new HubClient({ home, actor: 'grok', token: secret })
    const created = data(
      await bound.createTask({
        goal: 'x',
        workspace: 'ws/product-res',
        role: 'dev',
        executor: 'fake',
      }),
    )
    expect(created.task.created_by).toBe('grok')
    process.env[HUB_TOKEN_ENV] = secret
    try {
      const mismatch = await new HubClient({ home, actor: 'user' }).listTasks()
      expect(mismatch).toMatchObject({ ok: false, error: { code: 'actor_mismatch' } })
      // 用绑定 token 管理 token：user_only。
      const self = await cli('hub', 'token', 'list', '--actor', 'grok')
      expect(self.doc).toMatchObject({ ok: false, error: { code: 'user_only' } })
    } finally {
      delete process.env[HUB_TOKEN_ENV]
    }

    const listed = await cli('hub', 'token', 'list')
    expect(listed.code).toBe(0)
    expect(JSON.stringify(listed.doc)).not.toContain(secret)
    expect(listed.doc.data.tokens).toHaveLength(1)

    const revoked = await cli('hub', 'token', 'revoke', token.id)
    expect(revoked.code).toBe(0)
    const after = await bound.listTasks()
    expect(after).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
  })

  test('三个命令都只允许 user：--actor 或 FLOW_ACTOR 声明非 user 时返回 user_only', async () => {
    const r1 = await cli('hub', 'token', 'issue', 'x1', '--actor', 'codex')
    expect(r1.doc).toMatchObject({ ok: false, error: { code: 'user_only' } })
    process.env.FLOW_ACTOR = 'claude'
    try {
      const r2 = await cli('hub', 'token', 'list', '--actor', 'user')
      expect(r2.doc).toMatchObject({ ok: false, error: { code: 'user_only' } })
      const r3 = await cli('hub', 'token', 'revoke', 'tok_000000000000')
      expect(r3.doc).toMatchObject({ ok: false, error: { code: 'user_only' } })
    } finally {
      delete process.env.FLOW_ACTOR
    }
    const user = await cli('hub', 'token', 'issue', 'user')
    expect(user.doc).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } })
  })

  test('hub status 的人类可读输出报告缺少的密钥', async () => {
    const r = await runCli(['hub', 'status'], commands)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain('缺少的密钥')
  })
})
