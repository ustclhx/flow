import {
  decide,
  type EventOf,
  type IndexedPolicyRule,
  policyRuleHash,
  type TaskView,
} from '@raindown/core'
import { policyContext } from './context.ts'

/** 审批授权同时要求原依据仍在、新规则重新判定仍可委托；新增更严格规则也会收回授权。 */
export function approvalAuthorization(
  rules: readonly IndexedPolicyRule[],
  task: TaskView,
  decision: EventOf<'policy.decided'>,
): { allowed: boolean; matched_rules: IndexedPolicyRule[] } {
  const available = new Set(rules.map(policyRuleHash))
  const originalRulesPresent = decision.payload.matched_rules.every((rule) =>
    available.has(rule.rule_hash ?? policyRuleHash(rule)),
  )
  const request = decision.payload.request
  const current = decide(
    rules,
    {
      scope: { workspace: task.workspace, role: task.contract.role },
      actions: request.actions,
      ...(request.command === undefined ? {} : { command: request.command }),
      ...(request.paths === undefined ? {} : { paths: request.paths }),
    },
    policyContext(task, request, true),
  )
  return {
    allowed: originalRulesPresent && current.level === 'supervisor',
    matched_rules: current.matched_rules,
  }
}
