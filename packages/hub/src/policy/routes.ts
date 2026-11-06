import { createHash, timingSafeEqual } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  classifyAction,
  decide,
  ENDPOINTS,
  fail,
  type IndexedPolicyRule,
  isNodeActor,
  loadHubConfig,
  loadPoliciesConfig,
  type PolicyCheckData,
  type PolicyDecision,
  policyCheckData,
  policyCheckRequest,
  redactSecrets,
} from '@raindown/core'
import { Hono } from 'hono'
import { errorResponse } from '../app.ts'
import { jsonBody, respond } from '../ledger/routes.ts'
import { scrubPayload } from '../ledger/scrub.ts'
import type { LedgerStore } from '../ledger/store.ts'
import { fieldIssues } from '../ledger/tasks.ts'
import { checkTaskScope, type HubAuthOptions } from '../server/auth.ts'
import { type NodeReport, policyContext } from './context.ts'
import { auditRules, type PolicyService } from './service.ts'

export { type NodeReport, policyContext, registeredRemotes } from './context.ts'

const sha256 = (value: string) => createHash('sha256').update(value).digest()

/** 请求带的租约令牌是否属于该任务未过期的活动租约（本机节点用 user token 调用时证明身份）。 */
export function leaseTokenMatches(
  ledger: Pick<LedgerStore, 'activeLeases'>,
  taskId: string,
  token: string | undefined,
  now: number,
): boolean {
  if (!token) return false
  const presented = sha256(token)
  let matched = false
  for (const lease of ledger.activeLeases()) {
    if (lease.task_id !== taskId || Date.parse(lease.expires_at) <= now) continue
    const expected = Buffer.from(lease.token_sha256, 'hex')
    if (expected.length === presented.length && timingSafeEqual(expected, presented)) {
      matched = true
    }
  }
  return matched
}

/**
 * 已入账判定的响应体。`decision_id`（policy.decided 的 seq，D15）**只在 supervisor 档位时返回**：
 * 旧节点用 strict 的旧版 schema 解析响应，多出的字段会让预检失败，而旧节点不会遇到 supervisor 档位。
 */
export function policyCheckResponse(decision: PolicyDecision, seq: number): PolicyCheckData {
  const { level, matched_rules, actions } = decision
  // 内容摘要仅用于账本追踪，响应保持旧节点 strict 规则结构。
  const publicRules = (rules: readonly IndexedPolicyRule[]) =>
    rules.map(({ rule_hash: _, ...rule }) => rule)
  return {
    level,
    matched_rules: publicRules(matched_rules),
    actions: actions.map((action) => ({
      ...action,
      matched_rules: publicRules(action.matched_rules),
    })),
    ...(level === 'supervisor' ? { decision_id: seq } : {}),
  }
}

/** 只做预检与审计；执行器放行、blocked 和收件箱由后续节点与反应器接入。 */
export function createPolicyRoutes(deps: {
  home: string
  policy?: Pick<PolicyService, 'load'>
  ledger: LedgerStore
  leaseHolders: HubAuthOptions['leaseHolders']
  /** 当前时间（毫秒），校验租约令牌是否过期；缺省 Date.now。 */
  now?: () => number
}): Hono {
  const now = deps.now ?? Date.now
  const app = new Hono()
  // raindown-home 的原路径与 realpath：其下 config/ 中的路径识别为 config.edit。
  const raindownHomes = (() => {
    try {
      return [...new Set([deps.home, realpathSync(deps.home)])]
    } catch {
      return [deps.home]
    }
  })()
  app.post(ENDPOINTS['policy-check'].path, async (c) => {
    const body = await jsonBody(c, false)
    if (!body.ok) return respond(c, body, policyCheckData)
    const parsed = policyCheckRequest.safeParse(body.data)
    if (!parsed.success) {
      return respond(
        c,
        fail(
          'usage',
          'invalid_arguments',
          '策略检查请求不合法',
          fieldIssues(parsed.error.issues, body.data),
        ),
        policyCheckData,
      )
    }
    const {
      task_id,
      tool,
      command,
      paths,
      dry_run = false,
      push_env_ok,
      gh_env_ok,
      command_cwd,
      lease_token,
    } = parsed.data
    if (dry_run && isNodeActor(c.get('actor'))) {
      return errorResponse(
        c,
        'invalid_arguments',
        '节点策略检查不允许 dry_run=true，必须记录审计事件',
      )
    }
    const request = {
      tool,
      ...(command === undefined ? {} : { command }),
      ...(paths === undefined ? {} : { paths }),
    }
    const task = deps.ledger.getTask(task_id)
    if (!task) return errorResponse(c, 'not_found', `任务 ${task_id} 不存在`)
    const denied = checkTaskScope(c, task_id, deps.leaseHolders)
    if (denied) return denied
    // 中枢端口用于识别直接访问中枢的命令；读取失败时只用默认端口（7477、7478）。
    const hubConfig = await loadHubConfig(deps.home)
    const hubPorts = hubConfig.ok ? [hubConfig.data.port] : []
    const loaded = await (deps.policy?.load() ?? loadPoliciesConfig(deps.home))
    // 文件级错误沿用加载器的失败语义；节点按 D2 将调用失败视为需要用户。
    if (!loaded.ok) return errorResponse(c, 'internal_error', redactSecrets(loaded.error.message))
    // 异步读取配置期间租约可能结束或过期；入账前重新校验，此后到 append 之间没有 await。
    const expired = checkTaskScope(c, task_id, deps.leaseHolders)
    if (expired) return expired
    const actions = classifyAction(request, undefined, {
      raindownHomes,
      userHome: homedir(),
      hubPorts,
    })
    // 节点上报的环境字段只认租约持有者（D15）：node actor 已由 checkTaskScope 核对持有活动租约；
    // 本机节点用 user token 调用，靠请求中的租约令牌证明。其他调用方（含 user）一律视为缺失。
    const actor = c.get('actor')
    const trusted =
      isNodeActor(actor) || leaseTokenMatches(deps.ledger, task_id, lease_token, now())
    const report: NodeReport = { push_env_ok, gh_env_ok, command_cwd }
    const current = deps.ledger.getTask(task_id) ?? task
    const decision = decide(
      loaded.data.rules,
      {
        scope: { workspace: task.contract.workspace, role: task.contract.role },
        actions,
        ...request,
      },
      policyContext(current, report, trusted),
    )
    if (dry_run) {
      // 调试不入账，响应仍按同一规则脱敏，避免从命中条件返回密钥。
      return respond(
        c,
        { ok: true, data: scrubPayload('policy.decided', decision) },
        policyCheckData,
      )
    }
    // 节点上报的环境检查结果（D15）随判定入账供审计，并作为 push_to / gh_scope 条件的上下文。
    // 只记录采信的值：不可信调用方上报的字段不入账，避免审计里出现未经核实的"环境通过"。
    const env = trusted
      ? {
          ...(push_env_ok === undefined ? {} : { push_env_ok }),
          ...(gh_env_ok === undefined ? {} : { gh_env_ok }),
          ...(command_cwd === undefined ? {} : { command_cwd }),
        }
      : {}
    const recorded = deps.ledger.append(
      {
        type: 'policy.decided',
        workspace: task.contract.workspace,
        task_id,
        payload: {
          task_id,
          request: { ...request, actions, ...env },
          ...decision,
          policy_version: loaded.data.version,
          matched_rules: auditRules(decision.matched_rules),
          actions: decision.actions.map((action) => ({
            ...action,
            matched_rules: auditRules(action.matched_rules),
          })),
        },
      },
      { actor: 'policy' },
    )
    if (!recorded.ok) return respond(c, recorded, policyCheckData)
    // 返回已入账的规则内容，避免原始规则条件中的密钥从响应绕过脱敏。
    return respond(
      c,
      {
        ok: true,
        data: policyCheckResponse(recorded.data.payload as PolicyDecision, recorded.data.seq),
      },
      policyCheckData,
    )
  })
  return app
}
