import { randomBytes } from 'node:crypto'
import { readFileSync, unlinkSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import {
  type Database,
  fail,
  flowPaths,
  isSqliteBusy,
  ok,
  openDatabase,
  type Result,
} from '@flow/core'
import { z } from 'zod'

/**
 * 中枢单实例锁。
 *
 * 互斥由 `state/hub.lock` 这个 SQLite 文件上的排他锁保证：开启 `BEGIN EXCLUSIVE` 且永不提交
 * （再设 `locking_mode=EXCLUSIVE` 兜底），进程存活期间一直持有。锁是操作系统层面的文件锁（unix VFS
 * 的 fcntl 字节范围锁），进程以任何方式退出（包括 kill -9）都会由内核释放，因此不存在需要"接管"
 * 的陈旧锁。同一进程内的多个连接由 SQLite 的 unix VFS 在进程内协调，同样只有一个能拿到锁。
 *
 * `state/hub.pid`（pid + token）在取得锁之后写入，只用于报错提示和 `flow daemon status`，
 * 不参与互斥；内容可能是崩溃遗留的旧值，读取方只能把它当作提示。
 *
 * 注意：POSIX 文件锁按进程归属，进程内任何对 hub.lock 的 open/close 都会让内核丢掉本进程在
 * 该文件上的全部锁。除了这里的 SQLite 连接，进程内不要用其他方式打开 hub.lock。
 */

const lockInfo = z.strictObject({ pid: z.number().int().positive(), token: z.string().min(1) })
type LockInfo = z.infer<typeof lockInfo>

export interface HubLock {
  readonly path: string
  readonly pid: number
  release(): Promise<void>
}

/**
 * 持有中的锁连接。bun:sqlite 会在 Database 对象被回收时关闭连接，从而悄悄释放锁；
 * 调用方即使丢掉 HubLock，也必须保持强引用直到 release 或进程退出。exit 监听的闭包目前也间接
 * 引用了连接，这里显式持有，不依赖这一实现细节。
 */
const held = new Set<Database>()

const isErrno = (err: unknown, code: string) => (err as NodeJS.ErrnoException)?.code === code

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM 同样表示进程存在。
    return !isErrno(err, 'ESRCH')
  }
}

/** 读取 hub.pid 作为提示：缺失、损坏或进程已不存在时返回 null。 */
async function readHolderPid(path: string): Promise<number | null> {
  try {
    const { pid } = lockInfo.parse(JSON.parse(await readFile(path, 'utf8')))
    return pidAlive(pid) ? pid : null
  } catch {
    return null
  }
}

/** 先完整写入临时文件再 rename，读取方不会看到半条记录。 */
async function writePidFile(path: string, info: LockInfo): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  try {
    await writeFile(tmp, `${JSON.stringify(info)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(tmp, path)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
}

/** 只删除仍属于自己的 pid 记录。调用时仍持有锁，其他进程不可能同时写 hub.pid，读后删除没有竞态。 */
function removeOwnPidFile(path: string, token: string): void {
  try {
    if (lockInfo.parse(JSON.parse(readFileSync(path, 'utf8'))).token === token) unlinkSync(path)
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return
    // 内容损坏或被他人改写：保留原样，不影响释放锁。
    if (err instanceof SyntaxError || err instanceof z.ZodError) return
    throw err
  }
}

/** 释放锁：回滚未提交的事务并关闭连接，内核随之释放文件锁。 */
function closeLock(db: Database): void {
  held.delete(db)
  try {
    db.exec('ROLLBACK')
  } catch {
    // 没有进行中的事务时 ROLLBACK 会报错，关闭连接即可。
  }
  db.close()
}

/**
 * 同时起步的竞争者可能互相挡住而全部失败：BEGIN EXCLUSIVE 要先取 SHARED 再升级，几个进程同时
 * 持有 SHARED 时谁都升级不了，busy_timeout=0 下全部立即返回 BUSY，结果没有任何赢家。
 * 因此在这个短窗口内带随机抖动重试；真有存活持有者时，失败报告最多延迟这么久。
 */
const CONTENTION_WINDOW_MS = 300

/** 尝试一次取锁：成功返回持锁连接，被占用返回 null。每次用新连接，失败的连接不残留任何锁。 */
async function tryLockOnce(path: string): Promise<Database | null> {
  // 不用 WAL：WAL 的写锁在 -shm 上，回滚日志模式下 BEGIN EXCLUSIVE 直接锁住数据库文件本身。
  // busy_timeout=0：被占用时立即返回 SQLITE_BUSY，重试节奏由调用方控制。
  const db = await openDatabase(path, { wal: false, busyTimeoutMs: 0 })
  try {
    db.exec('BEGIN EXCLUSIVE')
  } catch (err) {
    db.close()
    if (isSqliteBusy(err)) return null
    throw err
  }
  try {
    // 事务永不提交，锁已经一直持有；EXCLUSIVE 模式再兜底：即使事务意外结束，连接也不放锁。
    db.exec('PRAGMA locking_mode = EXCLUSIVE')
  } catch (err) {
    closeLock(db)
    throw err
  }
  return db
}

/** 同一个 flow-home 只能有一个中枢；锁被存活进程持有时失败，不等待持有者退出。 */
export async function acquireHubLock(home: string): Promise<Result<HubLock>> {
  const paths = flowPaths(home)
  const info: LockInfo = { pid: process.pid, token: randomBytes(16).toString('hex') }
  let db: Database | null = null
  try {
    await mkdir(paths.state, { recursive: true })
    const deadline = Date.now() + CONTENTION_WINDOW_MS
    for (;;) {
      db = await tryLockOnce(paths.hubLock)
      if (db || Date.now() >= deadline) break
      await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 25))
    }
    if (!db) {
      const pid = await readHolderPid(paths.hubPid)
      return pid === null
        ? fail('failure', 'hub_already_running', '中枢已在运行')
        : fail('failure', 'hub_already_running', `中枢已在运行（pid ${pid}）`, { pid })
    }
    held.add(db)
    await writePidFile(paths.hubPid, info)
  } catch (err) {
    if (db) {
      try {
        closeLock(db)
      } catch {
        // 已经在报告获取失败，关闭失败不再覆盖原错误。
      }
    }
    return fail('failure', 'hub_lock_failed', `无法获取中枢锁：${(err as Error).message}`)
  }

  const lockDb: Database = db
  let released = false
  const releaseSync = () => {
    if (released) return
    released = true
    process.off('exit', onExit)
    // 先删 pid 记录再放锁：放锁之后别的中枢可能已经写入了自己的 hub.pid。
    try {
      removeOwnPidFile(paths.hubPid, info.token)
    } finally {
      closeLock(lockDb)
    }
  }
  // exit 不允许异步工作；文件锁本身会由内核释放，这里只清理 hub.pid。
  const onExit = () => {
    try {
      releaseSync()
    } catch (err) {
      console.warn('释放中枢锁失败', err)
    }
  }
  process.once('exit', onExit)
  return ok({
    path: paths.hubLock,
    pid: info.pid,
    release: async () => releaseSync(),
  })
}
