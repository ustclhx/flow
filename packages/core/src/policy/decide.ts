import {
  commandWords,
  hasCommandPrefix,
  normalizePolicyPath,
  SENSITIVE_ACTIONS,
} from './actions.ts'
import type { IndexedPolicyRule, PolicyLevel, PolicyRule } from './config.ts'

export type PolicyDecisionLevel = PolicyLevel | 'user'
export interface PolicyRequest {
  scope: { workspace: string; role: string }
  actions: readonly string[]
  command?: string
  paths?: readonly string[]
}
export interface ActionDecision {
  action: string
  /** 已识别出具体动作时，工具动作仅留作来源明细，不参与判定。 */
  level: PolicyDecisionLevel | 'skipped'
  /** 最高具体程度的全部规则；按保守档位、原始序号排序，首条决定档位。 */
  matched_rules: IndexedPolicyRule[]
  /** 自动档位因缺少显式授权而提升至 draft-approve。 */
  guarded: boolean
}
export interface PolicyDecision {
  level: PolicyDecisionLevel
  matched_rules: IndexedPolicyRule[]
  actions: ActionDecision[]
}

// user 与 draft-approve 都等待用户；合并时保留无规则覆盖的信息，notify 仍优先。
const CONSERVATISM: Record<PolicyDecisionLevel, number> = {
  auto: 0,
  'auto-report': 1,
  'draft-approve': 2,
  user: 3,
  notify: 4,
}
const GUARDED_ACTIONS: ReadonlySet<string> = new Set(SENSITIVE_ACTIONS)

/** 动作仅支持 *；路径还支持 **（跨目录）与 ?（单字符），其余字符按字面匹配。 */
function globMatch(pattern: string, value: string, path = false): boolean {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string
    if (char === '*') {
      if (!path) source += '.*'
      else if (pattern[i + 1] === '*') {
        i++
        if (pattern[i + 1] === '/') {
          source += '(?:.*/)?'
          i++
        } else source += '.*'
      } else source += '[^/]*'
    } else if (path && char === '?') source += '[^/]'
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`).test(value)
}

function scopeRank(scope: string, request: PolicyRequest): number {
  if (scope === request.scope.workspace && scope.startsWith('ws/')) return 2
  if (scope === request.scope.role && scope !== '*') return 1
  return scope === '*' ? 0 : -1
}

function conditionsMatch(rule: PolicyRule, request: PolicyRequest): boolean {
  if (rule.when?.command_prefix !== undefined) {
    const prefixes = commandWords(rule.when.command_prefix)
    const commands = commandWords(request.command ?? '')
    const prefix = prefixes[0]
    if (prefixes.length !== 1 || !prefix || commands.length === 0) return false
    if (!commands.every((words) => hasCommandPrefix(words, prefix))) return false
  }
  const patterns = rule.when?.paths
  if (patterns) {
    if (!request.paths?.length) return false
    if (
      !request.paths.every((path) =>
        patterns.some((pattern) => globMatch(pattern, normalizePolicyPath(path), true)),
      )
    )
      return false
  }
  return true
}

/** 纯判定：先 scope，再 action 是否含 *，最后保守档位；不产生事件或文件写入。 */
export function decide(
  rules: readonly IndexedPolicyRule[],
  request: PolicyRequest,
): PolicyDecision {
  const uniqueActions = [...new Set(request.actions)]
  const hasSpecificAction = uniqueActions.some((action) => !action.startsWith('tool:'))
  const actions = uniqueActions.map((action): ActionDecision => {
    if (hasSpecificAction && action.startsWith('tool:')) {
      return { action, level: 'skipped', matched_rules: [], guarded: false }
    }
    const candidates = rules.filter(
      ({ rule }) =>
        scopeRank(rule.scope, request) >= 0 &&
        globMatch(rule.action, action) &&
        conditionsMatch(rule, request),
    )
    const bestScope = Math.max(-1, ...candidates.map(({ rule }) => scopeRank(rule.scope, request)))
    const scoped = candidates.filter(({ rule }) => scopeRank(rule.scope, request) === bestScope)
    const exact = scoped.filter(({ rule }) => !rule.action.includes('*'))
    const matched_rules = (exact.length ? exact : scoped).sort(
      (a, b) =>
        CONSERVATISM[b.rule.level] - CONSERVATISM[a.rule.level] || a.rule_index - b.rule_index,
    )
    const winner = matched_rules[0]
    if (!winner) return { action, level: 'user', matched_rules, guarded: false }
    const guarded =
      GUARDED_ACTIONS.has(action) &&
      (winner.rule.scope === '*' || winner.rule.action.includes('*')) &&
      (winner.rule.level === 'auto' || winner.rule.level === 'auto-report')
    return { action, level: guarded ? 'draft-approve' : winner.rule.level, matched_rules, guarded }
  })
  const level = actions.reduce<PolicyDecisionLevel>(
    (current, action) =>
      action.level !== 'skipped' && CONSERVATISM[action.level] > CONSERVATISM[current]
        ? action.level
        : current,
    actions.length ? 'auto' : 'user',
  )
  const matched = new Map<number, IndexedPolicyRule>()
  for (const action of actions) {
    for (const rule of action.matched_rules) matched.set(rule.rule_index, rule)
  }
  return { level, matched_rules: [...matched.values()], actions }
}
