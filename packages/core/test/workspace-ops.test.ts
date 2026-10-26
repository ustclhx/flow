import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parseFrontmatter } from '../src/frontmatter.ts'
import { resourceTransferOp, wsBriefOp, wsListOp, wsResourcesOp } from '../src/ops/workspace.ts'
import type { Result } from '../src/result.ts'
import { renderJournalRecord, writeEntry } from '../src/write/api.ts'
import {
  writeEntry as fixtureEntry,
  initTempHome,
  isolateHub,
  snapshot,
  writeText,
  writeWorkspace,
} from './helpers.ts'

const homes: string[] = []
const restores: (() => void)[] = []
async function home() {
  const h = await initTempHome('flow-workspace-')
  // 不连真实中枢：端口不可达、清除 FLOW_HUB_TOKEN；需要中枢数据的用例注入 fetch。
  restores.push(isolateHub(h))
  homes.push(h)
  return h
}
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore()
  for (const h of homes.splice(0)) rmSync(join(h, '..'), { recursive: true, force: true })
})
const ctx = (home: string, actor = 'user') => ({ home, actor, via: 'cli' as const })
function data<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.data
}
const domain = (title: string, over: Record<string, unknown> = {}) => ({
  type: 'domain',
  title,
  summary: `${title} 的域名`,
  scope: 'work',
  owner: 'ws/xuanxue-saas',
  registrar: null,
  expires: null,
  sources: ['repo:wrangler.jsonc'],
  ...over,
})

// 简报 fixture 直接写临时 brain；生产操作仍全部通过 write/。
async function briefHome() {
  const h = await home()
  fixtureEntry(
    h,
    'cards/xuanxue',
    {
      type: 'project-card',
      title: '玄学项目',
      summary: '两个站点',
      scope: 'work',
      workspace: 'ws/xuanxue-saas',
      repo_paths: [],
    },
    '正文第 1 行\n正文第 2 行\n正文第 3 行\n正文第 4 行\n正文第 5 行\n不应包含第 6 行\n',
  )
  fixtureEntry(h, 'domains/stale', domain('过期域名', { last_verified: '2000-01-01' }))
  fixtureEntry(h, 'domains/never', domain('未核实域名'))
  fixtureEntry(h, 'domains/other', domain('其他产品域名', { owner: 'ws/product-res' }))
  fixtureEntry(h, 'products/xuanxue', {
    type: 'product',
    title: '玄学产品',
    summary: 's',
    scope: 'work',
    workspace: 'ws/xuanxue-saas',
    status: 'live',
  })
  writeText(
    join(h, 'brain/journal/2026-10-23.md'),
    '# 2026-10-23\n\n## 23:00:00 · claude · ws/xuanxue-saas\n\n昨天的相关日志\n',
  )
  writeText(
    join(h, 'brain/journal/2026-10-24.md'),
    '# 2026-10-24\n\n## 09:00:00 · codex · ws/xuanxue-saas\n\n早上的相关日志\n\n## 10:00:00 · user · ws/product-res\n\n不属于本 workspace，正文提到 ws/xuanxue-saas\n\n## 11:00:00 · claude · ws/xuanxue-saas\n\n最新相关日志\n',
  )
  return h
}

describe('workspace 操作', () => {
  test('列出 workspace：隐式 global 与两个已定义产品，包含 ref、kind、name', async () => {
    const h = await home()
    expect(data(await wsListOp.run({}, ctx(h))).workspaces).toEqual([
      { ref: 'ws/global', kind: 'global', name: 'Global' },
      { ref: 'ws/product-res', kind: 'product', name: 'product-res' },
      { ref: 'ws/xuanxue-saas', kind: 'product', name: 'xuanxue-saas' },
    ])
  })

  test('列出某产品的域名：接受两种 workspace 写法，按类型和 id 排序', async () => {
    const h = await home()
    for (const name of ['ganjiday.com', 'arcanumber.com'])
      fixtureEntry(h, `resources/domains/${name}`, domain(name))
    fixtureEntry(h, 'resources/domains/other.com', domain('other.com', { owner: 'ws/product-res' }))
    fixtureEntry(h, 'resources/accounts/x', {
      type: 'account',
      title: 'X',
      summary: '运营号',
      scope: 'work',
      owner: 'ws/xuanxue-saas',
      platform: 'x',
      handle: '@x',
    })
    const short = data(
      await wsResourcesOp.run({ workspace: 'xuanxue-saas', type: 'domain' }, ctx(h)),
    )
    expect(short).toEqual(
      data(await wsResourcesOp.run({ workspace: 'ws/xuanxue-saas', type: 'domain' }, ctx(h))),
    )
    expect(short.resources.map((r) => r.id)).toEqual([
      'resources/domains/arcanumber.com',
      'resources/domains/ganjiday.com',
    ])
    expect(short.resources[0]).toEqual({
      id: 'resources/domains/arcanumber.com',
      type: 'domain',
      title: 'arcanumber.com',
      summary: 'arcanumber.com 的域名',
    })
    expect(
      data(await wsResourcesOp.run({ workspace: 'xuanxue-saas' }, ctx(h))).resources.map(
        (r) => r.type,
      ),
    ).toEqual(['account', 'domain', 'domain'])
  })

  test('转移域名：同一锁内读写，owner-change 记录原 owner 与新 owner，保留正文', async () => {
    const h = await home()
    const id = 'resources/domains/ganjiday.com'
    data(
      await writeEntry(
        h,
        { id, frontmatter: domain('ganjiday.com'), body: '原正文\n' },
        { actor: 'user' },
      ),
    )
    const before = readFileSync(join(h, 'brain/log.md'), 'utf8')
    const r = data(await resourceTransferOp.run({ resource: id, workspace: 'product-res' }, ctx(h)))
    expect(r).toMatchObject({
      resource: id,
      previous_owner: 'ws/xuanxue-saas',
      owner: 'ws/product-res',
    })
    const parsed = data(parseFrontmatter(readFileSync(join(h, 'brain', `${id}.md`), 'utf8')))
    expect(parsed.data.owner).toBe('ws/product-res')
    expect(parsed.body).toBe('原正文\n')
    expect(readFileSync(join(h, 'brain/log.md'), 'utf8').slice(before.length)).toMatch(
      /^\d{4}-\d{2}-\d{2} owner-change user resources\/domains\/ganjiday.com ws\/xuanxue-saas → ws\/product-res\n$/,
    )
  })

  test('AI transfer 返回 user_only，未知或职能 workspace、非资源条目不能转移', async () => {
    const h = await home()
    writeWorkspace(h, 'social', {
      id: 'social',
      kind: 'function',
      name: '社媒',
      description: '社媒职能',
    })
    fixtureEntry(h, 'domains/a', domain('a'))
    fixtureEntry(h, 'notes/a', { type: 'note', title: '笔记', summary: 's', scope: 'work' })
    const before = snapshot(join(h, 'brain'))
    const ai = await resourceTransferOp.run(
      { resource: 'domains/a', workspace: 'product-res' },
      ctx(h, 'codex'),
    )
    expect(!ai.ok && ai.error.code).toBe('user_only')
    for (const [resource, workspace, code] of [
      ['domains/a', 'unknown', 'unknown_workspace'],
      ['domains/a', 'social', 'function_owner'],
      ['notes/a', 'product-res', 'not_resource'],
    ]) {
      const r = await resourceTransferOp.run(
        { resource: resource as string, workspace: workspace as string },
        ctx(h),
      )
      expect(!r.ok && r.error.code).toBe(code as string)
    }
    expect(snapshot(join(h, 'brain'))).toEqual(before)
  })

  test('简报包含描述、项目卡片前五行、资源、最近相关 journal 和本 workspace 的待核实事实', async () => {
    const h = await briefHome()
    const out = data(await wsBriefOp.run({ workspace: 'xuanxue-saas' }, ctx(h)))
    expect(out.workspace).toBe('ws/xuanxue-saas')
    expect(out.text).toContain('xuanxue-saas workspace')
    expect(out.text).toContain('两个站点')
    expect(out.text).toContain('正文第 5 行')
    expect(out.text).not.toContain('不应包含第 6 行')
    expect(out.text).toContain('可能过时：domains/stale')
    expect(out.text).toContain('从未核实：domains/never')
    expect(out.text).toContain('从未核实：products/xuanxue')
    expect(out.text).not.toContain('domains/other')
    expect(out.text).not.toContain('不属于本 workspace')
    expect(out.text.indexOf('最新相关日志')).toBeLessThan(out.text.indexOf('早上的相关日志'))
    expect(out.text.indexOf('早上的相关日志')).toBeLessThan(out.text.indexOf('昨天的相关日志'))
    const labels = [
      '# xuanxue-saas',
      '## 项目卡片',
      '## 资源列表',
      '## 最近 journal',
      '## 待核实事实',
    ]
    const indices = labels.map((v) => out.text.indexOf(v))
    expect(indices).toEqual([...indices].sort((a, b) => a - b))
    expect(out.omitted).toEqual([])
    expect(wsBriefOp.human?.(out)).toBe(out.text)
    const limited = data(await wsBriefOp.run({ workspace: 'xuanxue-saas', limit: 1 }, ctx(h)))
    expect(limited.text).toContain('最新相关日志')
    expect(limited.text).not.toContain('早上的相关日志')
  })

  test('预算截断：各节分享预算、在行边界截断，放不下时从最低优先级整节省略，footer 包含在预算中', async () => {
    const h = await briefHome()
    const full = data(await wsBriefOp.run({ workspace: 'xuanxue-saas', budget: 4000 }, ctx(h)))
    expect(full.truncated).toEqual([])
    const reduced = data(
      await wsBriefOp.run(
        { workspace: 'xuanxue-saas', budget: Math.floor(full.text.length * 0.8) },
        ctx(h),
      ),
    )
    expect(reduced.text.length).toBeLessThanOrEqual(Math.floor(full.text.length * 0.8))
    // 较长的几节平分剩余预算、各自截断并保留标题，短的节完整保留，没有整节省略。
    expect(reduced.omitted).toEqual([])
    expect(reduced.truncated).toContain('最近 journal')
    expect(reduced.truncated).not.toContain('workspace 描述')
    expect(reduced.truncated).not.toContain('项目卡片')
    expect(reduced.text).toContain('## 最近 journal')
    expect(reduced.text).toContain('最新相关日志')
    expect(reduced.text).toContain('…（本节已截断）')
    expect(reduced.text).toContain('## 待核实事实')
    for (const budget of [64, 100, 150, 250]) {
      const out = data(await wsBriefOp.run({ workspace: 'xuanxue-saas', budget }, ctx(h)))
      expect(out.text.length).toBeLessThanOrEqual(budget)
      expect(out.omitted.length).toBeGreaterThan(0)
      expect(out.text).toContain('已省略：')
      for (const section of out.omitted) expect(out.text.split('已省略：')[1]).toContain(section)
      // 整节省略从最低优先级开始：省略的总是末尾若干节。
      expect(out.text.split('已省略：')[1]).toContain('待核实事实')
    }
  })

  test('journal 默认只取最近十条，limit=0 可关闭', async () => {
    const h = await home()
    const records = Array.from({ length: 11 }, (_, i) =>
      renderJournalRecord(
        `10:${String(i).padStart(2, '0')}:00`,
        'codex',
        'ws/product-res',
        `记录-${i}-结束`,
      ),
    )
    writeText(join(h, 'brain/journal/2026-10-24.md'), `# 2026-10-24\n${records.join('')}`)
    const out = data(await wsBriefOp.run({ workspace: 'product-res' }, ctx(h)))
    expect(out.text).not.toContain('记录-0-结束')
    expect(out.text).toContain('记录-1-结束')
    expect(out.text).toContain('记录-10-结束')
    expect(
      data(await wsBriefOp.run({ workspace: 'product-res', limit: 0 }, ctx(h))).text,
    ).not.toContain('## 最近 journal')
  })
})
