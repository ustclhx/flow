import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  classifyAction,
  decide,
  ENDPOINTS,
  fail,
  isNodeActor,
  loadHubConfig,
  loadPoliciesConfig,
  type PolicyCheckData,
  type PolicyContext,
  type PolicyDecision,
  policyCheckData,
  policyCheckRequest,
  redactSecrets,
} from '@flow/core'
import { Hono } from 'hono'
import { errorResponse } from '../app.ts'
import { jsonBody, respond } from '../ledger/routes.ts'
import { scrubPayload } from '../ledger/scrub.ts'
import type { LedgerStore } from '../ledger/store.ts'
import { fieldIssues } from '../ledger/tasks.ts'
import { checkTaskScope, type HubAuthOptions } from '../server/auth.ts'

/**
 * 登记仓库的 remote 名：节点的 push_env_ok 核对它的推送地址与登记仓库一致。
 * TODO(5.6)：从 workspace 登记仓库取得 remote 名，而不是固定 origin。
 */
const REGISTERED_REMOTES = ['origin'] as const

/**
 * `push_to`、`gh_scope` 条件的判定上下文；任何缺失的字段都使对应条件不满足。
 * - `push_env_ok`、`gh_env_ok`：取自 `policyCheckRequest` 的同名字段（节点随请求上报），只认严格的 `true`。
 *   TODO(5.6)：`push_env_ok`、`gh_env_ok` 与 `command_cwd` 只接受 node actor（持有该任务活动租约的节点）
 *   上报的值；user 的请求一律视为缺失。
 * - TODO(1.6 账本)：任务分支取自投影中的 `task.branch_reported`，仓库默认分支待登记仓库提供。
 * - TODO(5.6)：`command_cwd`（节点上报命令实际执行目录）与 `task_worktree`（投影记录的任务
 *   worktree）尚无来源。两者缺失时 `push_to` 与 `gh_scope` 恒不满足（保守）。
 */
function policyContext(env: {
  push_env_ok?: boolean | undefined
  gh_env_ok?: boolean | undefined
}): PolicyContext {
  return {
    remotes: REGISTERED_REMOTES,
    push_env_ok: env.push_env_ok === true,
    gh_env_ok: env.gh_env_ok === true,
    // 仅同机部署：中枢在本机解析路径；远程节点时 command_cwd 的 realpath 比较须改在节点侧完成。
    realpath: (path) => realpathSync(path),
  }
}

/**
 * 已入账判定的响应体。`decision_id`（policy.decided 的 seq，D15）**只在 supervisor 档位时返回**：
 * 旧节点用 strict 的旧版 schema 解析响应，多出的字段会让预检失败，而旧节点不会遇到 supervisor 档位。
 */
export function policyCheckResponse(decision: PolicyDecision, seq: number): PolicyCheckData {
  const { level, matched_rules, actions } = decision
  return { level, matched_rules, actions, ...(level === 'supervisor' ? { decision_id: seq } : {}) }
}

/** 只做预检与审计；执行器放行、blocked 和收件箱由后续节点与反应器接入。 */
export function createPolicyRoutes(deps: {
  home: string
  ledger: LedgerStore
  leaseHolders: HubAuthOptions['leaseHolders']
}): Hono {
  const app = new Hono()
  // flow-home 的原路径与 realpath：其下 config/ 中的路径识别为 config.edit。
  const flowHomes = (() => {
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
    const { task_id, tool, command, paths, dry_run = false, push_env_ok, gh_env_ok } = parsed.data
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
    const loaded = await loadPoliciesConfig(deps.home)
    // 文件级错误沿用加载器的失败语义；节点按 D2 将调用失败视为需要用户。
    if (!loaded.ok) return errorResponse(c, 'internal_error', redactSecrets(loaded.error.message))
    // 异步读取配置期间租约可能结束或过期；入账前重新校验，此后到 append 之间没有 await。
    const expired = checkTaskScope(c, task_id, deps.leaseHolders)
    if (expired) return expired
    const actions = classifyAction(request, undefined, {
      flowHomes,
      userHome: homedir(),
      hubPorts,
    })
    const decision = decide(
      loaded.data.rules,
      {
        scope: { workspace: task.contract.workspace, role: task.contract.role },
        actions,
        ...request,
      },
      policyContext({ push_env_ok, gh_env_ok }),
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
    const env = {
      ...(push_env_ok === undefined ? {} : { push_env_ok }),
      ...(gh_env_ok === undefined ? {} : { gh_env_ok }),
    }
    const recorded = deps.ledger.append(
      {
        type: 'policy.decided',
        workspace: task.contract.workspace,
        task_id,
        payload: { task_id, request: { ...request, actions, ...env }, ...decision },
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
