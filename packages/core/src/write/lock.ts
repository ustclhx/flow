import { randomBytes } from 'node:crypto'
import { link, mkdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { flowPaths } from '../home.ts'
import { fail, ok, type Result } from '../result.ts'

/**
 * 跨进程写锁（design D5）：`state/write.lock`，同一时间只有一个写入者。
 *
 * - 获取：先把锁信息（pid、主机、时间戳、随机 token）完整写入临时文件，再用 `link()` 原子地
 *   创建锁文件。`link` 在目标已存在时以 EEXIST 失败，因此锁文件一旦出现就是完整内容。
 * - 陈旧锁：持锁进程已不存在（同一主机上 `kill(pid, 0)` 报 ESRCH）时可以接管。接管本身由
 *   `write.lock.steal` 守护（同样原子创建），守护内重新读取锁文件并确认仍是同一把陈旧锁才删除，
 *   避免两个进程同时接管时误删对方新建的锁。
 * - 释放：只删除 token 与自己一致的锁文件。
 * 只使用 Node 兼容的 API（design D12）。
 */

export const DEFAULT_LOCK_TIMEOUT_MS = 10_000

export interface LockOptions {
  /** 等待锁的最长时间，默认 10 秒；超时返回 `retryable` / `lock_timeout`。 */
  timeoutMs?: number
  /** 轮询间隔（毫秒），默认 25，实际会加随机抖动。 */
  pollMs?: number
}

export interface LockInfo {
  pid: number
  host: string
  /** 获取时间（ISO 8601）。 */
  acquired_at: string
  token: string
}

export interface WriteLock {
  readonly path: string
  readonly info: LockInfo
  /** 释放锁；重复调用无副作用。 */
  release(): Promise<void>
}

/** 锁文件无法解析（例如被人手工改坏）时，超过这个年龄就视为陈旧。 */
const CORRUPT_STALE_MS = 5_000
/** 接管守护本身遗留超过这个年龄（持有者在接管途中崩溃）时可以清除。 */
const STEAL_GUARD_STALE_MS = 5_000

export const writeLockPath = (home: string): string => join(flowPaths(home).state, 'write.lock')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const isErrno = (err: unknown, code: string): boolean =>
  (err as NodeJS.ErrnoException | undefined)?.code === code

/** 原子创建：内容先写临时文件，再 link 到目标。目标已存在返回 false。 */
async function atomicCreate(path: string, content: string): Promise<boolean> {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(tmp, content, { flag: 'wx' })
  try {
    await link(tmp, path)
    return true
  } catch (err) {
    if (isErrno(err, 'EEXIST')) return false
    throw err
  } finally {
    await unlink(tmp).catch(() => {})
  }
}

function parseInfo(text: string): LockInfo | null {
  try {
    const v = JSON.parse(text) as Partial<LockInfo>
    if (
      typeof v.pid === 'number' &&
      typeof v.host === 'string' &&
      typeof v.acquired_at === 'string' &&
      typeof v.token === 'string'
    ) {
      return v as LockInfo
    }
  } catch {}
  return null
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM：进程存在但属于别的用户，仍视为存活。
    return !isErrno(err, 'ESRCH')
  }
}

async function readLock(path: string): Promise<{ text: string; mtimeMs: number } | null> {
  try {
    const [text, st] = await Promise.all([readFile(path, 'utf8'), stat(path)])
    return { text, mtimeMs: st.mtimeMs }
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return null
    throw err
  }
}

/** 当前锁是否陈旧（持有者已不存在）。其他主机的锁无法判断，一律视为有效。 */
function isStale(lock: { text: string; mtimeMs: number }): boolean {
  const info = parseInfo(lock.text)
  if (!info) return Date.now() - lock.mtimeMs > CORRUPT_STALE_MS
  if (info.host !== hostname()) return false
  if (info.pid === process.pid) return false
  return !pidAlive(info.pid)
}

/** 在守护下删除陈旧锁。返回是否删除了（之后应立即重试获取）。 */
async function tryBreakStale(path: string, staleText: string): Promise<boolean> {
  const guard = `${path}.steal`
  if (!(await atomicCreate(guard, String(process.pid)))) {
    const g = await readLock(guard)
    if (g && Date.now() - g.mtimeMs > STEAL_GUARD_STALE_MS) await rm(guard, { force: true })
    return false
  }
  try {
    const current = await readLock(path)
    if (!current || current.text !== staleText) return current === null
    await rm(path, { force: true })
    return true
  } finally {
    await rm(guard, { force: true })
  }
}

/** 获取写锁；超时返回 `fail('retryable', 'lock_timeout', ...)`。 */
export async function acquireWriteLock(
  home: string,
  opts: LockOptions = {},
): Promise<Result<WriteLock>> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
  const pollMs = opts.pollMs ?? 25
  const path = writeLockPath(home)
  const info: LockInfo = {
    pid: process.pid,
    host: hostname(),
    acquired_at: new Date().toISOString(),
    token: randomBytes(12).toString('hex'),
  }
  const deadline = Date.now() + timeoutMs
  let holder: LockInfo | null = null
  try {
    await mkdir(flowPaths(home).state, { recursive: true })
    for (;;) {
      info.acquired_at = new Date().toISOString()
      if (await atomicCreate(path, `${JSON.stringify(info)}\n`)) {
        return ok(makeLock(path, info))
      }
      const current = await readLock(path)
      if (current) {
        holder = parseInfo(current.text)
        if (isStale(current) && (await tryBreakStale(path, current.text))) continue
      }
      if (Date.now() >= deadline) break
      await sleep(pollMs + Math.floor(Math.random() * pollMs))
    }
  } catch (err) {
    return fail('failure', 'lock_failed', `无法获取写锁 ${path}：${(err as Error).message}`)
  }
  const by = holder ? `（持有者 pid ${holder.pid}，自 ${holder.acquired_at}）` : ''
  return fail(
    'retryable',
    'lock_timeout',
    `等待写锁超时（${timeoutMs}ms）${by}，请稍后重试`,
    holder
      ? { holder: { pid: holder.pid, host: holder.host, acquired_at: holder.acquired_at } }
      : undefined,
  )
}

function makeLock(path: string, info: LockInfo): WriteLock {
  let released = false
  return {
    path,
    info,
    async release() {
      if (released) return
      released = true
      const current = await readLock(path).catch(() => null)
      if (current && parseInfo(current.text)?.token === info.token) {
        await rm(path, { force: true })
      }
    },
  }
}

/**
 * 在写锁内执行 `fn`，结束后（包括抛出异常）一定释放锁。
 * `fn` 收到锁句柄，可以传给 `commitWrite` 的 `ctx.lock`，在同一把锁内完成多步操作。
 */
export async function withWriteLock<T>(
  home: string,
  fn: (lock: WriteLock) => Promise<Result<T>>,
  opts: LockOptions = {},
): Promise<Result<T>> {
  const acquired = await acquireWriteLock(home, opts)
  if (!acquired.ok) return acquired
  try {
    return await fn(acquired.data)
  } finally {
    await acquired.data.release()
  }
}
