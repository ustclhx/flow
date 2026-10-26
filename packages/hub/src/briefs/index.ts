import {
  type BriefContextData,
  briefContextData,
  briefContextQuery,
  briefUpdateData,
  briefUpdateRequest,
  ENDPOINTS,
  fail,
  isTerminalStatus,
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
 *   确定性生成的代回复记录（只含任务 id、决定、时间与截断后的回答）。
 */

/** supervisor 调用方的绑定信息（design D6：由中枢按唤醒绑定 token 认定）。 */
export interface SupervisorBinding {
  workspace: string
  /** 唤醒 origin：instruction、autonomous 或 reply。 */
  origin: string
}

export interface BriefRoutesDeps {
  ledger: Pick<LedgerStore, 'listTasks' | 'listInboxItems' | 'recentEvents'>
  home: string
  /**
   * 解析 supervisor 调用方的绑定。TODO(G5 / tasks 2.2)：唤醒绑定 token 合入后由鉴权中间件提供
   * （绑定 workspace 与唤醒 task_id，按 `supervisor.wake_started` 取 origin）；在此之前没有绑定信息，
   * 返回 null 时只按 actor 判定。
   */
  binding?: (c: Context) => SupervisorBinding | null
}

const TASK_LIMIT = 20
const INBOX_LIMIT = 20
const REPLY_LIMIT = 10
const GOAL_MAX = 200
const TITLE_MAX = 200
/** 代回复记录中回答的截断长度。 */
export const BRIEF_REPLY_TEXT_MAX = 200

const clipLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** 某 workspace 的简报中枢数据（确定性：只取决于账本与投影）。 */
export function briefContext(
  ledger: BriefRoutesDeps['ledger'],
  workspace: string,
): BriefContextData {
  const tasks = ledger
    .listTasks({ workspace, limit: 500 })
    .filter((t) => !isTerminalStatus(t.status))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id))
    .slice(0, TASK_LIMIT)
    .map((t) => ({
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
        text: p.text ? clipLine(p.text, BRIEF_REPLY_TEXT_MAX) : null,
      })
    } else if (e.type === 'task.reply_escalated') {
      // 转交说明可能由 supervisor 填写，不进入后续唤醒的上下文：只记原因。
      replies.push({
        task_id: e.task_id,
        decision: 'escalate',
        reason: e.payload.reason,
        at: e.ts,
        text: null,
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
  if (binding?.origin === 'reply') {
    return fail('failure', 'reply_only_wake', 'reply 唤醒只能调用 task_respond 与只读操作')
  }
  if (binding && binding.workspace !== workspace) {
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
    const denied = checkBriefCaller(actor, parsed.data.workspace, deps.binding?.(c) ?? null)
    if (denied) return respond(c, denied, briefUpdateData)
    return respond(c, await writeBrief(deps.home, parsed.data, { actor }), briefUpdateData)
  })
  app.get(ENDPOINTS['briefs-context'].path, (c) => {
    const parsed = briefContextQuery.safeParse(c.req.query())
    if (!parsed.success) {
      return respond(c, fail('usage', 'invalid_arguments', '简报查询参数不合法'), briefContextData)
    }
    return respond(c, ok(briefContext(deps.ledger, parsed.data.workspace)), briefContextData)
  })
  return app
}
