import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { healthData, okBody, raindownPaths } from '@raindown/core'
import { Hono } from 'hono'
import { acquireHubLock, type RunningHub, startHub } from '../src/index.ts'
import { event, FakeClock, MemoryLedger, sseReader } from './server-fixtures.ts'

let home: string
let previousHome: string | undefined
let hub: RunningHub | undefined
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'raindown-hub-start-'))
  previousHome = process.env.RAINDOWN_HOME
  process.env.RAINDOWN_HOME = home
})
afterEach(async () => {
  await hub?.stop()
  hub = undefined
  if (previousHome === undefined) delete process.env.RAINDOWN_HOME
  else process.env.RAINDOWN_HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

test.each(['bun', 'node'] as const)(
  'startHub %s：锁后打开账本，组合认证/路由/SSE，stop 完整清理',
  async (runtime) => {
    const clock = new FakeClock(new Date(2026, 9, 24, 1).getTime())
    const ledger = new MemoryLedger()
    ledger.append(event(10))
    let closed = 0
    let opens = 0
    const child = new Hono()
    child.get('/actor', (c) => c.json({ actor: c.get('actor') }))
    const options = {
      home,
      port: 0,
      runtime,
      clock,
      mount: [{ path: '/v1', app: child }],
      openLedger: async () => {
        opens++
        expect(await acquireHubLock(home)).toMatchObject({
          ok: false,
          error: { code: 'hub_already_running' },
        })
        return Object.assign(ledger, {
          close: () => {
            closed++
          },
          backupTo: () => {},
        })
      },
    }
    const result = await startHub(options)
    if (!result.ok) throw new Error(result.error.message)
    hub = result.data
    const token = (await readFile(raindownPaths(home).hubToken, 'utf8')).trim()
    const headers = { Authorization: `Bearer ${token}` }
    expect(
      okBody(healthData).parse(await (await fetch(`${hub.url}/v1/health`)).json()).data.ledger_seq,
    ).toBe(10)
    expect((await fetch(`${hub.url}/v1/actor`)).status).toBe(401)
    expect(await (await fetch(`${hub.url}/v1/actor`, { headers })).json()).toEqual({
      actor: 'user',
    })
    expect(await startHub(options)).toMatchObject({
      ok: false,
      error: { code: 'hub_already_running', details: { pid: process.pid } },
    })
    expect(opens).toBe(1)
    const stream = sseReader(await fetch(`${hub.url}/v1/events?after=9`, { headers }))
    expect((await stream.next()).split('\n')).toContain('id: 10')
    await Promise.all([hub.stop(), hub.stop()])
    expect(closed).toBe(1)
    expect(ledger.listeners.size).toBe(0)
    expect(clock.pending).toBe(0)
    await stream.cancel()
    await expect(stat(raindownPaths(home).hubPid)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fetch(`${hub.url}/v1/health`)).rejects.toThrow()
  },
)

test('配置不合法时返回 failure 并释放锁，不打开账本', async () => {
  await mkdir(raindownPaths(home).config, { recursive: true })
  await writeFile(raindownPaths(home).hubConfig, 'port: broken')
  let opened = false
  const result = await startHub({
    home,
    openLedger: () => {
      opened = true
      throw new Error('不应打开')
    },
  })
  expect(result).toMatchObject({ ok: false, error: { code: 'invalid_config' } })
  expect(opened).toBe(false)
  await expect(stat(raindownPaths(home).hubPid)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('监听失败时关闭已打开账本并释放该 home 的锁', async () => {
  const result = await startHub({ home, port: 0 })
  if (!result.ok) throw new Error(result.error.message)
  hub = result.data
  const secondHome = join(home, 'second')
  let closed = false
  const failed = await startHub({
    home: secondHome,
    port: hub.port,
    ledger: Object.assign(new MemoryLedger(), {
      backupTo: () => {},
      close: () => {
        closed = true
      },
    }),
  })
  expect(failed).toMatchObject({ ok: false, error: { code: 'hub_start_failed' } })
  expect(closed).toBe(true)
  await expect(stat(raindownPaths(secondHome).hubPid)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('只有旧 flow.db 时拒绝启动，保留全部数据库文件且不打开空账本', async () => {
  const paths = raindownPaths(home)
  await mkdir(paths.state, { recursive: true })
  for (const suffix of ['', '-wal', '-shm'])
    await writeFile(join(paths.state, `flow.db${suffix}`), `old${suffix}`)
  let opened = false
  const result = await startHub({
    home,
    openLedger: () => {
      opened = true
      throw new Error('不应打开')
    },
  })
  expect(result).toMatchObject({ ok: false, error: { code: 'legacy_database_migration_required' } })
  if (result.ok) throw new Error('应该拒绝启动')
  expect(result.error.message).toContain('raindown daemon uninstall')
  expect(result.error.message).toContain('mv ')
  expect(result.error.message).toContain('-wal -shm')
  expect(opened).toBe(false)
  await expect(stat(paths.ledgerDb)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(paths.hubPid)).rejects.toMatchObject({ code: 'ENOENT' })
  for (const suffix of ['', '-wal', '-shm'])
    expect(await readFile(join(paths.state, `flow.db${suffix}`), 'utf8')).toBe(`old${suffix}`)
  // 显式完成迁移后允许启动；同时存在旧文件时使用新账本。
  await writeFile(paths.ledgerDb, 'migrated')
  const started = await startHub({ home, port: 0 })
  if (!started.ok) throw new Error(started.error.message)
  hub = started.data
})
