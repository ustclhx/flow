import {
  cancelTaskData,
  cancelTaskRequest,
  createTaskData,
  ENDPOINTS,
  eventGetData,
  eventGetQuery,
  fail,
  listTasksData,
  ok,
  PROTOCOL_ERRORS,
  type Result,
  rebuildData,
  redactSecrets,
  replyTaskData,
  retryTaskData,
  retryTaskRequest,
  showTaskQuery,
  taskShowResponse,
  toJsonDocument,
  USER_ACTOR,
} from '@raindown/core'
import { type Context, Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { z } from 'zod'
import { redactDeep } from '../secrets/redactor.ts'
import { userOnly } from '../server/auth.ts'
import type { LedgerStore } from './store.ts'
import { fieldIssues, type TaskService } from './tasks.ts'

/**
 * 任务相关路由（protocol.ts 的 tasks-create / tasks-list / tasks-show / tasks-cancel / tasks-reply，
 * 以及 hub-rebuild）。作为独立的 Hono 子应用导出，由中枢主应用挂载（`app.route('/', ...)`）；
 * 认证中间件由主应用负责，这里不处理。
 */

export interface TaskRoutesDeps {
  ledger: Pick<LedgerStore, 'rebuild' | 'eventsAfter' | 'getTask' | 'wakeOf'>
  tasks: TaskService
}

/** 协议错误码对应的 HTTP 状态；不在 PROTOCOL_ERRORS 中的码按类别回退。 */
function statusOf(code: string, kind: string): number {
  if (code in PROTOCOL_ERRORS) return PROTOCOL_ERRORS[code as keyof typeof PROTOCOL_ERRORS].status
  return kind === 'usage' ? 400 : kind === 'retryable' ? 503 : 500
}

export function respond<T>(
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

/**
 * 操作者由主应用的鉴权中间件按 token 决定（design D9），这里只读取结果。
 * 单独挂载（测试）而没有经过鉴权时，记为 `unknown`。
 */
function actorOf(c: Context): Result<string> {
  return { ok: true, data: c.get('actor') ?? 'unknown' }
}

/** 读取 JSON 请求体；空请求体视为 `{}`（仅当 allowEmpty）。 */
export async function jsonBody(c: Context, allowEmpty: boolean): Promise<Result<unknown>> {
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
    // 调用方唤醒只取自鉴权中间件按唤醒绑定 token 认定的结果（D6），不读请求体或请求头。
    const auth = c.get('auth')
    const r = await tasks.createTask(body.data, {
      actor: actor.data,
      ...(auth?.kind === 'wake' ? { wake: { task_id: auth.wake.task_id } } : {}),
    })
    return respond(c, r, createTaskData, r.ok && r.data.created ? 201 : 200)
  })

  app.get(ENDPOINTS['tasks-list'].path, (c) => {
    const query = c.req.query()
    const auth = c.get('auth')
    // PR 关联读取指针同样按可信唤醒检查范围，不能通过修改指针参数跨 workspace。
    if (auth?.kind === 'wake' && query.pr !== undefined) {
      if (query.workspace !== undefined && query.workspace !== auth.wake.workspace)
        return respond(c, fail('failure', 'not_found', '没有可见的 PR 任务列表'), listTasksData)
      query.workspace = auth.wake.workspace
    }
    return respond(c, tasks.listTasks(query), listTasksData)
  })

  app.get(ENDPOINTS['tasks-show'].path, (c) => {
    const parsed = showTaskQuery.safeParse(c.req.query())
    if (!parsed.success)
      return respond(c, usage('任务详情查询参数不合法', parsed.error.issues), taskShowResponse)
    const id = c.req.param('id')
    const auth = c.get('auth')
    const task = ledger.getTask(id)
    if (task && auth?.kind === 'wake' && task.workspace !== auth.wake.workspace) {
      return respond(c, fail('failure', 'not_found', `没有任务 ${id}`), taskShowResponse)
    }
    return respond(c, tasks.getTask(id, parsed.data), taskShowResponse)
  })

  app.get(ENDPOINTS['events-get'].path, (c) => {
    const auth = c.get('auth')
    // 事件可见范围只取自中枢校验的任务或唤醒凭证。
    if (auth?.kind !== 'wake' && auth?.kind !== 'task' && c.get('actor') !== USER_ACTOR)
      return respond(
        c,
        fail('failure', 'forbidden', '只有用户、任务绑定与 supervisor 唤醒可以读取事件'),
        eventGetData,
      )
    const parsed = eventGetQuery.safeParse({ seq: c.req.param('id') })
    if (!parsed.success)
      return respond(c, usage('事件序号必须为正整数', parsed.error.issues), eventGetData)
    const { seq } = parsed.data
    const event = ledger.eventsAfter(seq - 1, undefined, 1)[0]
    if (
      event?.seq !== seq ||
      (auth?.kind === 'task' &&
        (event.task_id !== auth.task.task_id || event.workspace !== auth.task.workspace))
    )
      return respond(c, fail('failure', 'not_found', '账本事件不存在'), eventGetData)
    if (auth?.kind === 'wake') {
      const visible =
        event.workspace === auth.wake.workspace ||
        (event.workspace === undefined && ledger.wakeOf(auth.wake.task_id)?.events.includes(seq))
      if (!visible)
        return respond(c, fail('failure', 'forbidden', '本次唤醒不能读取该事件'), eventGetData)
    }
    return respond(
      c,
      ok({ event: { ...event, payload: redactDeep(event.payload, redactSecrets) } }),
      eventGetData,
    )
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
    const auth = c.get('auth')
    const r = tasks.cancelTask(c.req.param('id'), {
      actor: actor.data,
      ...(auth?.kind === 'wake'
        ? { wake: { task_id: auth.wake.task_id, workspace: auth.wake.workspace } }
        : {}),
      ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }),
    })
    return respond(c, r, cancelTaskData)
  })

  app.post(ENDPOINTS['tasks-retry'].path, async (c) => {
    const actor = actorOf(c)
    if (!actor.ok) return respond(c, actor, retryTaskData)
    const body = await jsonBody(c, true)
    if (!body.ok) return respond(c, body, retryTaskData)
    const parsed = retryTaskRequest.safeParse(body.data)
    if (!parsed.success) {
      const fields = fieldIssues(parsed.error.issues, body.data)
      return respond(
        c,
        usage(`请求体不合法：${fields.map((f) => f.message).join('；')}`, fields),
        retryTaskData,
      )
    }
    const auth = c.get('auth')
    return respond(
      c,
      await tasks.retryTask(c.req.param('id'), {
        actor: actor.data,
        ...(auth?.kind === 'wake' ? { wake: { task_id: auth.wake.task_id } } : {}),
        ...(parsed.data.reason === undefined ? {} : { reason: parsed.data.reason }),
      }),
      retryTaskData,
    )
  })

  // 回复卡住的任务只有用户能做：在读取请求体之前按身份拒绝，不产生任何事件。
  app.post(ENDPOINTS['tasks-reply'].path, userOnly('回复卡住的任务'), async (c) => {
    const actor = actorOf(c)
    if (!actor.ok) return respond(c, actor, replyTaskData)
    const body = await jsonBody(c, false)
    if (!body.ok) return respond(c, body, replyTaskData)
    return respond(
      c,
      tasks.replyTask(c.req.param('id'), body.data, { actor: actor.data }),
      replyTaskData,
    )
  })

  // 重建投影只有用户能做（审查意见：AI 与节点身份不应触发全量重放）。
  app.post(ENDPOINTS['hub-rebuild'].path, userOnly('重建投影'), (c) => {
    const actor = actorOf(c)
    if (!actor.ok) return respond(c, actor, rebuildData)
    return respond(c, ledger.rebuild({ actor: actor.data }), rebuildData)
  })

  app.onError((err, c) =>
    respond(c, fail('failure', 'internal_error', redactSecrets(err.message)), rebuildData),
  )

  return app
}
