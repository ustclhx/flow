import { z } from 'zod'
import {
  commandWords,
  GUARDED_ACTIONS as GUARDED_ACTION_LIST,
  hasCommandPrefix,
  isGuardedTool,
  normalizePolicyPath,
} from './actions.ts'
import { ghScopeWorkspaceRepo, pushToTaskBranch } from './conditions.ts'
import {
  type IndexedPolicyRule,
  type PolicyRule,
  policyLevelSchema,
  policyRuleSchema,
} from './config.ts'

export const policyDecisionLevelSchema = policyLevelSchema.or(z.literal('user'))
export const indexedPolicyRuleSchema = z.strictObject({
  rule_index: z.number().int().min(0),
  rule: policyRuleSchema,
})
export const actionDecisionSchema = z.strictObject({
  action: z.string().min(1),
  level: policyDecisionLevelSchema.or(z.literal('skipped')),
  matched_rules: z.array(indexedPolicyRuleSchema),
  guarded: z.boolean(),
})
export const policyDecisionSchema = z.strictObject({
  level: policyDecisionLevelSchema,
  matched_rules: z.array(indexedPolicyRuleSchema),
  actions: z.array(actionDecisionSchema),
})

export type PolicyDecisionLevel = z.infer<typeof policyDecisionLevelSchema>
export interface PolicyRequest {
  scope: { workspace: string; role: string }
  actions: readonly string[]
  command?: string
  paths?: readonly string[]
}
/**
 * 条件 `push_to`、`gh_scope` 需要的判定上下文，由中枢从投影、合同与节点上报取得。
 * 字段缺失时对应条件一律不满足。
 */
export interface PolicyContext {
  /** 执行器上报的任务分支（`task.branch_reported`）。 */
  task_branch?: string | undefined
  /** 仓库默认分支。 */
  default_branch?: string | undefined
  /** 登记仓库中可接受的 remote 名。 */
  remotes?: readonly string[] | undefined
  /** 节点随请求上报的推送环境检查结果。 */
  push_env_ok?: boolean | undefined
  /** 节点随请求上报的 gh 仓库解析检查结果。 */
  gh_env_ok?: boolean | undefined
  /** 任务工作目录的绝对路径。 */
  cwd?: string | undefined
  /** 解析符号链接（路径不存在时抛错）；core 不访问文件系统，由调用方注入。 */
  realpath?: ((path: string) => string) | undefined
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
// 合并次序：notify > user > draft-approve > supervisor > auto-report > auto。
const CONSERVATISM: Record<PolicyDecisionLevel, number> = {
  auto: 0,
  'auto-report': 1,
  supervisor: 2,
  'draft-approve': 3,
  user: 4,
  notify: 5,
}
/** 受保护判定中的自动档位：supervisor 与 auto、auto-report 同属此类。 */
const AUTOMATIC_LEVELS: ReadonlySet<PolicyDecisionLevel> = new Set([
  'auto',
  'auto-report',
  'supervisor',
])
const GUARDED_ACTIONS: ReadonlySet<string> = new Set(GUARDED_ACTION_LIST)

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

function conditionsMatch(
  rule: PolicyRule,
  request: PolicyRequest,
  action: string,
  context: PolicyContext,
): boolean {
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
  if (rule.when?.push_to !== undefined) {
    if (rule.when.push_to !== 'task_branch' || action !== 'git.push') return false
    if (request.command === undefined) return false
    const result = pushToTaskBranch({
      command: request.command,
      remotes: context.remotes ?? [],
      taskBranch: context.task_branch,
      defaultBranch: context.default_branch,
      pushEnvOk: context.push_env_ok,
    })
    if (!result.ok) return false
  }
  if (rule.when?.gh_scope !== undefined) {
    if (rule.when.gh_scope !== 'workspace_repo' || request.command === undefined) return false
    const result = ghScopeWorkspaceRepo({
      command: request.command,
      ghEnvOk: context.gh_env_ok,
      cwd: context.cwd,
      realpath: context.realpath,
    })
    if (!result.ok) return false
  }
  return true
}

/**
 * 纯判定：先 scope，再 action 是否含 *，最后保守档位；不产生事件或文件写入。
 * `context` 只供 `push_to`、`gh_scope` 条件使用；缺省时这两类条件不满足。
 */
export function decide(
  rules: readonly IndexedPolicyRule[],
  request: PolicyRequest,
  context: PolicyContext = {},
): PolicyDecision {
  const uniqueActions = [...new Set(request.actions)]
  const hasSpecificAction = uniqueActions.some((action) => !action.startsWith('tool:'))
  // 请求涉及受保护的工具时，每个参与判定的动作都必须由精确 action 的规则放行。
  const viaGuardedTool = uniqueActions.some(isGuardedTool)
  const actions = uniqueActions.map((action): ActionDecision => {
    if (hasSpecificAction && action.startsWith('tool:')) {
      return { action, level: 'skipped', matched_rules: [], guarded: false }
    }
    const candidates = rules.filter(
      ({ rule }) =>
        scopeRank(rule.scope, request) >= 0 &&
        globMatch(rule.action, action) &&
        conditionsMatch(rule, request, action, context),
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
    const level = winner.rule.level
    const wildcardAction = winner.rule.action.includes('*')
    const wildcardScope = winner.rule.scope === '*'
    const guardedAction = GUARDED_ACTIONS.has(action)
    const guarded =
      AUTOMATIC_LEVELS.has(level) &&
      ((guardedAction && (wildcardScope || wildcardAction)) ||
        (viaGuardedTool && wildcardAction) ||
        // 受保护的动作永远不委托给 supervisor；受保护的工具只能由具体 scope 加精确 action 委托。
        (level === 'supervisor' && (guardedAction || (viaGuardedTool && wildcardScope))))
    return { action, level: guarded ? 'draft-approve' : level, matched_rules, guarded }
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
