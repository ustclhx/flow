import {
  askUserData,
  askUserRequest,
  decisionReviewData,
  decisionReviewRequest,
  ENDPOINTS,
  fail,
  mergeRequestData,
  mergeRequestRequest,
  type Result,
  taskProposeData,
  taskProposeRequest,
  taskRespondData,
  taskRespondRequest,
} from '@flow/core'
import { type Context, Hono } from 'hono'
import type { z } from 'zod'
import { jsonBody, respond } from '../ledger/routes.ts'
import { fieldIssues } from '../ledger/tasks.ts'
import { checkWakeCaller, type SupervisorToolsDeps, wakeCallerOf } from './common.ts'
import { decisionReview } from './decisions.ts'
import { requestMerge } from './merge-requests.ts'
import { askUser } from './questions.ts'
import { proposeTask } from './task-proposals.ts'

/**
 * `POST /v1/supervisor/questions`（ask_user）、`POST /v1/task-proposals`（task_propose）、
 * `POST /v1/decisions/review`（decision_review）、`POST /v1/merge-requests`（pr_merge_request）：
 * 只限非 reply 的 supervisor 唤醒 token（D6、D15）。
 * `POST /v1/supervisor/respond`（task_respond）：只限 reply 唤醒 token（D15）。
 */
export function createSupervisorToolRoutes(deps: SupervisorToolsDeps): Hono {
  const app = new Hono()

  async function parse<S extends z.ZodType>(c: Context, schema: S): Promise<Result<z.infer<S>>> {
    const body = await jsonBody(c, false)
    if (!body.ok) return body
    const parsed = schema.safeParse(body.data)
    if (parsed.success) return { ok: true, data: parsed.data }
    const fields = fieldIssues(parsed.error.issues, body.data)
    return fail(
      'usage',
      'invalid_arguments',
      `请求体不合法：${fields.map((f) => f.message).join('；')}`,
      fields,
    )
  }

  const actorOf = (c: Context) => c.get('actor') ?? 'unknown'

  app.post(ENDPOINTS['supervisor-ask'].path, async (c) => {
    const input = await parse(c, askUserRequest)
    if (!input.ok) return respond(c, input, askUserData)
    const caller = checkWakeCaller('ask_user', actorOf(c), wakeCallerOf(c), input.data.workspace)
    if (!caller.ok) return respond(c, caller, askUserData)
    return respond(c, await askUser(deps, caller.data, input.data), askUserData, 201)
  })

  app.post(ENDPOINTS['task-proposals-create'].path, async (c) => {
    const input = await parse(c, taskProposeRequest)
    if (!input.ok) return respond(c, input, taskProposeData)
    const caller = checkWakeCaller(
      'task_propose',
      actorOf(c),
      wakeCallerOf(c),
      input.data.draft.workspace,
    )
    if (!caller.ok) return respond(c, caller, taskProposeData)
    return respond(c, await proposeTask(deps, caller.data, input.data), taskProposeData, 201)
  })

  app.post(ENDPOINTS['decisions-review'].path, async (c) => {
    const input = await parse(c, decisionReviewRequest)
    if (!input.ok) return respond(c, input, decisionReviewData)
    const caller = checkWakeCaller('decision_review', actorOf(c), wakeCallerOf(c))
    if (!caller.ok) return respond(c, caller, decisionReviewData)
    return respond(c, await decisionReview(deps, caller.data, input.data), decisionReviewData)
  })

  app.post(ENDPOINTS['merge-requests-create'].path, async (c) => {
    const input = await parse(c, mergeRequestRequest)
    if (!input.ok) return respond(c, input, mergeRequestData)
    const caller = checkWakeCaller('pr_merge_request', actorOf(c), wakeCallerOf(c))
    if (!caller.ok) return respond(c, caller, mergeRequestData)
    return respond(c, await requestMerge(deps, caller.data, input.data), mergeRequestData, 201)
  })

  // task_respond（D15、tasks 4.9）：只限被分配该委托的 reply 唤醒；核对在 store 同一事务里完成。
  app.post(ENDPOINTS['supervisor-respond'].path, async (c) => {
    const input = await parse(c, taskRespondRequest)
    if (!input.ok) return respond(c, input, taskRespondData)
    if (!deps.delegation) {
      return respond(c, fail('failure', 'action_not_available', '代回复尚未启用'), taskRespondData)
    }
    return respond(
      c,
      deps.delegation.respond(actorOf(c), wakeCallerOf(c), input.data),
      taskRespondData,
    )
  })

  return app
}
