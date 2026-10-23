import {
  ACTOR_RE,
  cancelTaskData,
  cancelTaskRequest,
  createTaskData,
  ENDPOINTS,
  fail,
  HEADERS,
  listTasksData,
  PROTOCOL_ERRORS,
  type Result,
  rebuildData,
  showTaskData,
  toJsonDocument,
} from '@flow/core'
import { type Context, Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { z } from 'zod'
import type { LedgerStore } from './store.ts'
import { fieldIssues, type TaskService } from './tasks.ts'

/**
 * 任务相关路由（protocol.ts 的 tasks-create / tasks-list / tasks-show / tasks-cancel，
 * 以及 hub-rebuild）。作为独立的 Hono 子应用导出，由中枢主应用挂载（`app.route('/', ...)`）；
 * 认证中间件由主应用负责，这里不处理。
 */

export interface TaskRoutesDeps {
  ledger: Pick<LedgerStore, 'rebuild'>
  tasks: TaskService
}

/** 协议错误码对应的 HTTP 状态；不在 PROTOCOL_ERRORS 中的码按类别回退。 */
function statusOf(code: string, kind: string): number {
  if (code in PROTOCOL_ERRORS) return PROTOCOL_ERRORS[code as keyof typeof PROTOCOL_ERRORS].status
  return kind === 'usage' ? 400 : kind === 'retryable' ? 503 : 500
}

function respond<T>(
  c: Context,
  result: Result<T>,
  schema: z.ZodType,
  okStatus: ContentfulStatusCode = 200,
): Response {
  if (!result.ok) {
    return c.json(
      toJsonDocument(result),
      statusOf(result.error.code, result.error.kind) as ContentfulStatusCode,
    )
  }
  // 响应 data 也按协议 schema 校验；不符合时抛出，由 onError 转为 internal_error。
  return c.json({ ok: true as const, data: schema.parse(result.data) }, okStatus)
}

const usage = (message: string, details?: unknown) =>
  fail('usage', 'invalid_arguments', message, details)

/** 操作者取自 `X-Flow-Actor`，缺省为 `unknown`（design D7：仅作记录，不是安全边界）。 */
function actorOf(c: Context): Result<string> {
  const raw = c.req.header(HEADERS.actor)?.trim()
  if (raw === undefined || raw === '') return { ok: true, data: 'unknown' }
  return ACTOR_RE.test(raw)
    ? { ok: true, data: raw }
    : usage(`${HEADERS.actor} 格式不合法`, [
        { field: HEADERS.actor, code: 'invalid_field', message: '操作者标识格式不合法' },
      ])
}

/** 读取 JSON 请求体；空请求体视为 `{}`（仅当 allowEmpty）。 */
async function jsonBody(c: Context, allowEmpty: boolean): Promise<Result<unknown>> {
  const text = await c.req.text()
  if (text.trim() === '') {
    return allowEmpty ? { ok: true, data: {} } : usage('请求体不能为空，应为 JSON 对象')
  }
  try {
    return { ok: true, data: JSON.parse(text) }
  } catch {
    return usage('请求体不是合法的 JSON')
  }
}

export function createTaskRoutes(deps: TaskRoutesDeps): Hono {
  const { ledger, tasks } = deps
  const app = new Hono()

  app.post(ENDPOINTS['tasks-create'].path, async (c) => {
    const actor = actorOf(c)
    if (!actor.ok) return respond(c, actor, createTaskData)
    const body = await jsonBody(c, false)
    if (!body.ok) return respond(c, body, createTaskData)
    const r = await tasks.createTask(body.data, { actor: actor.data })
    return respond(c, r, createTaskData, r.ok && r.data.created ? 201 : 200)
  })

  app.get(ENDPOINTS['tasks-list'].path, (c) => {
    return respond(c, tasks.listTasks(c.req.query()), listTasksData)
  })

  app.get(ENDPOINTS['tasks-show'].path, (c) => {
    return respond(c, tasks.getTask(c.req.param('id')), showTaskData)
  })

  app.post(ENDPOINTS['tasks-cancel'].path, async (c) => {
    const actor = actorOf(c)
    if (!actor.ok) return respond(c, actor, cancelTaskData)
    const body = await jsonBody(c, true)
    if (!body.ok) return respond(c, body, cancelTaskData)
    const parsed = cancelTaskRequest.safeParse(body.data)
    if (!parsed.success) {
      const fields = fieldIssues(parsed.error.issues, body.data)
      return respond(
        c,
        usage(`请求体不合法：${fields.map((f) => f.message).join('；')}`, fields),
        cancelTaskData,
      )
    }
    const r = tasks.cancelTask(c.req.param('id'), {
      actor: actor.data,
      ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }),
    })
    return respond(c, r, cancelTaskData)
  })

  app.post(ENDPOINTS['hub-rebuild'].path, (c) => {
    const actor = actorOf(c)
    if (!actor.ok) return respond(c, actor, rebuildData)
    return respond(c, ledger.rebuild({ actor: actor.data }), rebuildData)
  })

  app.onError((err, c) => respond(c, fail('failure', 'internal_error', err.message), rebuildData))

  return app
}
