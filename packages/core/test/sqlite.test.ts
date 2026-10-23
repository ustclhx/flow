import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/sqlite.ts'

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

test('FTS5 trigram 分词器可用（design D2 依赖）', async () => {
  const db = await openDatabase(':memory:')
  db.exec("CREATE VIRTUAL TABLE f USING fts5(body, tokenize='trigram')")
  db.prepare('INSERT INTO f VALUES (?)').run('东方站品牌：干支日')
  expect(db.prepare('SELECT body FROM f WHERE f MATCH \'"干支日"\'').all()).toHaveLength(1)
  db.close()
})
