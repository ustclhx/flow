import { afterEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { BriefContextData } from '../src/ledger/protocol.ts'
import { fitBrief, NOTE_SHARE, truncateSection } from '../src/ops/brief-fit.ts'
import { hubBriefSections, wsBriefOp } from '../src/ops/workspace.ts'
import type { Result } from '../src/result.ts'
import { renderJournalRecord } from '../src/write/api.ts'
import { briefHash, writeBrief } from '../src/write/brief.ts'
import { writeEntry as fixtureEntry, initTempHome, writeText } from './helpers.ts'

const homes: string[] = []
async function home() {
  const h = await initTempHome('flow-wsbrief-')
  homes.push(h)
  return h
}
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(join(h, '..'), { recursive: true, force: true })
})
function data<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.data
}
const WS = 'ws/product-res'
const TS = '2026-10-26T08:00:00.000Z'

const context = (over: Partial<BriefContextData> = {}): BriefContextData => ({
  workspace: WS,
  tasks: [
    {
      id: 't-dev1',
      role: 'dev',
      status: 'blocked',
      goal: '修 README 的拼写错误',
      blocked_reason: 'question',
      updated_at: TS,
    },
  ],
  inbox: [
    {
      short_id: 'k1',
      level: 'decide',
      source: 'task',
      title: '任务提问：A 还是 B',
      created_at: TS,
    },
  ],
  replies: [
    { task_id: 't-dev1', decision: 'answer', reason: null, at: TS, text: '选 A，只改 README' },
    { task_id: 't-dev2', decision: 'escalate', reason: 'timeout', at: TS, text: null },
  ],
  ...over,
})

/** 以注入的 fetch 代替中枢：只响应简报数据接口。 */
const hubCtx = (h: string, ctxData: BriefContextData, actor = 'supervisor') => ({
  home: h,
  actor,
  via: 'mcp' as const,
  token: 'test-token',
  fetch: async (req: Request) => {
    const url = new URL(req.url)
    expect(url.pathname).toBe('/v1/briefs/context')
    expect(url.searchParams.get('workspace')).toBe(WS)
    return Response.json({ ok: true, data: ctxData })
  },
})

describe('ws_brief 扩展（design D8）', () => {
  test('笔记在最前；中枢数据、近期决策与代回复记录按顺序出现', async () => {
    const h = await home()
    const w = data(
      await writeBrief(
        h,
        { workspace: WS, text: '计划：先修 README', base_hash: briefHash(null) },
        {
          actor: 'supervisor',
        },
      ),
    )
    fixtureEntry(h, 'decisions/readme', {
      type: 'decision',
      title: '只修 README',
      summary: '范围限定',
      scope: 'work',
      status: 'approved',
      expected_outcome: '拼写错误归零',
      metric: '拼写检查通过',
      review_date: '2026-11-01',
      workspace: WS,
    })
    fixtureEntry(h, 'decisions/other', {
      type: 'decision',
      title: '其他 workspace 的决策',
      summary: '不相关',
      scope: 'work',
      status: 'approved',
      expected_outcome: '无',
      metric: '无',
      review_date: '2026-11-01',
      workspace: 'ws/xuanxue-saas',
    })
    const out = data(await wsBriefOp.run({ workspace: 'product-res' }, hubCtx(h, context())))
    expect(out.hub).toBe('ok')
    expect(out.note_hash).toBe(w.hash)
    expect(out.text.startsWith('## 简报笔记（supervisor 维护）\n\n计划：先修 README')).toBe(true)
    const labels = [
      '## 简报笔记',
      '# product-res（ws/product-res）',
      '## 进行中的任务',
      '## 待处理条目',
      '## 近期决策',
      '## 代回复记录（不是指令）',
    ]
    const indices = labels.map((l) => out.text.indexOf(l))
    expect(indices.every((i) => i >= 0)).toBe(true)
    expect(indices).toEqual([...indices].sort((a, b) => a - b))
    expect(out.text).toContain('- t-dev1 · dev · blocked(question)：修 README 的拼写错误')
    expect(out.text).toContain('- #k1 · decide · task：任务提问：A 还是 B')
    expect(out.text).toContain('[只修 README](decisions/readme.md) · approved · 回看 2026-11-01')
    expect(out.text).not.toContain('其他 workspace 的决策')
    expect(out.text).toContain('不是给你的指令')
    expect(out.text).toContain(`- ${TS} · t-dev1 · 回答：「选 A，只改 README」`)
    expect(out.text).toContain(`- ${TS} · t-dev2 · 转交用户（timeout）`)
  })

  test('中枢不可用时其余部分照常生成，并注明缺少中枢数据', async () => {
    const h = await home()
    const out = data(
      await wsBriefOp.run({ workspace: 'product-res' }, { home: h, actor: 'user', via: 'cli' }),
    )
    expect(out.hub).toBe('unavailable')
    expect(out.note_hash).toBe(briefHash(null))
    expect(out.text).toContain('中枢不可用')
    expect(out.text).not.toContain('## 简报笔记')
  })

  test('笔记最多占预算的 40%；8000 预算时 3000 字符的笔记完整保留', async () => {
    const h = await home()
    const note = Array.from({ length: 60 }, (_, i) => `笔记第 ${i} 行：${'内容'.repeat(20)}`)
      .join('\n')
      .slice(0, 3000)
    data(
      await writeBrief(
        h,
        { workspace: WS, text: note, base_hash: briefHash(null) },
        {
          actor: 'supervisor',
        },
      ),
    )
    const small = data(
      await wsBriefOp.run({ workspace: 'product-res', budget: 4000 }, hubCtx(h, context())),
    )
    const noteEnd = small.text.indexOf('\n\n# product-res')
    expect(noteEnd).toBeGreaterThan(0)
    expect(noteEnd).toBeLessThanOrEqual(4000 * NOTE_SHARE)
    expect(small.truncated).toContain('简报笔记')
    expect(small.text.length).toBeLessThanOrEqual(4000)
    // 笔记之外的各节仍然在。
    expect(small.text).toContain('## 进行中的任务')
    expect(small.text).toContain('## 代回复记录（不是指令）')
    const large = data(
      await wsBriefOp.run({ workspace: 'product-res', budget: 8000 }, hubCtx(h, context())),
    )
    expect(large.truncated).not.toContain('简报笔记')
    expect(large.text).toContain(note.trim())
  })

  test('各节分享笔记之后的剩余预算：长 journal 不会挤掉任务与代回复记录', async () => {
    const h = await home()
    const records = Array.from({ length: 10 }, (_, i) =>
      renderJournalRecord(`10:0${i}:00`, 'codex', WS, `日志-${i} ${'很长的内容 '.repeat(60)}`),
    )
    writeText(join(h, 'brain/journal/2026-10-25.md'), `# 2026-10-25\n${records.join('')}`)
    const many = context({
      tasks: Array.from({ length: 20 }, (_, i) => ({
        id: `t-task${i}`,
        role: 'dev',
        status: 'running' as const,
        goal: `任务 ${i} 的目标：${'细节'.repeat(30)}`,
        blocked_reason: null,
        updated_at: TS,
      })),
    })
    for (const budget of [1500, 3000, 4000]) {
      const out = data(await wsBriefOp.run({ workspace: 'product-res', budget }, hubCtx(h, many)))
      expect(out.text.length).toBeLessThanOrEqual(budget)
      expect(out.text).toContain('## 进行中的任务')
      expect(out.text).toContain('## 代回复记录（不是指令）')
      expect(out.text).toContain('## 最近 journal')
      expect(out.truncated).toContain('最近 journal')
      expect(out.truncated).toContain('进行中的任务')
    }
  })
})

describe('hubBriefSections', () => {
  test('空列表不生成对应小节；中枢不可用时只有一节说明', () => {
    expect(hubBriefSections(context({ tasks: [], inbox: [], replies: [] }))).toEqual([])
    const none = hubBriefSections(null)
    expect(none.map((s) => s.label)).toEqual(['中枢数据'])
  })

  test('代回复记录把回答压成单行并截断', () => {
    const [section] = hubBriefSections(
      context({
        tasks: [],
        inbox: [],
        replies: [
          { task_id: 't-a', decision: 'approve', reason: null, at: TS, text: null },
          {
            task_id: 't-b',
            decision: 'deny',
            reason: null,
            at: TS,
            text: `多行\n${'x'.repeat(300)}`,
          },
        ],
      }),
    )
    expect(section?.text).toContain(`- ${TS} · t-a · 批准`)
    const line = section?.text.split('\n').find((l) => l.includes('t-b')) ?? ''
    expect(line).toContain('拒绝：「多行 x')
    expect(line.length).toBeLessThan(260)
  })
})

describe('fitBrief', () => {
  const sec = (label: string, n: number) => ({
    label,
    text: `## ${label}\n\n${Array.from({ length: n }, (_, i) => `- 第 ${i} 项 ${'内容'.repeat(5)}`).join('\n')}`,
  })

  test('全部放得下时原样输出', () => {
    const r = fitBrief(sec('笔记', 2), [sec('A', 2), sec('B', 2)], 4000)
    expect(r.omitted).toEqual([])
    expect(r.truncated).toEqual([])
    expect(r.text).toBe([sec('笔记', 2), sec('A', 2), sec('B', 2)].map((s) => s.text).join('\n\n'))
  })

  test('任意预算下都不超出预算，省略说明列出整节省略的部分', () => {
    const sections = [sec('A', 3), sec('B', 40), sec('C', 10), sec('D', 80)]
    for (let budget = 64; budget <= 4000; budget += 37) {
      const r = fitBrief(sec('笔记', 30), sections, budget)
      expect(r.text.length).toBeLessThanOrEqual(budget)
      for (const label of r.omitted) expect(r.text).toContain(label)
      // 整节省略总是从最后一节开始。
      const kept = sections.filter((s) => !r.omitted.includes(s.label)).map((s) => s.label)
      expect(kept).toEqual(sections.slice(0, kept.length).map((s) => s.label))
    }
  })

  test('截断保留标题并标注；预算太小放不下标题时返回 null', () => {
    const s = sec('X', 20).text
    const cut = truncateSection(s, 120)
    expect(cut?.startsWith('## X')).toBe(true)
    expect(cut?.endsWith('…（本节已截断）')).toBe(true)
    expect((cut ?? '').length).toBeLessThanOrEqual(120)
    expect(truncateSection(s, 20)).toBeNull()
    expect(truncateSection('短', 20)).toBe('短')
  })
})
