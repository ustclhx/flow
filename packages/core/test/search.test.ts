import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync, statSync, unlinkSync, utimesSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { initFlowHome } from '../src/init.ts'
import { kbGetOp, kbQueryOp, kbSearchOp } from '../src/ops/search.ts'
import type { Result } from '../src/result.ts'
import { kbGetOutput, kbQueryOutput, kbSearchOutput } from '../src/schema/search.ts'
import { syncIndex } from '../src/search/index-db.ts'
import { openDatabase } from '../src/sqlite.ts'
import { tempHome, writeEntry, writeText } from './helpers.ts'

function data<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.error))
  return result.data
}

describe('检索、读取与结构化查询', () => {
  let home: string
  let previousHome: string | undefined
  const context = () => ({ home, actor: 'codex', via: 'mcp' as const })
  const search = async (query: string) => data(await kbSearchOp.run({ query }, context())).results
  const query = async (...filters: string[]) =>
    data(await kbQueryOp.run({ filters }, context())).results
  beforeEach(async () => {
    home = tempHome('flow-search-')
    previousHome = process.env.FLOW_HOME
    process.env.FLOW_HOME = home
    data(await initFlowHome(home))
    writeEntry(
      home,
      'products/east',
      {
        type: 'product',
        title: '东方站',
        summary: '干支日产品与域名',
        scope: 'work',
        workspace: 'ws/xuanxue-saas',
        status: 'live',
        tags: ['历法', '中文'],
      },
      '东方站提供干支日查询。\n',
    )
    for (const [id, owner] of [
      ['a', 'xuanxue-saas'],
      ['b', 'product-res'],
      ['c', 'xuanxue-saas'],
    ]) {
      writeEntry(home, `sources/${id}`, {
        type: 'data-source',
        title: `数据源 ${id}`,
        summary: '监控',
        scope: 'work',
        owner: `ws/${owner}`,
        provider: 'sentry',
        sources: ['用户确认'],
      })
    }
  })
  afterEach(() => {
    if (previousHome === undefined) delete process.env.FLOW_HOME
    else process.env.FLOW_HOME = previousHome
    rmSync(dirname(home), { recursive: true, force: true })
  })

  test('中文检索：三字 trigram 与两字 LIKE 都返回完整摘要和匹配片段', async () => {
    for (const term of ['干支日', '域名']) {
      const results = await search(term)
      expect(results.map((r) => r.id)).toEqual(['products/east'])
      expect(results[0]).toMatchObject({
        type: 'product',
        title: '东方站',
        summary: '干支日产品与域名',
      })
      expect(results[0]?.snippet).toContain(term)
      expect(kbSearchOutput.safeParse({ results }).success).toBe(true)
    }
  })

  test('frontmatter 的其他标量和数组值也能全文匹配', async () => {
    writeEntry(
      home,
      'notes/fields',
      {
        type: 'note',
        title: '字段测试',
        summary: '',
        alias: '干支日',
        tags: ['域名'],
      },
      '正文没有关键词',
    )
    for (const term of ['干支日', '域名']) {
      expect((await search(term)).map((r) => r.id)).toContain('notes/fields')
    }
  })

  test('按字段查询：多条件 AND、数组包含、重复字段、标量值和稳定 id 顺序', async () => {
    const results = await query('type=data-source', 'owner=ws/xuanxue-saas')
    expect(results.map((r) => r.id)).toEqual(['sources/a', 'sources/c'])
    expect(kbQueryOutput.safeParse({ results }).success).toBe(true)
    expect((await query('tags=中文', 'tags=历法')).map((r) => r.id)).toEqual(['products/east'])
    expect(await query('tags=中文', 'tags=不存在')).toEqual([])
    writeEntry(home, 'notes/values', {
      type: 'note',
      title: '值测试',
      summary: '',
      active: false,
      count: 3,
      empty: null,
      code: 'a=b',
    })
    expect(
      (await query('active=false', 'count=3', 'empty=null', 'code=a=b')).map((r) => r.id),
    ).toEqual(['notes/values'])
    expect(await query("owner=' OR 1=1 --")).toEqual([])
  })

  test('过滤条件格式不合法时返回稳定的 invalid_filter 用法错误', async () => {
    for (const filters of [[], ['type'], ['=value'], ['owner='], ['owner= '], ['bad key=value']]) {
      expect(await kbQueryOp.run({ filters }, context())).toMatchObject({
        ok: false,
        error: { kind: 'usage', code: 'invalid_filter' },
      })
    }
  })

  test('读取原始 frontmatter、正文和相对文件路径，缺失 id 返回 not_found', async () => {
    const entry = data(await kbGetOp.run({ id: 'products/east' }, context()))
    expect(entry).toMatchObject({
      id: 'products/east',
      type: 'product',
      file: 'brain/products/east.md',
      body: '东方站提供干支日查询。\n',
      frontmatter: { tags: ['历法', '中文'] },
    })
    expect(kbGetOutput.safeParse(entry).success).toBe(true)
    for (const id of ['missing', '../AGENTS', '../../etc/passwd']) {
      expect(await kbGetOp.run({ id }, context())).toMatchObject({
        ok: false,
        error: { kind: 'failure', code: 'not_found' },
      })
    }
  })

  test('增量同步检测相同 mtime 的内容修改，并清除旧的全文和字段值', async () => {
    expect((await search('干支日')).length).toBe(1)
    const file = join(home, 'brain/products/east.md')
    const before = statSync(file)
    writeEntry(
      home,
      'products/east',
      {
        type: 'product',
        title: '新品牌',
        summary: '新历法',
        owner: 'ws/product-res',
      },
      '新历法查询',
    )
    utimesSync(file, before.atime, before.mtime)
    expect((await search('新历法')).map((r) => r.id)).toEqual(['products/east'])
    expect(await search('干支日')).toEqual([])
    expect(await query('tags=中文')).toEqual([])
    expect((await query('owner=ws/product-res')).map((r) => r.id)).toEqual([
      'products/east',
      'sources/b',
    ])
  })

  test('增量同步发现新增和删除，且每次结构化查询也先同步', async () => {
    await search('干支日')
    writeEntry(home, 'notes/new', {
      type: 'note',
      title: '新增内容',
      summary: '',
      tags: ['新标签'],
    })
    expect((await query('tags=新标签')).map((r) => r.id)).toEqual(['notes/new'])
    expect((await search('新增内容')).map((r) => r.id)).toEqual(['notes/new'])
    unlinkSync(join(home, 'brain/notes/new.md'))
    expect(await search('新增内容')).toEqual([])
    expect(await query('tags=新标签')).toEqual([])
  })

  test('删除 index.db 后自动重建，版本不匹配时也整体重建', async () => {
    const expected = await search('干支日')
    const file = join(home, 'state/index.db')
    unlinkSync(file)
    expect(await search('干支日')).toEqual(expected)
    const db = await openDatabase(file)
    db.exec("UPDATE entries SET title = '错误缓存'; PRAGMA user_version = 0")
    db.close()
    expect(await search('干支日')).toEqual(expected)
  })

  test('journal 可检索、读取、过滤，默认排在普通条目之后，删除后也同步移除', async () => {
    writeText(join(home, 'brain/journal/2026-10-24.md'), '# 日志\n\n干支日部署完成\n')
    expect((await search('干支日')).map((r) => r.id)).toEqual([
      'products/east',
      'journal/2026-10-24',
    ])
    const without = data(
      await kbSearchOp.run({ query: '干支日', includeJournal: false }, context()),
    )
    expect(without.results.map((r) => r.id)).toEqual(['products/east'])
    const journals = data(await kbSearchOp.run({ query: '干支日', type: 'journal' }, context()))
    expect(journals.results.map((r) => r.id)).toEqual(['journal/2026-10-24'])
    expect(data(await kbGetOp.run({ id: 'journal/2026-10-24' }, context()))).toMatchObject({
      type: 'journal',
      frontmatter: { type: 'journal' },
      body: '# 日志\n\n干支日部署完成\n',
    })
    unlinkSync(join(home, 'brain/journal/2026-10-24.md'))
    expect(await query('type=journal')).toEqual([])
  })

  test('FTS 操作符和 LIKE 通配符全部作为字面短语，不报错也不扩大结果', async () => {
    writeEntry(
      home,
      'notes/literal',
      { type: 'note', title: '字面值', summary: '' },
      'a"b 星号* 保留OR 单独% 下划_ 路径\\ 干支日 OR 不存在',
    )
    for (const term of ['"', '*', 'OR', 'a"b', '%', '_', '\\', '干支日 OR 不存在']) {
      const output = data(await kbSearchOp.run({ query: term, type: 'note' }, context()))
      expect(output.results.map((r) => r.id)).toEqual(['notes/literal'])
    }
    expect(await search('干支日 OR 未收录')).toEqual([])
    for (const term of ['"""', '***', 'OR*', 'NEAR(a b)']) {
      expect(await search(term)).toEqual([])
    }
  })

  test('按相关度排序，支持类型和数量限制，human 输出包含缩进片段', async () => {
    writeEntry(home, 'notes/body', { type: 'note', title: '正文匹配', summary: '' }, '干支日')
    writeEntry(home, 'notes/title', { type: 'note', title: '干支日', summary: '' }, '其他内容')
    const output = data(
      await kbSearchOp.run({ query: '干支日', type: 'note', limit: 1 }, context()),
    )
    expect(output.results.map((r) => r.id)).toEqual(['notes/title'])
    expect(kbSearchOp.human?.(output)).toBe('notes/title — 干支日：\n  干支日')
  })

  test('未初始化时返回 not_initialized', async () => {
    expect(await syncIndex(join(home, 'missing'))).toMatchObject({
      ok: false,
      error: { code: 'not_initialized' },
    })
  })
})
