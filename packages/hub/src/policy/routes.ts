import { createHash, timingSafeEqual } from 'node:crypto'
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
  type TaskView,
} from '@flow/core'
import { Hono } from 'hono'
import { errorResponse } from '../app.ts'
import { jsonBody, respond } from '../ledger/routes.ts'
import { scrubPayload } from '../ledger/scrub.ts'
import type { LedgerStore } from '../ledger/store.ts'
import { fieldIssues } from '../ledger/tasks.ts'
import { checkTaskScope, type HubAuthOptions } from '../server/auth.ts'

/**
 * 登记仓库可接受的 remote 名。workspace 登记的仓库只有本地路径（`repos`），没有 remote 字段，
 * 因此缺省为 `origin`（D15："remote 名取自登记仓库，缺省 origin"）；节点核对推送地址时以同名 remote
 * 在登记仓库中的配置为准（见 `packages/node/src/push-env.ts`）。
 */
export function registeredRemotes(_task: Pick<TaskView, 'workspace'>): readonly string[] {
  return ['origin']
}

/** 节点随请求上报、只在调用方确为该任务租约持有者时才采信的字段（D15）。 */
export interface NodeReport {
  push_env_ok?: boolean | undefined
  gh_env_ok?: boolean | undefined
  command_cwd?: string | undefined
}

/**
 * `push_to`、`gh_scope` 条件的判定上下文（D15）；任何缺失的字段都使对应条件不满足。
 * - 任务分支、任务 worktree 与默认分支取自投影（`task.branch_reported` 及其登记仓库快照，只接受租约
 *   持有节点写入、一次、不可改）；默认分支不取每次请求上报的值，快照缺失即不满足；
 * - `push_env_ok`、`gh_env_ok`、`command_cwd` 只认节点上报：`trusted` 为 false
 *   （user 或其他身份、租约令牌不匹配）时一律视为缺失；
 * - realpath 在节点侧完成（`command_cwd` 与上报的 worktree 都是节点 realpath 后的路径），中枢只做
 *   字符串相等比较，不访问本机文件系统。
 */
export function policyContext(
  task: Pick<TaskView, 'workspace' | 'branch' | 'worktree' | 'repo_snapshot'>,
  report: NodeReport,
  trusted: boolean,
): PolicyContext {
  const from = trusted ? report : {}
  return {
    remotes: registeredRemotes(task),
    ...(task.branch ? { task_branch: task.branch } : {}),
    ...(task.worktree ? { task_worktree: task.worktree } : {}),
    ...(task.repo_snapshot?.default_branch
      ? { default_branch: task.repo_snapshot.default_branch }
      : {}),
    ...(from.command_cwd === undefined ? {} : { command_cwd: from.command_cwd }),
    push_env_ok: from.push_env_ok === true,
    gh_env_ok: from.gh_env_ok === true,
    realpath: (path) => path,
  }
}

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
  return { level, matched_rules, actions, ...(level === 'supervisor' ? { decision_id: seq } : {}) }
}

/** 只做预检与审计；执行器放行、blocked 和收件箱由后续节点与反应器接入。 */
export function createPolicyRoutes(deps: {
  home: string
  ledger: LedgerStore
  leaseHolders: HubAuthOptions['leaseHolders']
  /** 当前时间（毫秒），校验租约令牌是否过期；缺省 Date.now。 */
  now?: () => number
}): Hono {
  const now = deps.now ?? Date.now
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
