import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { errorBody, flowPaths } from '@flow/core'
import { Hono } from 'hono'
import { acquireHubLock, createHubApp, ensureHubToken } from '../src/index.ts'
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

async function child(script: string): Promise<{ code: number | null; pid: number }> {
  const process = spawn(globalThis.process.execPath, ['-e', script], {
    cwd: join(import.meta.dir, '..'),
    env: { ...globalThis.process.env, FLOW_HOME: home },
    stdio: 'pipe',
  })
  const code = await new Promise<number | null>((resolve, reject) => {
    process.once('error', reject)
    process.once('exit', resolve)
  })
  if (!process.pid) throw new Error('子进程未启动')
  return { code, pid: process.pid }
}

describe('中枢单实例锁', () => {
  test('拒绝存活持有者，返回 pid；释放后可重新取得', async () => {
    const first = await acquireHubLock(home)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    try {
      expect(await acquireHubLock(home)).toMatchObject({
        ok: false,
        error: { kind: 'failure', code: 'hub_already_running', details: { pid: process.pid } },
      })
    } finally {
      await first.data.release()
    }
    await first.data.release()
    const next = await acquireHubLock(home)
    expect(next.ok).toBe(true)
    if (next.ok) await next.data.release()
  })

  test('已退出 pid 的锁可接管；释放不会删除其他持有者的锁', async () => {
    const exited = await child('')
    const paths = flowPaths(home)
    const init = await acquireHubLock(home)
    if (!init.ok) throw new Error(init.error.message)
    await init.data.release()
    await writeFile(paths.hubPid, JSON.stringify({ pid: exited.pid, token: 'old' }))
    const acquired = await acquireHubLock(home)
    expect(acquired.ok).toBe(true)
    if (!acquired.ok) return
    const replacement = JSON.stringify({ pid: process.pid, token: 'replacement' })
    await writeFile(paths.hubPid, replacement)
    await acquired.data.release()
    expect(await readFile(paths.hubPid, 'utf8')).toBe(replacement)
  })

  test('并发接管陈旧 pid 和崩溃遗留守护时，恰好一个持有者成功', async () => {
    const exited = await child('')
    const initial = await acquireHubLock(home)
    if (!initial.ok) throw new Error(initial.error.message)
    await initial.data.release()
    const path = flowPaths(home).hubPid
    const old = JSON.stringify({ pid: exited.pid, token: 'stale' })
    await writeFile(path, old)
    await writeFile(`${path}.steal`, old)
    const attempts = await Promise.all(Array.from({ length: 8 }, () => acquireHubLock(home)))
    const winners = attempts.filter((result) => result.ok)
    try {
      expect(winners).toHaveLength(1)
      for (const result of attempts.filter((result) => !result.ok)) {
        expect(result).toMatchObject({ ok: false, error: { code: 'hub_already_running' } })
      }
    } finally {
      await Promise.all(winners.map((result) => (result.ok ? result.data.release() : undefined)))
    }
  })

  test('进程正常退出释放锁', async () => {
    const result = await child(`
      import { acquireHubLock } from './src/index.ts';
      const result = await acquireHubLock(process.env.FLOW_HOME);
      if (!result.ok) process.exit(1);
    `)
    expect(result.code).toBe(0)
    await expect(stat(flowPaths(home).hubPid)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('损坏的锁安全失败，不覆盖原文件', async () => {
    const acquired = await acquireHubLock(home)
    if (!acquired.ok) throw new Error(acquired.error.message)
    await acquired.data.release()
    await writeFile(flowPaths(home).hubPid, 'broken')
    expect(await acquireHubLock(home)).toMatchObject({
      ok: false,
      error: { code: 'hub_lock_failed' },
    })
    expect(await readFile(flowPaths(home).hubPid, 'utf8')).toBe('broken')
  })
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
  test('子应用能读取 actor，缺省为 unknown；不合法 actor 被拒绝', async () => {
    expect(await (await app().request('/v1/tasks', { headers: authHeaders })).json()).toEqual({
      actor: 'unknown',
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
