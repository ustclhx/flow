import { afterEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  checkTaskMandateForResume,
  eventPayloads,
  type IndexedPolicyRule,
  loadPoliciesConfig,
  policyRuleHash,
  policyVersion,
  taskMandate,
} from '../src/index.ts'
import { tempHome, writeText } from './helpers.ts'

const rule: IndexedPolicyRule = {
  rule_index: 0,
  rule: { scope: 'supervisor', action: 'task.create', level: 'auto' },
}
const mandate = taskMandate.parse({
  created_by: 'supervisor',
  origin: 'supervisor',
  wake_task: 't_wake',
  instruction_seq: 9,
  policy_version: policyVersion([rule]),
  matched_rules: [rule],
})

describe('策略版本与规则摘要', () => {
  const homes: string[] = []
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(dirname(home), { recursive: true, force: true })
  })

  test('注释、空白、键顺序与无效规则不影响版本；旧管理动作归一后相同', async () => {
    const home = tempHome('raindown-policy-version-')
    homes.push(home)
    const path = join(home, 'config/policies.yaml')
    writeText(path, '- scope: supervisor\n  action: flow.admin\n  level: auto\n')
    const before = await loadPoliciesConfig(home)
    writeText(
      path,
      '# 注释\n- scope: supervisor\n  action: task.create\n  level: unknown\n\n- level: auto\n  action: raindown.admin\n  scope: supervisor\n',
    )
    const after = await loadPoliciesConfig(home)
    if (!before.ok || !after.ok) throw new Error('加载失败')
    expect(after.data.errors).toHaveLength(1)
    expect(after.data.rules[0]?.rule_index).toBe(1)
    expect(after.data.version).toBe(before.data.version)
    expect(after.data.version).toMatch(/^[0-9a-f]{12}$/)
    writeText(path, '- scope: supervisor\n  action: tool:mcp__flow__task_create\n  level: notify\n')
    const legacy = await loadPoliciesConfig(home)
    writeText(
      path,
      '- scope: supervisor\n  action: tool:mcp__raindown__task_create\n  level: notify\n',
    )
    const modern = await loadPoliciesConfig(home)
    if (!legacy.ok || !modern.ok) throw new Error('加载失败')
    expect(legacy.data.rules[0]?.rule).toEqual(modern.data.rules[0]?.rule)
    expect(legacy.data.version).not.toBe(modern.data.version)
  })

  test('规则顺序和旧工具来源改变版本，原始索引和缓存摘要不参与', () => {
    const second: IndexedPolicyRule = { ...rule, rule: { ...rule.rule, level: 'notify' } }
    const reordered: IndexedPolicyRule = {
      rule_index: 5,
      rule_hash: 'a'.repeat(64),
      rule: { level: 'auto', action: 'task.create', scope: 'supervisor' },
    }
    expect(policyVersion([reordered])).toBe(policyVersion([rule]))
    expect(policyRuleHash(reordered)).toBe(policyRuleHash(rule))
    expect(policyRuleHash(rule)).toMatch(/^[0-9a-f]{64}$/)
    expect(policyVersion([rule])).not.toBe(policyVersion([second]))
    expect(policyVersion([rule, second])).not.toBe(policyVersion([second, rule]))
    expect(policyVersion([{ ...rule, legacy_tool_action: true }])).not.toBe(policyVersion([rule]))
  })
})

describe('授权依据与旧事件兼容', () => {
  test('当前角色已删除时所有来源都拒绝恢复', () => {
    for (const created_by of ['user', 'supervisor', 'hub']) {
      expect(
        checkTaskMandateForResume({ created_by }, { supervisor_enabled: true, role: null }),
      ).toMatchObject({ ok: false, error: { code: 'role_missing' } })
    }
  })

  test('hub 合并管线追溯到 supervisor 时检查启用状态，保留 hub 角色创建权限', () => {
    const task = {
      created_by: 'hub',
      mandate: { ...mandate, created_by: 'hub', origin: 'pipeline:merge' },
    }
    expect(checkTaskMandateForResume(task, { supervisor_enabled: false, role: {} })).toMatchObject({
      ok: false,
      error: { code: 'supervisor_disabled' },
    })
    expect(checkTaskMandateForResume(task, { supervisor_enabled: true, role: {} }).ok).toBe(true)
    expect(
      checkTaskMandateForResume({ created_by: 'hub' }, { supervisor_enabled: false, role: {} }).ok,
    ).toBe(true)
  })

  test('创建与三种代回复事件保存版本和命中规则，旧载荷仍能重放', () => {
    const provenance = { policy_version: mandate.policy_version, matched_rules: [rule] }
    const replies = [
      ['task.replied', { reply_id: 'r-1', kind: 'approve', via: 'supervisor' }],
      ['task.reply_escalated', { block_seq: 7, reason: 'policy_changed' }],
      [
        'task.reply_delegated',
        {
          task_id: 't_1',
          block_seq: 7,
          kind: 'question',
          deadline: '2026-11-06T08:00:00.000Z',
        },
      ],
    ] as const
    for (const [type, payload] of replies) {
      const schema = eventPayloads[type]
      expect(schema.safeParse(payload).success).toBe(true)
      expect(schema.parse({ ...payload, ...provenance })).toMatchObject(provenance)
      expect(schema.safeParse({ ...payload, policy_version: 'invalid' }).success).toBe(false)
    }
    const contract = { goal: 'g', workspace: 'ws/product', role: 'dev', executor: 'fake' }
    expect(eventPayloads['task.created'].parse({ contract, mandate })).toMatchObject({ mandate })
    expect(eventPayloads['task.created'].safeParse({ contract }).success).toBe(true)
    expect(taskMandate.safeParse({ ...mandate, instruction_seq: 0 }).success).toBe(false)
  })

  test('supervisor 创建的新旧任务恢复时都重新校验当前启用状态与角色授权', () => {
    const enabled = { supervisor_enabled: true, role: { creatable_by: ['supervisor'] } }
    for (const task of [{ created_by: 'supervisor' }, { created_by: 'user', mandate }]) {
      expect(checkTaskMandateForResume(task, enabled).ok).toBe(true)
      expect(
        checkTaskMandateForResume(task, { ...enabled, supervisor_enabled: false }),
      ).toMatchObject({ ok: false, error: { code: 'supervisor_disabled' } })
      expect(checkTaskMandateForResume(task, { ...enabled, role: {} })).toMatchObject({
        ok: false,
        error: { code: 'role_not_allowed' },
      })
    }
    expect(
      checkTaskMandateForResume(
        { created_by: 'user' },
        {
          supervisor_enabled: false,
          role: {},
        },
      ).ok,
    ).toBe(true)
    expect(
      checkTaskMandateForResume(
        { created_by: 'supervisor' },
        {
          supervisor_enabled: true,
          role: { creatable_by: ['*'] },
        },
      ).ok,
    ).toBe(true)
  })
})
