import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { readBrainEntries } from '../src/entries.ts'
import { validateBrain } from '../src/validate.ts'
import { loadWorkspaces } from '../src/workspaces.ts'
import { tempHome, writeEntry, writeText, writeWorkspace } from './helpers.ts'

const TODAY = '2026-10-24'
const base = { title: 'T', summary: '一句话', scope: 'work' }
const domain = (over: Record<string, unknown> = {}) => ({
  ...base,
  type: 'domain',
  owner: 'ws/xuanxue-saas',
  registrar: null,
  expires: null,
  last_verified: null,
  sources: ['~/workspace/xuanxue-saas/apps/web/wrangler.jsonc'],
  ...over,
})

/** 一个带两个产品 workspace 与一个职能 workspace 的 flow-home。 */
function fixture(): string {
  const home = tempHome('flow-validate-')
  writeWorkspace(home, 'xuanxue-saas', {
    id: 'xuanxue-saas',
    kind: 'product',
    name: 'Xuanxue SaaS',
    description: '东方玄学站',
    repos: ['~/workspace/xuanxue-saas'],
  })
  writeWorkspace(home, 'product-res', {
    id: 'product-res',
    kind: 'product',
    name: 'Product Res',
    description: '产品资源站',
    repos: ['~/workspace/product-res'],
  })
  writeWorkspace(home, 'marketing', {
    id: 'marketing',
    kind: 'function',
    name: '市场',
    description: '职能',
  })
  writeText(join(home, 'brain', 'AGENTS.md'), '# 约定\n')
  writeText(join(home, 'brain', 'index.md'), '# 索引\n')
  writeText(join(home, 'brain', 'log.md'), '# 日志\n')
  return home
}

const validate = async (home: string, staleDays?: number) => {
  const r = await validateBrain(
    home,
    staleDays === undefined ? { today: TODAY } : { today: TODAY, staleDays },
  )
  if (!r.ok) throw new Error(r.error.message)
  return r.data
}

describe('条目格式', () => {
  test('合法条目以相对 brain 的路径（无扩展名）为标识', async () => {
    const home = fixture()
    writeEntry(home, 'resources/domains/arcanumber.com', domain())
    const entries = await readBrainEntries(home)
    expect(entries.ok && entries.data.entries.map((e) => e.id)).toEqual([
      'resources/domains/arcanumber.com',
    ])
    const r = await validate(home)
    expect(r.errors).toEqual([])
    expect(r.checked).toBe(1)
  })

  test('排除 AGENTS.md、index.md、log.md、journal/ 与隐藏文件', async () => {
    const home = fixture()
    writeText(join(home, 'brain', 'journal', '2026-10-24.md'), '- 今天做了什么\n')
    writeText(join(home, 'brain', '.draft.md'), '无 frontmatter\n')
    writeText(join(home, 'brain', '.obsidian', 'x.md'), '无 frontmatter\n')
    writeText(join(home, 'brain', 'notes', 'readme.txt'), '不是 md\n')
    writeEntry(home, 'notes/hello', { ...base, type: 'note' })
    const r = await validate(home)
    expect(r.checked).toBe(1)
    expect(r.errors).toEqual([])
  })

  test('缺少必填字段：报告条目路径与字段名', async () => {
    const home = fixture()
    const { summary: _s, ...noSummary } = domain()
    writeEntry(home, 'resources/domains/ganjiday.com', noSummary)
    const r = await validate(home)
    expect(r.errors).toEqual([
      {
        file: 'brain/resources/domains/ganjiday.com.md',
        id: 'resources/domains/ganjiday.com',
        field: 'summary',
        code: 'missing_field',
        message: '缺少必填字段 summary',
      },
    ])
  })

  test('字段类型错误与 frontmatter 问题都是错误', async () => {
    const home = fixture()
    writeEntry(home, 'a', { ...base, type: 'note', tags: 'oops' })
    writeText(join(home, 'brain', 'b.md'), '没有 frontmatter\n')
    writeText(join(home, 'brain', 'c.md'), '---\ntitle: [unclosed\n---\n')
    const r = await validate(home)
    expect(r.errors.map((e) => [e.id, e.code, e.field])).toEqual([
      ['b', 'missing_frontmatter', undefined],
      ['c', 'invalid_yaml', undefined],
      ['a', 'invalid_field', 'tags'],
    ])
  })

  test('未知类型', async () => {
    const home = fixture()
    writeEntry(home, 'things/gadget', { ...base, type: 'gadget' })
    const r = await validate(home)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toMatchObject({ code: 'unknown_type', field: 'type' })
    expect(r.errors[0]?.message).toContain('gadget')
  })

  test('decision 缺少回看日期', async () => {
    const home = fixture()
    writeEntry(home, 'decisions/pricing', {
      ...base,
      type: 'decision',
      status: 'proposed',
      expected_outcome: 'x',
      metric: 'y',
    })
    const r = await validate(home)
    expect(r.errors.map((e) => [e.code, e.field])).toEqual([['missing_field', 'review_date']])
  })
})

describe('资源归属', () => {
  test('owner 指向不存在的 workspace', async () => {
    const home = fixture()
    writeEntry(home, 'resources/domains/x.com', domain({ owner: 'ws/unknown' }))
    const r = await validate(home)
    expect(r.errors.map((e) => [e.code, e.field])).toEqual([['unknown_owner', 'owner']])
  })

  test('owner 为职能 workspace', async () => {
    const home = fixture()
    writeEntry(home, 'resources/accounts/x', {
      ...base,
      type: 'account',
      owner: 'ws/marketing',
      platform: 'x',
      handle: '@flow',
      sources: ['用户确认（2026-10-24）'],
    })
    const r = await validate(home)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]?.code).toBe('function_owner')
    expect(r.errors[0]?.message).toContain('职能 workspace 不能拥有资源')
  })

  test('ws/global 是合法 owner', async () => {
    const home = fixture()
    writeEntry(home, 'resources/accounts/gh', {
      ...base,
      type: 'account',
      owner: 'ws/global',
      platform: 'github',
      handle: 'me',
      sources: ['https://github.com/me'],
    })
    expect((await validate(home)).errors).toEqual([])
  })

  test('workspace 字段指向未定义的 workspace 也是错误', async () => {
    const home = fixture()
    writeEntry(home, 'products/x', {
      ...base,
      type: 'product',
      workspace: 'ws/nope',
      status: 'live',
      sources: ['x'],
    })
    expect((await validate(home)).errors.map((e) => e.code)).toEqual(['unknown_workspace'])
  })

  test('workspace 定义文件的问题被报告为错误', async () => {
    const home = fixture()
    writeWorkspace(home, 'broken', { id: 'broken', kind: 'product', name: 'B', description: 'd' })
    writeWorkspace(home, 'renamed', { id: 'other', kind: 'function', name: 'R', description: 'd' })
    writeWorkspace(home, 'global', { id: 'global', kind: 'function', name: 'G', description: 'd' })
    const ws = await loadWorkspaces(home)
    expect(ws.ok && ws.data.workspaces.map((w) => w.ref)).toEqual([
      'ws/global',
      'ws/marketing',
      'ws/product-res',
      'ws/xuanxue-saas',
    ])
    const r = await validate(home)
    expect(r.errors.map((e) => [e.file, e.code, e.field])).toEqual([
      ['config/workspaces/broken.yaml', 'missing_field', 'repos'],
      ['config/workspaces/global.yaml', 'workspace_reserved', 'id'],
      ['config/workspaces/renamed.yaml', 'workspace_id_mismatch', 'id'],
    ])
  })

  test('没有 config/workspaces/ 时只有 ws/global', async () => {
    const home = tempHome()
    writeText(join(home, 'brain', 'index.md'), '')
    const ws = await loadWorkspaces(home)
    expect(ws.ok && ws.data.workspaces.map((w) => w.ref)).toEqual(['ws/global'])
  })
})

describe('出处', () => {
  test('用户手写的 product 缺少出处：只警告，没有错误', async () => {
    const home = fixture()
    writeEntry(home, 'products/xuanxue', {
      ...base,
      type: 'product',
      workspace: 'ws/xuanxue-saas',
      status: 'live',
    })
    const r = await validate(home)
    expect(r.errors).toEqual([])
    expect(r.warnings.map((w) => [w.id, w.code, w.field])).toEqual([
      ['products/xuanxue', 'missing_sources', 'sources'],
    ])
    expect(r.warnings[0]?.message).toContain('事实类条目需要出处')
  })

  test('空 sources 同样警告；note 与 personal 条目不检查出处', async () => {
    const home = fixture()
    writeEntry(home, 'runbooks/deploy', { ...base, type: 'runbook', sources: [] })
    writeEntry(home, 'notes/idea', { ...base, type: 'note' })
    writeEntry(home, 'resources/accounts/mine', {
      ...base,
      scope: 'personal',
      type: 'account',
      owner: 'ws/global',
      platform: 'x',
      handle: '@me',
    })
    const r = await validate(home)
    expect(r.warnings.map((w) => w.id)).toEqual(['runbooks/deploy'])
  })
})

describe('核实时间', () => {
  test('120 天前核实的 domain 列为可能过时', async () => {
    const home = fixture()
    writeEntry(home, 'resources/domains/old.com', domain({ last_verified: '2026-06-26' }))
    writeEntry(home, 'resources/domains/fresh.com', domain({ last_verified: '2026-10-01' }))
    const r = await validate(home)
    expect(r.stale).toEqual([
      {
        id: 'resources/domains/old.com',
        file: 'brain/resources/domains/old.com.md',
        type: 'domain',
        last_verified: '2026-06-26',
        age_days: 120,
      },
    ])
    expect(r.neverVerified).toEqual([])
  })

  test('有效期可配置', async () => {
    const home = fixture()
    writeEntry(home, 'resources/domains/fresh.com', domain({ last_verified: '2026-10-01' }))
    expect((await validate(home, 10)).stale.map((s) => s.age_days)).toEqual([23])
    expect((await validate(home, 30)).stale).toEqual([])
  })

  test('到期日未知：expires 与 last_verified 为空，列为从未核实', async () => {
    const home = fixture()
    writeText(
      join(home, 'brain', 'resources', 'domains', 'arcanumber.com.md'),
      [
        '---',
        'type: domain',
        'title: arcanumber.com',
        'summary: 数字命理站的生产域名',
        'scope: work',
        'owner: ws/xuanxue-saas',
        'registrar:',
        'expires:',
        'last_verified:',
        'sources:',
        '  - ~/workspace/xuanxue-saas/apps/web/wrangler.jsonc',
        '---',
        '',
      ].join('\n'),
    )
    // 非事实类条目不统计核实时间。
    writeEntry(home, 'concepts/ganzhi', { ...base, type: 'concept' })
    const r = await validate(home)
    expect(r.errors).toEqual([])
    expect(r.neverVerified.map((n) => n.id)).toEqual(['resources/domains/arcanumber.com'])
  })
})

describe('密钥引用', () => {
  test('data-source 的 credential: secret://... 通过校验并原样保留', async () => {
    const home = fixture()
    writeEntry(home, 'resources/data-sources/stripe', {
      ...base,
      type: 'data-source',
      owner: 'ws/xuanxue-saas',
      provider: 'stripe',
      credential: 'secret://stripe/readonly',
      sources: ['~/workspace/xuanxue-saas/apps/web/src/lib/stripe.ts'],
    })
    const r = await validate(home)
    expect(r.errors).toEqual([])
    const entries = await readBrainEntries(home)
    expect(entries.ok && entries.data.entries[0]?.frontmatter.credential).toBe(
      'secret://stripe/readonly',
    )
  })

  test('credential 写明文是错误', async () => {
    const home = fixture()
    writeEntry(home, 'resources/data-sources/stripe', {
      ...base,
      type: 'data-source',
      owner: 'ws/xuanxue-saas',
      provider: 'stripe',
      credential: 'plaintext-token',
      sources: ['x'],
    })
    expect((await validate(home)).errors.map((e) => e.field)).toEqual(['credential'])
  })
})

test('brain 不存在时返回 not_initialized', async () => {
  const r = await validateBrain(tempHome())
  expect(r.ok).toBe(false)
  expect(!r.ok && r.error.code).toBe('not_initialized')
})
