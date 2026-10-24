import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isSqliteBusy, openDatabase } from '../src/sqlite.ts'

test('薄封装支持 exec / prepare / transaction，且开启 WAL', async () => {
  const db = await openDatabase(join(mkdtempSync(join(tmpdir(), 'flow-sqlite-')), 't.db'))
  db.exec('CREATE TABLE t (k TEXT PRIMARY KEY, v INTEGER)')
  db.transaction(() => {
    db.prepare('INSERT INTO t VALUES (?, ?)').run('a', 1)
    db.prepare('INSERT INTO t VALUES (?, ?)').run('b', 2)
  })
  expect(db.prepare('SELECT v FROM t WHERE k = ?').get('b')).toEqual({ v: 2 })
  expect(db.prepare('SELECT count(*) AS n FROM t').all()).toEqual([{ n: 2 }])
  expect(() =>
    db.transaction(() => {
      db.prepare('INSERT INTO t VALUES (?, ?)').run('c', 3)
      throw new Error('rollback')
    }),
  ).toThrow('rollback')
  expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 2 })
  expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
  db.close()
})

test('可关闭 WAL 并设置 busy_timeout=0；排他锁被占用时立即报 SQLITE_BUSY', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'flow-sqlite-')), 'lock.db')
  const options = { wal: false, busyTimeoutMs: 0 }
  const first = await openDatabase(path, options)
  const second = await openDatabase(path, options)
  expect(first.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' })
  expect(first.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 0 })
  first.exec('BEGIN EXCLUSIVE')
  let caught: unknown
  try {
    second.exec('BEGIN EXCLUSIVE')
  } catch (err) {
    caught = err
  }
  expect(isSqliteBusy(caught)).toBe(true)
  expect(isSqliteBusy(new Error('database is locked'))).toBe(false)
  first.close()
  second.exec('BEGIN EXCLUSIVE')
  second.close()
})

test('FTS5 trigram 分词器可用（design D2 依赖）', async () => {
  const db = await openDatabase(':memory:')
  db.exec("CREATE VIRTUAL TABLE f USING fts5(body, tokenize='trigram')")
  db.prepare('INSERT INTO f VALUES (?)').run('东方站品牌：干支日')
  expect(db.prepare('SELECT body FROM f WHERE f MATCH \'"干支日"\'').all()).toHaveLength(1)
  db.close()
})
