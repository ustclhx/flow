import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flowPaths, initFlowHome } from '@flow/core'
import {
  BOUND_TOKEN_PREFIX,
  hubTokensPath,
  openTokenStore,
  type RunningHub,
  runHub,
  sha256Hex,
} from '../src/index.ts'

const roots: string[] = []
let hub: RunningHub | undefined
afterEach(async () => {
  await hub?.stop()
  hub = undefined
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

async function setupHome(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'flow-hub-tokens-'))
  roots.push(root)
  const home = join(root, 'home')
  const init = await initFlowHome(home)
  if (!init.ok) throw new Error(init.error.message)
  mkdirSync(join(home, 'config', 'workspaces'), { recursive: true })
  writeFileSync(
    join(home, 'config', 'workspaces', 'demo.yaml'),
    'id: demo\nkind: product\nname: Demo\ndescription: 测试\nrepos: []\n',
  )
  return home
}

interface Reply {
  status: number
  body: { ok: boolean; data?: Record<string, unknown>; error?: { code: string } }
}

async function start() {
  const home = await setupHome()
  const started = await runHub({
    home,
    port: 0,
    logger: { info() {}, warn() {} },
    secrets: { watch: false },
  })
  if (!started.ok) throw new Error(started.error.message)
  hub = started.data
  const userToken = readFileSync(flowPaths(home).hubToken, 'utf8').trim()
  const url = hub.url
  const call = async (
    path: string,
    o: { token?: string | null; actor?: string; body?: unknown } = {},
  ): Promise<Reply> => {
    const token = o.token === undefined ? userToken : o.token
    const res = await fetch(`${url}${path}`, {
      method: o.body === undefined ? 'GET' : 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(o.actor === undefined ? {} : { 'X-Flow-Actor': o.actor }),
        'Content-Type': 'application/json',
      },
      ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
    })
    return { status: res.status, body: (await res.json()) as Reply['body'] }
  }
  const seq = async () =>
    ((await call('/v1/health', { token: null })).body.data as { ledger_seq: number }).ledger_seq
  const issue = async (actor: string, note?: string) => {
    const r = await call('/v1/hub/tokens', { body: { actor, ...(note ? { note } : {}) } })
    expect(r.status).toBe(201)
    return r.body.data as { token: { id: string; actor: string }; secret: string }
  }
  return { home, call, seq, issue, userToken }
}

const contract = { goal: '测试', workspace: 'ws/demo', role: 'dev', executor: 'fake' }

describe('Token 认证（hub-daemon 增量）', () => {
  test('缺少 token：401 unauthorized', async () => {
    const { call } = await start()
    const r = await call('/v1/tasks', { token: null })
    expect(r).toMatchObject({ status: 401, body: { error: { code: 'unauthorized' } } })
  })

  test('user token：不声明为 user，可降级声明非 user 身份', async () => {
    const { call } = await start()
    const a = await call('/v1/tasks', { body: contract })
    expect(a.body.data).toMatchObject({ task: { created_by: 'user' } })
    const b = await call('/v1/tasks', {
      actor: 'codex',
      body: { ...contract, idempotency_key: 'k2' },
    })
    expect(b.body.data).toMatchObject({ task: { created_by: 'codex' } })
  })

  test('绑定 token 冒充用户：403 actor_mismatch，不产生任何事件', async () => {
    const { call, seq, issue } = await start()
    const { secret } = await issue('grok', 'Grok Bot')
    expect(secret.startsWith(BOUND_TOKEN_PREFIX)).toBe(true)
    const before = await seq()
    for (const actor of ['user', 'codex']) {
      const r = await call('/v1/tasks', { token: secret, actor, body: contract })
      expect(r).toMatchObject({ status: 403, body: { error: { code: 'actor_mismatch' } } })
    }
    expect(await seq()).toBe(before)
    // 不声明或声明一致时，身份固定为绑定的 grok。
    const ok1 = await call('/v1/tasks', { token: secret, body: contract })
    expect(ok1.body.data).toMatchObject({ task: { created_by: 'grok' } })
    const ok2 = await call('/v1/tasks', { token: secret, actor: 'grok' })
    expect(ok2.status).toBe(200)
  })

  test('撤销后立即失效：401 unauthorized；list 显示撤销与最近使用时间', async () => {
    const { call, issue } = await start()
    const { secret, token } = await issue('grok')
    expect((await call('/v1/tasks', { token: secret })).status).toBe(200)
    const revoked = await call(`/v1/hub/tokens/${token.id}/revoke`, { body: {} })
    expect(revoked.status).toBe(200)
    const r = await call('/v1/tasks', { token: secret })
    expect(r).toMatchObject({ status: 401, body: { error: { code: 'unauthorized' } } })
    const listed = (await call('/v1/hub/tokens')).body.data as {
      tokens: Array<{ id: string; revoked_at: string | null; last_used_at: string | null }>
    }
    expect(listed.tokens).toHaveLength(1)
    expect(listed.tokens[0]?.revoked_at).not.toBeNull()
    expect(listed.tokens[0]?.last_used_at).not.toBeNull()
    expect(JSON.stringify(listed)).not.toContain(secret)
  })

  test('token 文件：0600，只存摘要；重启后绑定 token 仍有效，撤销仍生效', async () => {
    const { home, issue, call } = await start()
    const a = await issue('grok', '备注')
    const b = await issue('node:remote-1')
    await call(`/v1/hub/tokens/${b.token.id}/revoke`, { body: {} })
    const path = hubTokensPath(home)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const text = readFileSync(path, 'utf8')
    expect(text).not.toContain(a.secret)
    expect(text).not.toContain(b.secret)
    expect(text).toContain(sha256Hex(a.secret))
    const file = JSON.parse(text) as { tokens: Array<Record<string, unknown>> }
    expect(Object.keys(file.tokens[0] ?? {}).sort()).toEqual(
      ['actor', 'id', 'issued_at', 'last_used_at', 'note', 'revoked_at', 'sha256'].sort(),
    )
    await hub?.stop()
    hub = undefined
    const again = await runHub({
      home,
      port: 0,
      logger: { info() {}, warn() {} },
      secrets: { watch: false },
    })
    if (!again.ok) throw new Error(again.error.message)
    hub = again.data
    const get = (token: string) =>
      fetch(`${again.data.url}/v1/tasks`, { headers: { Authorization: `Bearer ${token}` } })
    expect((await get(a.secret)).status).toBe(200)
    expect((await get(b.secret)).status).toBe(401)
  })

  test('签发参数：actor 不能是 user 或中枢内部身份', async () => {
    const { call } = await start()
    for (const actor of ['user', 'hub', 'policy', 'bad actor']) {
      const r = await call('/v1/hub/tokens', { body: { actor } })
      expect(r).toMatchObject({ status: 400, body: { error: { code: 'invalid_arguments' } } })
    }
  })

  test('token 文件损坏时中枢拒绝启动', async () => {
    const home = await setupHome()
    mkdirSync(flowPaths(home).state, { recursive: true })
    writeFileSync(hubTokensPath(home), '{"version":1,"tokens":[{"id":"x"}]}')
    const r = await runHub({ home, port: 0, logger: { info() {}, warn() {} } })
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid_hub_tokens' } })
  })

  test('最近使用时间在停止时落盘', async () => {
    const home = await setupHome()
    const opened = await openTokenStore(home, { flushMs: 60_000 })
    if (!opened.ok) throw new Error(opened.error.message)
    const issued = await opened.data.issue({ actor: 'grok' })
    if (!issued.ok) throw new Error(issued.error.message)
    expect(opened.data.authenticate(issued.data.secret)).toEqual({
      id: issued.data.token.id,
      actor: 'grok',
    })
    expect(opened.data.authenticate(`${issued.data.secret}x`)).toBeNull()
    await opened.data.close()
    const reopened = await openTokenStore(home)
    if (!reopened.ok) throw new Error(reopened.error.message)
    expect(reopened.data.list()[0]?.last_used_at).not.toBeNull()
    await reopened.data.close()
  })
})

describe('只有用户能做的操作', () => {
  test('AI 批准自己的审批请求：403 user_only，任务仍为 blocked(awaiting_approval)，不产生事件', async () => {
    const { call, seq, issue } = await start()
    const created = await call('/v1/tasks', { actor: 'codex', body: contract })
    const taskId = (created.body.data as { task: { id: string } }).task.id
    const node = { actor: 'node:n1' }
    await call('/v1/nodes', {
      ...node,
      body: { node_id: 'n1', hostname: 'h', version: '0', capabilities: ['executor:fake'] },
    })
    const lease = (
      await call('/v1/leases', {
        ...node,
        body: { node_id: 'n1', capabilities: ['executor:fake'], wait_s: 0 },
      })
    ).body.data as { lease: { lease_id: string; lease_token: string } }
    const renewed = await call(`/v1/leases/${lease.lease.lease_id}/renew`, {
      ...node,
      body: {
        lease_token: lease.lease.lease_token,
        blocked: { reason: 'awaiting_approval', message: '要执行 git push' },
      },
    })
    expect(renewed.status).toBe(200)
    const codexToken = (await issue('codex')).secret
    const before = await seq()
    // 用户 token 降级为 codex、绑定给 codex 的 token，都不能回复。
    for (const o of [
      { actor: 'codex' },
      { token: codexToken },
      { token: codexToken, actor: 'codex' },
    ]) {
      const r = await call(`/v1/tasks/${taskId}/reply`, { ...o, body: { kind: 'approve' } })
      expect(r).toMatchObject({ status: 403, body: { error: { code: 'user_only' } } })
    }
    expect(await seq()).toBe(before)
    const shown = (await call(`/v1/tasks/${taskId}`)).body.data as {
      task: { status: string; blocked: { reason: string } }
    }
    expect(shown.task).toMatchObject({
      status: 'blocked',
      blocked: { reason: 'awaiting_approval' },
    })
    // 用户本人可以回复。
    const byUser = await call(`/v1/tasks/${taskId}/reply`, { body: { kind: 'approve' } })
    expect(byUser.status).toBe(200)
  })

  test('token 管理：非 user 身份返回 user_only，不签发', async () => {
    const { call, issue } = await start()
    const grok = (await issue('grok')).secret
    const attempts = [
      { actor: 'codex', path: '/v1/hub/tokens', body: { actor: 'x1' } },
      { token: grok, path: '/v1/hub/tokens', body: { actor: 'x2' } },
      { token: grok, path: '/v1/hub/tokens' },
      { actor: 'codex', path: '/v1/hub/tokens/tok_000000000000/revoke', body: {} },
    ]
    for (const { path, ...o } of attempts) {
      const r = await call(path, o)
      expect(r).toMatchObject({ status: 403, body: { error: { code: 'user_only' } } })
    }
    const listed = (await call('/v1/hub/tokens')).body.data as { tokens: unknown[] }
    expect(listed.tokens).toHaveLength(1)
  })
})
