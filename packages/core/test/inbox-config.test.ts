import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BLOCKED_REASONS,
  defaultInboxLevel,
  jsonSchemas,
  loadInboxConfig,
  parseInboxConfig,
  resolveInboxLevel,
} from '../src/index.ts'

/** config/inbox.yaml 的分级覆盖（add-m1-inbox 3.1；inbox spec "默认分级"）。 */

const must = <T>(r: { ok: true; data: T } | { ok: false; error: { message: string } }): T => {
  if (!r.ok) throw new Error(r.error.message)
  return r.data
}

describe('默认分级', () => {
  test('卡住原因、提案、supervisor、策略记录、摘要', () => {
    const expected: Record<string, string> = {
      awaiting_approval: 'interrupt',
      question: 'interrupt',
      crashed: 'interrupt',
      node_lost: 'interrupt',
      no_progress: 'decide',
      other: 'decide',
    }
    for (const reason of BLOCKED_REASONS) {
      expect(defaultInboxLevel({ source: 'task', reason })).toBe(expected[reason] as never)
    }
    expect(defaultInboxLevel({ source: 'proposal' })).toBe('decide')
    expect(defaultInboxLevel({ source: 'supervisor' })).toBe('decide')
    expect(defaultInboxLevel({ source: 'policy' })).toBe('digest')
    expect(defaultInboxLevel({ source: 'digest' })).toBe('digest')
  })
})

describe('分级覆盖', () => {
  test('把 no_progress 设为 Digest（首字母大写也可）', () => {
    const c = must(parseInboxConfig({ levels: [{ reason: 'no_progress', level: 'Digest' }] }))
    expect(c.errors).toEqual([])
    expect(resolveInboxLevel(c, { source: 'task', reason: 'no_progress', workspace: 'ws/a' })).toBe(
      'digest',
    )
    expect(resolveInboxLevel(c, { source: 'task', reason: 'question' })).toBe('interrupt')
  })

  test('条件更多的规则优先；条件数相同时后面的规则覆盖前面的', () => {
    const c = must(
      parseInboxConfig({
        levels: [
          { source: 'task', workspace: 'ws/a', reason: 'question', level: 'digest' },
          { reason: 'question', level: 'decide' },
          { source: 'task', level: 'digest' },
          { source: 'proposal', level: 'interrupt' },
          { source: 'proposal', workspace: '*', level: 'digest' },
        ],
      }),
    )
    expect(resolveInboxLevel(c, { source: 'task', workspace: 'ws/a', reason: 'question' })).toBe(
      'digest',
    )
    // reason 与 source 各一个条件，同分取后者
    expect(resolveInboxLevel(c, { source: 'task', workspace: 'ws/b', reason: 'question' })).toBe(
      'digest',
    )
    // workspace: '*' 等同不写
    expect(resolveInboxLevel(c, { source: 'proposal' })).toBe('digest')
    expect(resolveInboxLevel(c, { source: 'policy' })).toBe('digest')
  })

  test('一条规则写错：只排除该条，报告规则序号与字段，其他规则照常生效', () => {
    const c = must(
      parseInboxConfig({
        levels: [
          { reason: 'no_progres', level: 'digest' },
          { reason: 'no_progress', level: 'urgent' },
          { reason: 'no_progress', levl: 'digest' },
          { reason: 'crashed', level: 'decide' },
        ],
        quiet: true,
      }),
    )
    expect(c.levels.map((r) => r.rule_index)).toEqual([3])
    expect(c.errors.filter((e) => e.rule_index !== undefined).map((e) => e.rule_index)).toEqual([
      0, 1, 2, 2,
    ])
    expect(c.errors.find((e) => e.field === 'quiet')?.code).toBe('unknown_field')
    expect(c.errors.find((e) => e.rule_index === 2 && e.field === 'levels.2.levl')).toBeDefined()
    expect(resolveInboxLevel(c, { source: 'task', reason: 'crashed' })).toBe('decide')
    expect(resolveInboxLevel(c, { source: 'task', reason: 'no_progress' })).toBe('decide')
  })

  test('文件级错误返回失败；文件不存在等同空配置', async () => {
    const home = mkdtempSync(join(tmpdir(), 'flow-inbox-config-'))
    expect(must(await loadInboxConfig(home))).toEqual({ levels: [], errors: [] })
    mkdirSync(join(home, 'config'))
    writeFileSync(join(home, 'config', 'inbox.yaml'), 'levels: [\n')
    const bad = await loadInboxConfig(home)
    expect(bad.ok ? null : bad.error.code).toBe('invalid_config')
    writeFileSync(join(home, 'config', 'inbox.yaml'), '- level: digest\n')
    const arr = await loadInboxConfig(home)
    expect(arr.ok ? null : arr.error.code).toBe('invalid_config')
    writeFileSync(
      join(home, 'config', 'inbox.yaml'),
      'levels:\n  - source: task\n    level: decide\n',
    )
    expect(must(await loadInboxConfig(home)).levels).toEqual([
      { rule_index: 0, source: 'task', level: 'decide' },
    ])
  })

  test('导出 JSON Schema', () => {
    const all = jsonSchemas()
    const schema = all['config/inbox.schema.json'] as { properties: Record<string, unknown> }
    expect(Object.keys(schema.properties)).toEqual(['levels'])
    expect(all['inbox/item.schema.json']).toBeDefined()
    expect(all['events/inbox.item_created.schema.json']).toBeDefined()
  })
})
