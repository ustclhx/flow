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

export async function openDatabase(path: string): Promise<Database> {
  const db = isBun ? await openBun(path) : await openNode(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 5000')
  return db
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
