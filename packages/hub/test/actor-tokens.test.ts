import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
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
  // 预置今天（及明天，防跨午夜）的备份文件：启动时不补做备份，hub.backup_done 不会打乱"不产生事件"的计数。
  const backups = flowPaths(home).backups
  mkdirSync(backups, { recursive: true })
  for (const offset of [0, 1]) {
    const d = new Date(Date.now() + offset * 86_400_000)
    const p2 = (n: number) => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`
    writeFileSync(join(backups, `flow-${stamp}-000000.db`), '')
  }
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
  const issue = async (actor: string, o: { note?: string; remote?: boolean } = {}) => {
    const r = await call('/v1/hub/tokens', { body: { actor, ...o } })
    expect(r.status).toBe(201)
    return r.body.data as { token: { id: string; actor: string }; secret: string }
  }
  /** 以本机节点（user token、不声明身份）的方式建立一个 blocked 或持有租约的任务。 */
  const leased = async (nodeId = 'n1', o: { token?: string; actor?: string } = {}) => {
    const created = await call('/v1/tasks', {
      body: { ...contract, idempotency_key: `k-${Math.random()}` },
    })
    const taskId = (created.body.data as { task: { id: string } }).task.id
    const reg = await call('/v1/nodes', {
      ...o,
      body: { node_id: nodeId, hostname: 'h', version: '0', capabilities: ['executor:fake'] },
    })
    expect(reg.status).toBe(200)
    const lease = (
      await call('/v1/leases', {
        ...o,
        body: { node_id: nodeId, capabilities: ['executor:fake'], wait_s: 0 },
      })
    ).body.data as { lease: { lease_id: string; lease_token: string; task_id: string } }
    expect(lease.lease.task_id).toBe(taskId)
    return { taskId, lease: lease.lease }
  }
  return { home, call, seq, issue, leased, userToken }
}

const contract = { goal: '测试', workspace: 'ws/demo', role: 'dev', executor: 'fake' }

describe('Token 认证（hub-daemon 增量）', () => {
  test('缺少 token：401 unauthorized', async () => {
    const { call } = await start()
    const r = await call('/v1/tasks', { token: null })
    expect(r).toMatchObject({ status: 401, body: { error: { code: 'unauthorized' } } })
  })

  test('user token：不声明为 user，可降级声明 AI 身份', async () => {
    const { call } = await start()
    const a = await call('/v1/tasks', { body: contract })
    expect(a.body.data).toMatchObject({ task: { created_by: 'user' } })
    const b = await call('/v1/tasks', {
      actor: 'codex',
      body: { ...contract, idempotency_key: 'k2' },
    })
    expect(b.body.data).toMatchObject({ task: { created_by: 'codex' } })
  })

  test('user token 不能声明保留身份（不区分大小写）或 node:*，不产生事件', async () => {
    const { call, seq } = await start()
    const before = await seq()
    for (const actor of ['hub', 'Scheduler', 'POLICY', 'unknown', 'USER', 'node:n1', 'Node:n1']) {
      const r = await call('/v1/tasks', { actor, body: contract })
      expect(r).toMatchObject({ status: 403, body: { error: { code: 'reserved_actor' } } })
    }
    expect(await seq()).toBe(before)
  })

  test('绑定 token 冒充用户：403 actor_mismatch，不产生任何事件', async () => {
    const { call, seq, issue } = await start()
    const { secret } = await issue('grok', { note: 'Grok Bot', remote: true })
    expect(secret.startsWith(BOUND_TOKEN_PREFIX)).toBe(true)
    const node = (await issue('node:n9')).secret
    const before = await seq()
    for (const [token, actor] of [
      [secret, 'user'],
      [secret, 'codex'],
      [node, 'user'],
      [node, 'node:n8'],
    ] as const) {
      const r = await call('/v1/tasks', { token, actor, body: contract })
      expect(r).toMatchObject({ status: 403, body: { error: { code: 'actor_mismatch' } } })
    }
    expect(await seq()).toBe(before)
  })

  test('remote token 在本机端口一律 403 remote_not_allowed', async () => {
    const { call, seq, issue } = await start()
    const { secret } = await issue('grok', { remote: true })
    const before = await seq()
    for (const [path, body] of [
      ['/v1/tasks', undefined],
      ['/v1/tasks', contract],
      ['/v1/events', undefined],
      ['/v1/hub/tokens', undefined],
    ] as const) {
      const r = await call(path, { token: secret, ...(body ? { body } : {}) })
      expect(r).toMatchObject({ status: 403, body: { error: { code: 'remote_not_allowed' } } })
    }
    expect(await seq()).toBe(before)
  })

  test('撤销后立即失效：401 unauthorized；list 显示撤销与最近使用时间', async () => {
    const { call, issue } = await start()
    const { secret, token } = await issue('node:n2')
    // 已认证但不在节点权限范围内：403 scope_denied（不是 401）。
    expect((await call('/v1/tasks', { token: secret })).status).toBe(403)
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

  test('token 文件：0600，只存摘要；重启后仍有效，撤销仍生效', async () => {
    const { home, issue, call } = await start()
    const a = await issue('node:remote-1', { note: '备注' })
    const b = await issue('node:remote-2')
    const c = await issue('grok', { remote: true })
    await call(`/v1/hub/tokens/${b.token.id}/revoke`, { body: {} })
    const path = hubTokensPath(home)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const text = readFileSync(path, 'utf8')
    for (const t of [a, b, c]) expect(text).not.toContain(t.secret)
    expect(text).toContain(sha256Hex(a.secret))
    const file = JSON.parse(text) as { tokens: Array<Record<string, unknown>> }
    expect(Object.keys(file.tokens[0] ?? {}).sort()).toEqual(
      ['actor', 'id', 'issued_at', 'last_used_at', 'note', 'revoked_at', 'sha256'].sort(),
    )
    expect(file.tokens[2]).toMatchObject({ actor: 'grok', remote: true })
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
    const acquire = (token: string) =>
      fetch(`${again.data.url}/v1/leases`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ node_id: 'remote-1', capabilities: [], wait_s: 0 }),
      })
    // 认证通过、在节点权限范围内（节点尚未注册，所以是 409）。
    expect((await acquire(a.secret)).status).toBe(409)
    expect((await acquire(b.secret)).status).toBe(401)
    expect((await acquire(c.secret)).status).toBe(403)
  })

  test('签发范围：只能是 node:<id> 或带 remote 标注；保留身份及其大小写变体被拒绝', async () => {
    const { call } = await start()
    const bad = [
      { actor: 'grok' },
      { actor: 'codex', remote: false },
      { actor: 'user', remote: true },
      { actor: 'User', remote: true },
      { actor: 'HUB', remote: true },
      { actor: 'policy', remote: true },
      { actor: 'Node:n1' },
      { actor: 'node:' },
      { actor: 'bad actor', remote: true },
    ]
    for (const body of bad) {
      const r = await call('/v1/hub/tokens', { body })
      expect(r).toMatchObject({ status: 400, body: { error: { code: 'invalid_arguments' } } })
    }
    for (const body of [{ actor: 'node:n1' }, { actor: 'grok', remote: true }]) {
      expect((await call('/v1/hub/tokens', { body })).status).toBe(201)
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
    const issued = await opened.data.issue({ actor: 'node:n1' })
    if (!issued.ok) throw new Error(issued.error.message)
    expect(opened.data.authenticate(issued.data.secret)).toEqual({
      id: issued.data.token.id,
      actor: 'node:n1',
      remote: false,
    })
    expect(opened.data.authenticate(`${issued.data.secret}x`)).toBeNull()
    await opened.data.close()
    const reopened = await openTokenStore(home)
    if (!reopened.ok) throw new Error(reopened.error.message)
    expect(reopened.data.list()[0]?.last_used_at).not.toBeNull()
    await reopened.data.close()
  })

  test('签发写盘失败：只撤下自己这条，并发签发不会把失败的记录复活', async () => {
    const home = await setupHome()
    const opened = await openTokenStore(home)
    if (!opened.ok) throw new Error(opened.error.message)
    const store = opened.data
    const kept = await store.issue({ actor: 'node:kept' })
    if (!kept.ok) throw new Error(kept.error.message)
    const state = flowPaths(home).state
    chmodSync(state, 0o500)
    try {
      const [x, y] = await Promise.all([
        store.issue({ actor: 'node:x' }),
        store.issue({ actor: 'node:y' }),
      ])
      expect(x).toMatchObject({ ok: false, error: { code: 'hub_tokens_write_failed' } })
      expect(y).toMatchObject({ ok: false, error: { code: 'hub_tokens_write_failed' } })
      expect(store.list().map((t) => t.actor)).toEqual(['node:kept'])
      // 写盘失败的撤销仍在内存中生效。
      const revoked = await store.revoke(kept.data.token.id)
      expect(revoked).toMatchObject({ ok: false, error: { code: 'hub_tokens_write_failed' } })
      expect(store.authenticate(kept.data.secret)).toBeNull()
    } finally {
      chmodSync(state, 0o700)
      await store.close()
    }
  })
})

describe('节点身份的权限范围', () => {
  test('node: 绑定 token 只能访问节点协议接口与自己持有租约的任务', async () => {
    const { call, issue, leased, seq } = await start()
    const { secret } = await issue('node:n1')
    const as = { token: secret }
    // 只能代表自己注册与领取。
    const other = await call('/v1/nodes', {
      ...as,
      body: { node_id: 'n2', hostname: 'h', version: '0', capabilities: ['executor:fake'] },
    })
    expect(other).toMatchObject({ status: 403, body: { error: { code: 'scope_denied' } } })
    const mine = await leased('n1', as)
    const theirs = await leased('n3')
    // 只读自己持有租约的任务详情。
    expect((await call(`/v1/tasks/${mine.taskId}`, as)).status).toBe(200)
    const peek = await call(`/v1/tasks/${theirs.taskId}`, as)
    expect(peek).toMatchObject({ status: 403, body: { error: { code: 'scope_denied' } } })
    const before = await seq()
    for (const [path, body] of [
      ['/v1/tasks', undefined],
      ['/v1/tasks', contract],
      [`/v1/tasks/${theirs.taskId}/cancel`, {}],
      [`/v1/tasks/${mine.taskId}/reply`, { kind: 'approve' }],
      ['/v1/hub/rebuild', {}],
      ['/v1/nodes', undefined],
      ['/v1/events', undefined],
      ['/v1/hub/tokens', undefined],
    ] as const) {
      const r = await call(path, { ...as, ...(body ? { body } : {}) })
      expect(r).toMatchObject({ status: 403, body: { error: { code: 'scope_denied' } } })
    }
    expect(await seq()).toBe(before)
    // 节点协议接口照常：续约自己的租约。
    const renewed = await call(`/v1/leases/${mine.lease.lease_id}/renew`, {
      ...as,
      body: { lease_token: mine.lease.lease_token },
    })
    expect(renewed.status).toBe(200)
  })

  test('本机节点：user token 不声明身份，注册与租约事件记为 node:<id>', async () => {
    const { leased, call } = await start()
    const { taskId } = await leased('local-1')
    const events = (await call(`/v1/tasks/${taskId}`)).body.data as {
      events: Array<{ type: string; actor: string }>
    }
    expect(events.events.find((e) => e.type === 'lease.granted')?.actor).toBe('node:local-1')
  })
})

describe('只有用户能做的操作', () => {
  test('AI 批准自己的审批请求：403 user_only，任务仍为 blocked(awaiting_approval)，不产生事件', async () => {
    const { call, seq, leased } = await start()
    const { taskId, lease } = await leased()
    const renewed = await call(`/v1/leases/${lease.lease_id}/renew`, {
      body: {
        lease_token: lease.lease_token,
        blocked: { reason: 'awaiting_approval', message: '要执行 git push' },
      },
    })
    expect(renewed.status).toBe(200)
    const before = await seq()
    const r = await call(`/v1/tasks/${taskId}/reply`, { actor: 'codex', body: { kind: 'approve' } })
    expect(r).toMatchObject({ status: 403, body: { error: { code: 'user_only' } } })
    expect(await seq()).toBe(before)
    const shown = (await call(`/v1/tasks/${taskId}`)).body.data as {
      task: { status: string; blocked: { reason: string } }
    }
    expect(shown.task).toMatchObject({
      status: 'blocked',
      blocked: { reason: 'awaiting_approval' },
    })
    const byUser = await call(`/v1/tasks/${taskId}/reply`, { body: { kind: 'approve' } })
    expect(byUser.status).toBe(200)
  })

  test('重建投影与 token 管理：AI 身份返回 user_only', async () => {
    const { call, seq } = await start()
    const before = await seq()
    const attempts = [
      { path: '/v1/hub/rebuild', body: {} },
      { path: '/v1/hub/tokens', body: { actor: 'node:x1' } },
      { path: '/v1/hub/tokens' },
      { path: '/v1/hub/tokens/tok_000000000000/revoke', body: {} },
    ]
    for (const { path, ...o } of attempts) {
      const r = await call(path, { actor: 'codex', ...o })
      expect(r).toMatchObject({ status: 403, body: { error: { code: 'user_only' } } })
    }
    expect(await seq()).toBe(before)
    expect(((await call('/v1/hub/tokens')).body.data as { tokens: unknown[] }).tokens).toEqual([])
    expect((await call('/v1/hub/rebuild', { body: {} })).status).toBe(200)
  })
})
