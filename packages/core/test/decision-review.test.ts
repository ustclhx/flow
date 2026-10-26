import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  checkDecisionReview,
  checkPolicy,
  decisionPathFor,
  renderDecision,
  renderEntry,
  reviewDecision,
  writeEntry,
} from '../src/index.ts'
import { initTempHome } from './helpers.ts'

/** 决策回看的窄例外（add-m1-supervisor D11）与决策条目的生成。 */

const fm = {
  type: 'decision',
  title: '缓存 TTL',
  summary: '缓存决策',
  scope: 'work',
  status: 'approved',
  expected_outcome: '命中率 90%',
  metric: '命中率',
  review_date: '2026-10-20',
  workspace: 'ws/product-res',
  sources: ['task:t-1'],
  last_verified: null,
}
const before = renderEntry(fm, '\n正文\n')
const reviewed = (
  over: Record<string, unknown> = {},
  body = '\n正文\n\n## 回看 2026-10-26\n\n结论\n',
) => renderEntry({ ...fm, status: 'reviewed', last_verified: '2026-10-26', ...over }, body)
const change = (content: string, path = 'decisions/a.md') =>
  ({ op: 'replace', path, content }) as const

describe('checkDecisionReview', () => {
  test('只追加回看一节、只改 status 与 last_verified 时放行', () => {
    expect(checkDecisionReview(change(reviewed()), before)).toBeNull()
  })

  test.each([
    ['改其他字段', reviewed({ metric: '别的指标' })],
    ['改 review_date', reviewed({ review_date: '2027-01-01' })],
    ['状态不是 reviewed', reviewed({ status: 'rejected' })],
    ['改动原正文', reviewed({}, '\n改写的正文\n\n## 回看 2026-10-26\n\n结论\n')],
    ['回看标题日期与 last_verified 不一致', reviewed({}, '\n正文\n\n## 回看 2026-10-01\n\n结论\n')],
    ['追加的不是回看一节', reviewed({}, '\n正文\n\n## 其他\n\n结论\n')],
  ])('%s → 拒绝', (_name, content) => {
    expect(checkDecisionReview(change(content), before)?.ok).toBe(false)
  })

  test('只回看 approved 的决策；不能新建、删除或改 decisions/ 以外的文件', () => {
    expect(checkDecisionReview(change(reviewed()), reviewed())?.ok).toBe(false)
    expect(
      checkDecisionReview({ op: 'create', path: 'decisions/a.md', content: reviewed() }, null)?.ok,
    ).toBe(false)
    expect(checkDecisionReview(change(reviewed(), 'notes/a.md'), before)?.ok).toBe(false)
  })

  test('没有回看能力时 AI 仍不能写决策', () => {
    const denied = checkPolicy('brain', change(reviewed()), before, 'hub')
    expect(denied?.ok === false && denied.error.code).toBe('ai_forbidden_decision')
    // 带能力时只走窄例外：日志、简报等其他文件一律拒绝。
    const other = checkPolicy('brain', change('x', 'briefs/product-res.md'), null, 'hub', {
      decisionReview: true,
    })
    expect(other?.ok === false && other.error.code).toBe('decision_review_denied')
  })
})

describe('决策条目', () => {
  test('路径带日期、slug 与提案标识；无 ASCII 标题时只用提案标识', () => {
    expect(decisionPathFor('2026-10-26', 'Cache TTL!', 'tp-ab12cd')).toBe(
      'decisions/2026-10-26-cache-ttl-ab12cd.md',
    )
    expect(decisionPathFor('2026-10-26', '缓存', 'tp-ab12cd')).toBe(
      'decisions/2026-10-26-ab12cd.md',
    )
  })

  test('user 写入后 hub 经 reviewDecision 回看', async () => {
    const home = await initTempHome('flow-decision-')
    const content = renderDecision({
      title: '缓存 TTL',
      expected_outcome: '命中率 90%',
      metric: '命中率',
      review_date: '2026-11-25',
      workspace: 'ws/product-res',
      task_id: 't-1',
      goal: '调 TTL',
    })
    const w = await writeEntry(home, { id: 'decisions/2026-10-26-x', content }, { actor: 'user' })
    expect(w.ok).toBe(true)
    // AI 直接写决策仍被拒绝。
    const ai = await writeEntry(home, { id: 'decisions/2026-10-26-x', content }, { actor: 'hub' })
    expect(!ai.ok && ai.error.code).toBe('ai_forbidden_decision')
    const r = await reviewDecision(
      home,
      { path: 'decisions/2026-10-26-x.md', text: '达到预期', date: '2026-11-25' },
      { actor: 'hub' },
    )
    expect(r.ok).toBe(true)
    const text = readFileSync(join(home, 'brain', 'decisions/2026-10-26-x.md'), 'utf8')
    expect(text).toContain('status: reviewed')
    expect(text).toContain('last_verified: 2026-11-25')
    expect(text).toContain('## 回看 2026-11-25\n\n达到预期\n')
  })
})
