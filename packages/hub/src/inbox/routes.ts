import {
  ENDPOINTS,
  fail,
  inboxActData,
  inboxActRequest,
  inboxListData,
  inboxListQuery,
  ok,
} from '@flow/core'
import { Hono } from 'hono'
import { jsonBody, respond } from '../ledger/routes.ts'
import { actOnInbox, type InboxActionDeps } from './actions.ts'

export function createInboxRoutes(deps: InboxActionDeps): Hono {
  const app = new Hono()
  app.get(ENDPOINTS['inbox-list'].path, (c) => {
    const parsed = inboxListQuery.safeParse(c.req.query())
    return respond(
      c,
      parsed.success
        ? ok({
            items: deps.ledger.listInboxItems({
              state: parsed.data.state,
              ...(parsed.data.level ? { level: parsed.data.level } : {}),
              ...(parsed.data.workspace ? { workspace: parsed.data.workspace } : {}),
              limit: -1,
            }),
          })
        : fail('usage', 'invalid_arguments', '收件箱查询参数不合法'),
      inboxListData,
    )
  })
  app.post(ENDPOINTS['inbox-act'].path, async (c) => {
    const body = await jsonBody(c, false)
    if (!body.ok) return respond(c, body, inboxActData)
    const parsed = inboxActRequest.safeParse(body.data)
    if (!parsed.success) {
      return respond(c, fail('usage', 'invalid_arguments', '条目操作参数不合法'), inboxActData)
    }
    const auth = c.get('auth')
    return respond(
      c,
      await actOnInbox(
        deps,
        c.req.param('id'),
        parsed.data,
        c.get('actor') ?? 'unknown',
        auth?.kind === 'wake' ? { workspace: auth.wake.workspace } : undefined,
      ),
      inboxActData,
    )
  })
  return app
}
