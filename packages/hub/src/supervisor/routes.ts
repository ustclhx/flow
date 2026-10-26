import {
  ENDPOINTS,
  fail,
  redactSecrets,
  supervisorStatusData,
  supervisorStatusQuery,
  supervisorWakeData,
  supervisorWakeRequest,
} from '@flow/core'
import { Hono } from 'hono'
import { jsonBody, respond } from '../ledger/routes.ts'
import { fieldIssues } from '../ledger/tasks.ts'
import { userOnly } from '../server/auth.ts'
import type { WakeScheduler } from './scheduler.ts'

/**
 * supervisor 唤醒的用户接口（add-m1-supervisor D2、D3；tasks 3.4）：`flow ask`、`flow supervisor wake`、
 * `flow supervisor status`。全部只接受 user 身份：AI、节点与唤醒 token 一律 `user_only`，
 * `user.instruction` 与 `supervisor.release` 因此只由用户写入（store 另有身份白名单兜底）。
 */
export function createSupervisorRoutes(deps: { scheduler: () => WakeScheduler | undefined }): Hono {
  const app = new Hono()
  const notReady = () => fail('retryable', 'hub_busy', '中枢尚未就绪，请稍后重试')
  const usage = (issues: Parameters<typeof fieldIssues>[0], data: unknown) => {
    const fields = fieldIssues(issues, data)
    return fail(
      'usage',
      'invalid_arguments',
      `请求不合法：${fields.map((f) => f.message).join('；')}`,
      fields,
    )
  }

  app.post(ENDPOINTS['supervisor-wake'].path, userOnly('唤醒 supervisor 或下达指令'), async (c) => {
    const body = await jsonBody(c, false)
    if (!body.ok) return respond(c, body, supervisorWakeData)
    const parsed = supervisorWakeRequest.safeParse(body.data)
    if (!parsed.success)
      return respond(c, usage(parsed.error.issues, body.data), supervisorWakeData)
    const scheduler = deps.scheduler()
    if (!scheduler) return respond(c, notReady(), supervisorWakeData)
    const { workspace, text, release, via } = parsed.data
    const r =
      release === undefined
        ? await scheduler.instruct(workspace, text, via)
        : await scheduler.release(workspace, release)
    return respond(c, r, supervisorWakeData)
  })

  app.get(ENDPOINTS['supervisor-status'].path, userOnly('查看 supervisor 状态'), async (c) => {
    const query = c.req.query()
    const parsed = supervisorStatusQuery.safeParse(query)
    if (!parsed.success) return respond(c, usage(parsed.error.issues, query), supervisorStatusData)
    const scheduler = deps.scheduler()
    if (!scheduler) return respond(c, notReady(), supervisorStatusData)
    return respond(c, await scheduler.status(parsed.data.workspace), supervisorStatusData)
  })

  app.onError((err, c) =>
    respond(c, fail('failure', 'internal_error', redactSecrets(err.message)), supervisorStatusData),
  )
  return app
}
