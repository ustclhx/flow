import { describe, expect, test } from 'bun:test'
import {
  ENTRY_TYPES,
  type EntryType,
  entrySchema,
  entrySchemas,
  FACT_TYPES,
  isCalendarDate,
  jsonSchemas,
  RESOURCE_TYPES,
  renderEntryFieldDocs,
  workspaceSchema,
} from '../src/schema/index.ts'

const base = { title: 'T', summary: '一句话', scope: 'work' }

/** 每种类型一个合法样例与一个非法样例（以及非法的原因字段）。 */
const samples: Record<
  EntryType,
  { valid: Record<string, unknown>; invalid: Record<string, unknown>; field: string }
> = {
  product: {
    valid: { ...base, type: 'product', workspace: 'ws/xuanxue-saas', status: 'live' },
    invalid: { ...base, type: 'product', status: 'live' },
    field: 'workspace',
  },
  domain: {
    valid: {
      ...base,
      type: 'domain',
      owner: 'ws/xuanxue-saas',
      registrar: null,
      expires: null,
      last_verified: null,
      sources: ['repo:apps/web/wrangler.jsonc'],
    },
    invalid: { ...base, type: 'domain', owner: 'xuanxue-saas', registrar: null, expires: null },
    field: 'owner',
  },
  service: {
    valid: { ...base, type: 'service', owner: 'ws/product-res', provider: 'cloudflare-workers' },
    invalid: { ...base, type: 'service', owner: 'ws/product-res' },
    field: 'provider',
  },
  repo: {
    valid: { ...base, type: 'repo', owner: 'ws/product-res', path: '~/workspace/product-res' },
    invalid: { ...base, type: 'repo', owner: 'ws/product-res', path: 42 },
    field: 'path',
  },
  'data-source': {
    valid: {
      ...base,
      type: 'data-source',
      owner: 'ws/xuanxue-saas',
      provider: 'stripe',
      credential: 'secret://stripe/readonly',
    },
    invalid: {
      ...base,
      type: 'data-source',
      owner: 'ws/xuanxue-saas',
      provider: 'stripe',
      credential: 'rk_live_plaintext',
    },
    field: 'credential',
  },
  account: {
    valid: { ...base, type: 'account', owner: 'ws/global', platform: 'x', handle: '@me' },
    invalid: { ...base, type: 'account', owner: 'ws/global', platform: 'x' },
    field: 'handle',
  },
  runbook: {
    valid: { ...base, type: 'runbook', applies_to: ['resources/services/web'] },
    invalid: { ...base, type: 'runbook', applies_to: 'resources/services/web' },
    field: 'applies_to',
  },
  decision: {
    valid: {
      ...base,
      type: 'decision',
      status: 'approved',
      expected_outcome: '转化率提升',
      metric: 'checkout 转化率',
      review_date: '2026-12-01',
    },
    invalid: {
      ...base,
      type: 'decision',
      status: 'done',
      expected_outcome: 'x',
      metric: 'y',
      review_date: '2026-12-01',
    },
    field: 'status',
  },
  concept: {
    valid: { ...base, type: 'concept', tags: ['术语'] },
    invalid: { ...base, type: 'concept', scope: 'team' },
    field: 'scope',
  },
  note: {
    valid: { ...base, type: 'note' },
    invalid: { type: 'note', summary: 's', scope: 'work' },
    field: 'title',
  },
  'project-card': {
    valid: {
      ...base,
      type: 'project-card',
      workspace: 'ws/product-res',
      repo_paths: ['~/workspace/product-res'],
    },
    invalid: { ...base, type: 'project-card', workspace: 'ws/product-res' },
    field: 'repo_paths',
  },
}

describe('11 种条目类型', () => {
  test('类型清单与分类', () => {
    expect(ENTRY_TYPES).toHaveLength(11)
    expect([...RESOURCE_TYPES].sort()).toEqual([
      'account',
      'data-source',
      'domain',
      'repo',
      'service',
    ])
    expect<string[]>([...FACT_TYPES].sort()).toEqual(
      ['account', 'data-source', 'domain', 'product', 'repo', 'runbook', 'service'].sort(),
    )
  })

  for (const type of ENTRY_TYPES) {
    test(`${type}：合法样例通过，非法样例报告 ${samples[type].field}`, () => {
      const { valid, invalid, field } = samples[type]
      expect(entrySchemas[type].safeParse(valid).success).toBe(true)
      expect(entrySchema.safeParse(valid).success).toBe(true)
      const r = entrySchemas[type].safeParse(invalid)
      expect(r.success).toBe(false)
      expect(r.error?.issues.map((i) => i.path.join('.'))).toContain(field)
    })
  }

  test('decision 缺少 review_date 时不通过', () => {
    const { review_date: _r, ...rest } = samples.decision.valid
    const r = entrySchemas.decision.safeParse(rest)
    expect(r.error?.issues.map((i) => i.path.join('.'))).toEqual(['review_date'])
  })

  test('允许额外字段，且 secret:// 引用原样保留', () => {
    const r = entrySchemas['data-source'].parse({ ...samples['data-source'].valid, extra: 1 })
    expect(r.credential).toBe('secret://stripe/readonly')
    expect((r as Record<string, unknown>).extra).toBe(1)
  })

  test('日期：只接受真实存在的 YYYY-MM-DD 字符串', () => {
    expect(isCalendarDate('2026-02-28')).toBe(true)
    expect(isCalendarDate('2026-02-30')).toBe(false)
    expect(isCalendarDate('2026-2-3')).toBe(false)
    const d = { ...samples.domain.valid }
    expect(entrySchemas.domain.safeParse({ ...d, expires: '2027-13-01' }).success).toBe(false)
    expect(entrySchemas.domain.safeParse({ ...d, last_verified: '2026-10-01' }).success).toBe(true)
  })
})

describe('workspace 定义', () => {
  test('product 必须有 repos；function 不需要', () => {
    const ws = { id: 'product-res', name: 'Product Res', description: 'd' }
    expect(workspaceSchema.safeParse({ ...ws, kind: 'product', repos: ['~/w/p'] }).success).toBe(
      true,
    )
    expect(workspaceSchema.safeParse({ ...ws, kind: 'product' }).success).toBe(false)
    expect(workspaceSchema.safeParse({ ...ws, kind: 'function' }).success).toBe(true)
    expect(workspaceSchema.safeParse({ ...ws, kind: 'team' }).success).toBe(false)
  })
})

describe('JSON Schema 导出', () => {
  test('包含总 schema、workspace 与每种类型', () => {
    const files = Object.keys(jsonSchemas()).sort()
    expect(files).toHaveLength(13)
    expect(files).toContain('entry.schema.json')
    expect(files).toContain('workspace.schema.json')
    for (const t of ENTRY_TYPES) expect(files).toContain(`entries/${t}.schema.json`)
    const decision = jsonSchemas()['entries/decision.schema.json'] as { required: string[] }
    expect(decision.required).toEqual(
      expect.arrayContaining(['status', 'expected_outcome', 'metric', 'review_date']),
    )
  })

  test('字段说明由同一份定义生成', () => {
    const docs = renderEntryFieldDocs()
    for (const t of ENTRY_TYPES) expect(docs).toContain(`### \`${t}\``)
    expect(docs).toContain('`review_date`（必填，date）')
    expect(docs).toContain('`credential`（可选')
  })
})
