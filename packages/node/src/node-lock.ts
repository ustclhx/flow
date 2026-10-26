import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type Database,
  fail,
  flowPaths,
  isSqliteBusy,
  ok,
  openDatabase,
  type Result,
} from '@flow/core'

/**
 * 节点单实例锁：同一个 flow-home 同时只能运行一个节点。
 *
 * 节点启动时会清理 `state/wake/` 中的唤醒 token 文件、执行器残留的审查 worktree 等"上次运行的残留"；
 * 若同一 flow-home 上并行跑着另一个节点，这些清理会误删对方正在使用的文件。因此清理之前先取得这把锁，
 * 取不到就拒绝启动。
 *
 * 做法与中枢单实例锁（`packages/hub/src/server/lock.ts`）相同：在 `state/node.lock` 这个 SQLite 文件上
 * `BEGIN EXCLUSIVE` 且永不提交，进程以任何方式退出都会由内核释放，不存在需要按 pid 判断的陈旧锁
 * （launchd 开机拉起时 pid 可能与上次相同，按 pid 判断会误判）。进程内不要用其他方式打开该文件。
 */

export const nodeLockPath = (home: string) => join(flowPaths(home).state, 'node.lock')

export interface NodeLock {
  readonly path: string
  release(): void
}

/** 持有中的锁连接：Database 被回收会关闭连接并悄悄放锁，必须保持强引用。 */
const held = new Set<Database>()

/** 同时起步的竞争者在 SHARED → EXCLUSIVE 升级时可能全部 BUSY，在这个窗口内带抖动重试。 */
const CONTENTION_WINDOW_MS = 300

function closeLock(db: Database): void {
  held.delete(db)
  try {
    db.exec('ROLLBACK')
  } catch {
    // 没有进行中的事务时 ROLLBACK 会报错，关闭连接即可。
  }
  db.close()
}

async function tryLockOnce(path: string): Promise<Database | null> {
  const db = await openDatabase(path, { wal: false, busyTimeoutMs: 0 })
  try {
    db.exec('BEGIN EXCLUSIVE')
  } catch (err) {
    db.close()
    if (isSqliteBusy(err)) return null
    throw err
  }
  try {
    db.exec('PRAGMA locking_mode = EXCLUSIVE')
  } catch (err) {
    closeLock(db)
    throw err
  }
  return db
}

/** 取得节点单实例锁；已被（本进程或其他进程中的）另一个节点持有时返回 `node_already_running`。 */
export async function acquireNodeLock(home: string): Promise<Result<NodeLock>> {
  const path = nodeLockPath(home)
  let db: Database | null = null
  try {
    await mkdir(flowPaths(home).state, { recursive: true })
    const deadline = Date.now() + CONTENTION_WINDOW_MS
    for (;;) {
      db = await tryLockOnce(path)
      if (db || Date.now() >= deadline) break
      await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 25))
    }
  } catch (err) {
    return fail('failure', 'node_lock_failed', `无法获取节点锁 ${path}：${(err as Error).message}`)
  }
  if (!db) {
    return fail(
      'failure',
      'node_already_running',
      `同一 flow-home 上已有节点在运行（${path} 被占用）`,
    )
  }
  held.add(db)
  const lockDb = db
  let released = false
  return ok({
    path,
    release() {
      if (released) return
      released = true
      closeLock(lockDb)
    },
  })
}
