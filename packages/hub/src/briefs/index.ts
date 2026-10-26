import {
  type BriefContextData,
  briefContextData,
  briefContextQuery,
  briefUpdateData,
  briefUpdateRequest,
  ENDPOINTS,
  fail,
  ok,
  type Result,
  SUPERVISOR_ACTOR,
  USER_ACTOR,
  writeBrief,
} from '@flow/core'
import { type Context, Hono } from 'hono'
import { jsonBody, respond } from '../ledger/routes.ts'
import type { LedgerStore } from '../ledger/store.ts'

/**
 * 简报笔记与简报中枢数据（design D7、D8、D15）。
 *
 * - `POST /v1/briefs`（`brief_update`）：只允许 user 与 supervisor；supervisor 的 workspace 与
 *   唤醒 origin 取自调用方绑定（`binding`），不信任请求中的声明。
 * - `GET /v1/briefs/context`：`ws_brief` 的中枢部分——未结束的任务、未关闭的收件箱条目，以及由账本
 *   确定性生成的代回复记录（只含任务 id、决定、时间与回答长度）。回答原文由 reply 唤醒中的 supervisor
 *   写出，若进入简报就会进入后续（有建任务权限的）唤醒的上下文，违反 D15 "reply 唤醒不能写入会进入后续
 *   上下文的内容"，因此不收录；原文只进用户可见的每日摘要（TODO(4.9 / 每日摘要)：摘要直接读
 *   `task.replied` 的 text，不经这里）。
 */

/** supervisor 调用方的绑定信息（design D6：由中枢按唤醒绑定 token 认定）。 */
export interface SupervisorBinding {
  workspace: string
  /** 唤醒 origin：instruction、autonomous 或 reply。 */
  origin: string
}

/**
 * 由鉴权中间件的认定结果取唤醒绑定（中枢 run.ts 使用）：只有唤醒绑定 token 认证的请求有绑定，
 * 其他认证方式一律返回 null（supervisor 的写请求因此失败即拒绝）。
 */
export function wakeBinding(c: Context): SupervisorBinding | null {
  const auth = c.get('auth')
  return auth?.kind === 'wake' ? { workspace: auth.wake.workspace, origin: auth.wake.origin } : null
}

export interface BriefRoutesDeps {
  ledger: Pick<LedgerStore, 'openTasks' | 'listInboxItems' | 'recentEvents'>
  home: string
  /**
   * 解析 supervisor 调用方的唤醒绑定（design D6：由中枢按唤醒绑定 token 认定，不信任请求声明）。
   * 必填；返回 null 表示调用方不是经唤醒 token 认证的 supervisor，supervisor 的写请求一律拒绝
   * （失败即拒绝）。
   */
  binding: (c: Context) => SupervisorBinding | null
}

const TASK_LIMIT = 20
const INBOX_LIMIT = 20
const REPLY_LIMIT = 10
const GOAL_MAX = 200
const TITLE_MAX = 200

const clipLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** 某 workspace 的简报中枢数据（确定性：只取决于账本与投影）。 */
export function briefContext(
  ledger: BriefRoutesDeps['ledger'],
  workspace: string,
): BriefContextData {
  const tasks = ledger.openTasks(workspace, TASK_LIMIT).map((t) => ({
    id: t.id,
    role: t.contract.role,
    status: t.status,
    goal: clipLine(t.contract.goal, GOAL_MAX),
    blocked_reason: t.blocked?.reason ?? null,
    updated_at: t.updated_at,
  }))
  const inbox = ledger
    .listInboxItems({ state: 'open', workspace, limit: INBOX_LIMIT })
    .map((i) => ({
      short_id: i.short_id,
      level: i.level,
      source: i.source,
      title: clipLine(i.title, TITLE_MAX),
      created_at: i.created_at,
    }))
  const replies: BriefContextData['replies'] = []
  // 多取一些：非 supervisor 的 task.replied 会被过滤掉。
  for (const e of ledger.recentEvents(
    workspace,
    ['task.replied', 'task.reply_escalated'],
    REPLY_LIMIT * 10,
  )) {
    if (replies.length >= REPLY_LIMIT) break
    if (!e.task_id) continue
    if (e.type === 'task.replied') {
      if (e.actor !== SUPERVISOR_ACTOR) continue
      const p = e.payload
      replies.push({
        task_id: e.task_id,
        decision: p.kind === 'text' ? 'answer' : p.kind,
        reason: null,
        at: e.ts,
        answer_chars: p.text === undefined ? null : p.text.length,
      })
    } else if (e.type === 'task.reply_escalated') {
      // 转交说明可能由 supervisor 填写，不进入后续唤醒的上下文：只记原因。
      replies.push({
        task_id: e.task_id,
        decision: 'escalate',
        reason: e.payload.reason,
        at: e.ts,
        answer_chars: null,
      })
    }
  }
  return { workspace, tasks, inbox, replies }
}

/** brief_update 的调用方核对；通过时返回 null。 */
export function checkBriefCaller(
  actor: string,
  workspace: string,
  binding: SupervisorBinding | null,
): Result<never> | null {
  if (actor === USER_ACTOR) return null
  if (actor !== SUPERVISOR_ACTOR) {
    return fail(
      'failure',
      'role_not_allowed',
      `只有 supervisor 与 user 能更新简报笔记，当前为 ${actor}`,
    )
  }
  if (!binding) {
    return fail(
      'failure',
      'scope_denied',
      'supervisor 只能通过唤醒绑定 token 调用 brief_update（无法确认本次唤醒与 workspace）',
    )
  }
  if (binding.origin === 'reply') {
    return fail('failure', 'reply_only_wake', 'reply 唤醒只能调用 task_respond 与只读操作')
  }
  if (binding.workspace !== workspace) {
    return fail(
      'failure',
      'workspace_mismatch',
      `本次唤醒绑定 ${binding.workspace}，不能写 ${workspace} 的简报笔记`,
    )
  }
  return null
}

export function createBriefRoutes(deps: BriefRoutesDeps): Hono {
  const app = new Hono()
  app.post(ENDPOINTS['briefs-update'].path, async (c) => {
    const body = await jsonBody(c, false)
    if (!body.ok) return respond(c, body, briefUpdateData)
    const parsed = briefUpdateRequest.safeParse(body.data)
    if (!parsed.success) {
      return respond(
        c,
        fail(
          'usage',
          'invalid_arguments',
          `请求体不合法：${parsed.error.issues.map((i) => i.message).join('；')}`,
        ),
        briefUpdateData,
      )
    }
    const actor = c.get('actor') ?? 'unknown'
    const denied = checkBriefCaller(actor, parsed.data.workspace, deps.binding(c))
    if (denied) return respond(c, denied, briefUpdateData)
    return respond(c, await writeBrief(deps.home, parsed.data, { actor }), briefUpdateData)
  })
  app.get(ENDPOINTS['briefs-context'].path, (c) => {
    const parsed = briefContextQuery.safeParse(c.req.query())
    if (!parsed.success) {
      return respond(c, fail('usage', 'invalid_arguments', '简报查询参数不合法'), briefContextData)
    }
    // 已绑定唤醒的 supervisor 只能读绑定 workspace 的中枢数据。
    const binding = deps.binding(c)
    if (binding && binding.workspace !== parsed.data.workspace) {
      return respond(
        c,
        fail(
          'failure',
          'workspace_mismatch',
          `本次唤醒绑定 ${binding.workspace}，不能读取 ${parsed.data.workspace} 的简报数据`,
        ),
        briefContextData,
      )
    }
    return respond(c, ok(briefContext(deps.ledger, parsed.data.workspace)), briefContextData)
  })
  return app
}
