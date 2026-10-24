import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { errorBody, flowPaths } from '@flow/core'
import { Hono } from 'hono'
import { createHubApp, ensureHubToken } from '../src/index.ts'
import { authHeaders, testToken } from './server-fixtures.ts'

let home: string
let previousHome: string | undefined
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'flow-hub-auth-'))
  previousHome = process.env.FLOW_HOME
  process.env.FLOW_HOME = home
})
afterEach(async () => {
  if (previousHome === undefined) delete process.env.FLOW_HOME
  else process.env.FLOW_HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

test('token：32 字节随机值、0600、并发初始化后复用已有 token', async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () => ensureHubToken(home)))
  const tokens = results.map((result) => {
    if (!result.ok) throw new Error(result.error.message)
    expect(Buffer.from(result.data, 'base64url').length).toBeGreaterThanOrEqual(32)
    return result.data
  })
  expect(new Set(tokens).size).toBe(1)
  const path = flowPaths(home).hubToken
  expect((await stat(path)).mode & 0o777).toBe(0o600)
  const otherHome = await mkdtemp(join(home, 'other-'))
  const other = await ensureHubToken(otherHome)
  expect(other.ok && other.data).not.toBe(tokens[0])
})

describe('认证与操作者', () => {
  function app() {
    const child = new Hono()
    child.get('/tasks', (c) => c.json({ actor: c.get('actor') }))
    return createHubApp({ token: testToken, mount: [{ path: '/v1', app: child }] })
  }
  test.each([undefined, 'Basic abc', `Bearer ${'y'.repeat(43)}`, 'Bearer short', 'Bearer'])(
    '错误凭证 %s 返回相同的 401',
    async (header) => {
      const response = await app().request('/v1/tasks', {
        headers: header ? { Authorization: header } : {},
      })
      expect(response.status).toBe(401)
      expect(errorBody.parse(await response.json())).toEqual({
        ok: false,
        error: { kind: 'failure', code: 'unauthorized', message: '未授权', retryable: false },
      })
    },
  )
  test('只有 GET health 免认证，未注册 /v1 路由也先认证', async () => {
    expect((await app().request('/v1/health')).status).toBe(200)
    expect((await app().request('/v1/health', { method: 'POST' })).status).toBe(401)
    expect((await app().request('/v1/not-found')).status).toBe(401)
    expect((await app().request('/v1/not-found', { headers: authHeaders })).status).toBe(404)
  })
  test('子应用能读取 actor：user token 缺省为 user，可降级声明；不合法 actor 被拒绝', async () => {
    expect(await (await app().request('/v1/tasks', { headers: authHeaders })).json()).toEqual({
      actor: 'user',
    })
    expect(
      await (
        await app().request('/v1/tasks', {
          headers: { ...authHeaders, 'X-Flow-Actor': 'agent:codex' },
        })
      ).json(),
    ).toEqual({ actor: 'agent:codex' })
    expect(
      (
        await app().request('/v1/tasks', {
          headers: { ...authHeaders, 'X-Flow-Actor': 'bad actor' },
        })
      ).status,
    ).toBe(400)
  })
})
