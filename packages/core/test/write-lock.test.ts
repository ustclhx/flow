import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { git } from '../src/git.ts'
import { exitCodeOf } from '../src/result.ts'
import { appendJournal } from '../src/write/api.ts'
import { acquireWriteLock, withWriteLock, writeLockPath } from '../src/write/lock.ts'
import { commitCount, initTempHome, tempHome } from './helpers.ts'

const WRITER = join(import.meta.dir, 'fixtures', 'journal-writer.ts')

/** 一个肯定不存在的 pid：先起一个子进程，等它退出后拿它的 pid。 */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  const pid = child.pid as number
  await new Promise((r) => child.on('exit', r))
  return pid
}

function runWriter(home: string, actor: string, startAt: number, lines: number) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [WRITER, home, actor, String(startAt), String(lines)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      stdout += d
    })
    child.stderr.setEncoding('utf8').on('data', (d: string) => {
      stderr += d
    })
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

describe('写锁', () => {
  test('获取后锁文件记录 pid 与时间戳，释放后删除', async () => {
    const home = tempHome('flow-lock-')
    const r = await acquireWriteLock(home)
    if (!r.ok) throw new Error(r.error.message)
    const info = JSON.parse(readFileSync(writeLockPath(home), 'utf8'))
    expect(info.pid).toBe(process.pid)
    expect(info.host).toBe(hostname())
    expect(Number.isNaN(Date.parse(info.acquired_at))).toBe(false)
    await r.data.release()
    expect(existsSync(writeLockPath(home))).toBe(false)
    await r.data.release() // 重复释放无副作用
  })

  test('锁被占用时等待超时，返回可重试的 lock_timeout（退出码 3）', async () => {
    const home = tempHome('flow-lock-')
    const held = await acquireWriteLock(home)
    if (!held.ok) throw new Error(held.error.message)
    const started = Date.now()
    const r = await acquireWriteLock(home, { timeoutMs: 150 })
    expect(Date.now() - started).toBeGreaterThanOrEqual(140)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('retryable')
    expect(r.error.code).toBe('lock_timeout')
    expect(exitCodeOf(r)).toBe(3)
    await held.data.release()
  })

  test('写入路径在锁被占用时返回 lock_timeout，不写任何东西', async () => {
    const home = await initTempHome()
    const held = await acquireWriteLock(home)
    if (!held.ok) throw new Error(held.error.message)
    const before = await commitCount(join(home, 'brain'))
    const r = await appendJournal(home, { text: 'x' }, { actor: 'codex', lockTimeoutMs: 100 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('lock_timeout')
    expect(existsSync(join(home, 'brain', 'journal'))).toBe(false)
    expect(await commitCount(join(home, 'brain'))).toBe(before)
    await held.data.release()
  })

  test('锁释放后等待者立即获得锁', async () => {
    const home = tempHome('flow-lock-')
    const held = await acquireWriteLock(home)
    if (!held.ok) throw new Error(held.error.message)
    setTimeout(() => void held.data.release(), 100)
    const r = await acquireWriteLock(home, { timeoutMs: 2000 })
    expect(r.ok).toBe(true)
    if (r.ok) await r.data.release()
  })

  test('持锁进程已崩溃（pid 不存在）的陈旧锁可以被接管', async () => {
    const home = tempHome('flow-lock-')
    mkdirSync(join(home, 'state'), { recursive: true })
    const stale = {
      pid: await deadPid(),
      host: hostname(),
      acquired_at: '2026-01-01T00:00:00.000Z',
      token: 'dead',
    }
    writeFileSync(writeLockPath(home), JSON.stringify(stale))
    const r = await acquireWriteLock(home, { timeoutMs: 500 })
    if (!r.ok) throw new Error(r.error.message)
    expect(JSON.parse(readFileSync(writeLockPath(home), 'utf8')).pid).toBe(process.pid)
    await r.data.release()
  })

  test('存活进程持有的锁不会被接管', async () => {
    const home = tempHome('flow-lock-')
    mkdirSync(join(home, 'state'), { recursive: true })
    // 父进程（bun test 的启动者）一定存活。
    const alive = { pid: process.ppid, host: hostname(), acquired_at: 'x', token: 'alive' }
    writeFileSync(writeLockPath(home), JSON.stringify(alive))
    const r = await acquireWriteLock(home, { timeoutMs: 100 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('lock_timeout')
    expect(JSON.parse(readFileSync(writeLockPath(home), 'utf8')).token).toBe('alive')
  })

  test('无法解析的陈旧锁文件超过一定时间后可以被接管', async () => {
    const home = tempHome('flow-lock-')
    mkdirSync(join(home, 'state'), { recursive: true })
    writeFileSync(writeLockPath(home), 'garbage')
    const old = new Date(Date.now() - 60_000)
    utimesSync(writeLockPath(home), old, old)
    const r = await acquireWriteLock(home, { timeoutMs: 500 })
    expect(r.ok).toBe(true)
    if (r.ok) await r.data.release()
  })

  test('释放时只删除自己的锁', async () => {
    const home = tempHome('flow-lock-')
    const r = await acquireWriteLock(home)
    if (!r.ok) throw new Error(r.error.message)
    writeFileSync(
      writeLockPath(home),
      JSON.stringify({ pid: process.pid, host: hostname(), acquired_at: 'x', token: 'other' }),
    )
    await r.data.release()
    expect(existsSync(writeLockPath(home))).toBe(true)
  })

  test('withWriteLock 在回调抛错时也释放锁', async () => {
    const home = tempHome('flow-lock-')
    await expect(
      withWriteLock(home, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(existsSync(writeLockPath(home))).toBe(false)
  })

  test('两个真实子进程并发追加 journal：两条记录都完整写入、互不交错，各一次提交', async () => {
    const home = await initTempHome('flow-lock-concurrent-')
    const brain = join(home, 'brain')
    const before = await commitCount(brain)
    const startAt = Date.now() + 800
    const lines = 200
    const [a, b] = await Promise.all([
      runWriter(home, 'claude', startAt, lines),
      runWriter(home, 'codex', startAt, lines),
    ])
    for (const r of [a, b]) {
      expect(r.stderr).toBe('')
      expect(r.code).toBe(0)
      expect(JSON.parse(r.stdout).ok).toBe(true)
    }
    const file = JSON.parse(a.stdout).data.file as string
    const text = readFileSync(join(home, file), 'utf8')
    for (const actor of ['claude', 'codex']) {
      const block = Array.from({ length: lines }, (_, i) => `${actor} 第 ${i + 1} 行`).join('\n')
      expect(text).toContain(`${block}\n`)
    }
    expect(text.match(/^## /gm)?.length).toBe(2)
    expect(text.match(/^# \d{4}-\d{2}-\d{2}$/gm)?.length).toBe(1)
    expect(await commitCount(brain)).toBe(before + 2)
    const log = readFileSync(join(brain, 'log.md'), 'utf8')
    expect(log.match(/ journal (claude|codex) /g)?.length).toBe(2)
    expect((await git(brain, ['status', '--porcelain'])).stdout).toBe('')
    expect(existsSync(writeLockPath(home))).toBe(false)
  }, 30_000)
})
