/**
 * SQLite 薄封装：业务代码只依赖这里的接口，不直接引用 `bun:sqlite`，
 * 以便必要时切换到 Node 的 `node:sqlite` 运行（design D12）。
 */

export type SqlValue = string | number | bigint | boolean | null | Uint8Array

export interface Statement {
  all(...params: SqlValue[]): unknown[]
  get(...params: SqlValue[]): unknown
  run(...params: SqlValue[]): void
}

export interface Database {
  exec(sql: string): void
  prepare(sql: string): Statement
  transaction<T>(fn: () => T): T
  close(): void
}

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'

export interface OpenDatabaseOptions {
  /** 默认启用 WAL。设为 false 保持 SQLite 默认的回滚日志模式（例如只用来持有文件锁的数据库）。 */
  wal?: boolean
  /** 等待其他连接释放锁的毫秒数，默认 5000；0 表示遇到锁立即返回 SQLITE_BUSY。 */
  busyTimeoutMs?: number
}

export async function openDatabase(
  path: string,
  options: OpenDatabaseOptions = {},
): Promise<Database> {
  const db = isBun ? await openBun(path) : await openNode(path)
  try {
    // 先设置 busy_timeout：切换 WAL 需要读库，若库被他人锁住，应按调用方给的超时等待。
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(options.busyTimeoutMs ?? 5000))}`)
    if (options.wal ?? true) db.exec('PRAGMA journal_mode = WAL')
  } catch (err) {
    db.close()
    throw err
  }
  return db
}

/** 判断错误是否为 SQLITE_BUSY（数据库被其他连接锁住）；兼容 bun:sqlite 与 node:sqlite 的错误形态。 */
export function isSqliteBusy(err: unknown): boolean {
  const e = err as { code?: unknown; errcode?: unknown; message?: unknown } | null
  if (!e || typeof e !== 'object') return false
  // bun:sqlite：code 为 'SQLITE_BUSY'；node:sqlite：errcode 为扩展结果码，低 8 位 5 即 BUSY。
  if (e.code === 'SQLITE_BUSY') return true
  if (typeof e.errcode === 'number' && (e.errcode & 0xff) === 5) return true
  return false
}

async function openBun(path: string): Promise<Database> {
  const { Database: BunDatabase } = await import('bun:sqlite')
  const db = new BunDatabase(path, { create: true })
  return {
    exec: (sql) => db.run(sql),
    prepare: (sql) => {
      const stmt = db.query(sql)
      return {
        all: (...params) => stmt.all(...params),
        get: (...params) => stmt.get(...params) ?? undefined,
        run: (...params) => {
          stmt.run(...params)
        },
      }
    },
    transaction: (fn) => db.transaction(fn)(),
    close: () => db.close(),
  }
}

async function openNode(path: string): Promise<Database> {
  // node:sqlite 在 Node 22.5+ 可用；类型按最小接口声明，避免引入 @types/node 依赖。
  type NodeStmt = {
    all(...p: unknown[]): unknown[]
    get(...p: unknown[]): unknown
    run(...p: unknown[]): unknown
  }
  type NodeDb = { exec(sql: string): void; prepare(sql: string): NodeStmt; close(): void }
  const mod = (await import('node:sqlite' as string)) as {
    DatabaseSync: new (path: string) => NodeDb
  }
  const db = new mod.DatabaseSync(path)
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const stmt = db.prepare(sql)
      return {
        all: (...params) => stmt.all(...params),
        get: (...params) => stmt.get(...params),
        run: (...params) => {
          stmt.run(...params)
        },
      }
    },
    transaction: (fn) => {
      db.exec('BEGIN')
      try {
        const out = fn()
        db.exec('COMMIT')
        return out
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    },
    close: () => db.close(),
  }
}
