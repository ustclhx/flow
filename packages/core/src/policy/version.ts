import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { IndexedPolicyRule } from './config.ts'

export const policyVersionSchema = z.string().regex(/^[0-9a-f]{12}$/)
export const policyRuleHashSchema = z.string().regex(/^[0-9a-f]{64}$/)

/** 对象键排序，数组保留顺序；输入只来自已校验并归一的有效规则。 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) as string
}

/** 原始索引不影响行为；旧工具来源标记会改变保守合并语义，必须计入。 */
function ruleContent(rule: IndexedPolicyRule) {
  return {
    rule: rule.rule,
    ...(rule.legacy_tool_action ? { legacy_tool_action: true } : {}),
  }
}

/** 单条规则的内容摘要，用于跨版本追踪授权依赖；不包含原始数组索引。 */
export const policyRuleHash = (rule: IndexedPolicyRule): string =>
  createHash('sha256')
    .update(canonicalJson(ruleContent(rule)))
    .digest('hex')

/** 有效规则数组的版本，规则顺序参与计算。 */
export const policyVersion = (rules: readonly IndexedPolicyRule[]): string =>
  createHash('sha256')
    .update(canonicalJson(rules.map(ruleContent)))
    .digest('hex')
    .slice(0, 12)
