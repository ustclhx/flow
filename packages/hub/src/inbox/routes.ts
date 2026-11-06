import {
  ENDPOINTS,
  fail,
  inboxActData,
  inboxActRequest,
  inboxListData,
  inboxListQuery,
  ok,
  USER_ACTOR,
} from '@raindown/core'
import { Hono } from 'hono'
import { jsonBody, respond } from '../ledger/routes.ts'
import { actOnInbox, type InboxActionDeps } from './actions.ts'
import { readInboxItem } from './read.ts'
import { stripObserveLine } from './reactor.ts'

export function createInboxRoutes(deps: InboxActionDeps): Hono {
  const app = new Hono()
  app.get(ENDPOINTS['inbox-list'].path, (c) => {
    const parsed = inboxListQuery.safeParse(c.req.query())
    // observe 判断（D10）只给用户看：其他调用方（AI 身份、任务绑定、supervisor 唤醒）拿到的正文去掉 observe 行。
    const forUser = c.get('actor') === USER_ACTOR && c.get('auth')?.kind !== 'wake'
    return respond(
      c,
      parsed.success
        ? ok({
            items: deps.ledger
              .listInboxItems({
                state: parsed.data.state,
                ...(parsed.data.level ? { level: parsed.data.level } : {}),
                ...(parsed.data.workspace ? { workspace: parsed.data.workspace } : {}),
                limit: -1,
              })
              .map((item) => {
                const view = readInboxItem(deps.ledger, item)
                return forUser ? view : { ...view, body: stripObserveLine(view.body) }
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
        auth?.kind === 'wake'
          ? { workspace: auth.wake.workspace, origin: auth.wake.origin }
          : undefined,
      ),
      inboxActData,
    )
  })
  return app
}
