import {
  ENDPOINTS,
  fail,
  hubTokenId,
  issueTokenData,
  issueTokenRequest,
  listTokensData,
  ok,
  revokeTokenData,
} from '@flow/core'
import { Hono } from 'hono'
import { jsonBody, respond } from '../ledger/routes.ts'
import { fieldIssues } from '../ledger/tasks.ts'
import { userOnly } from './auth.ts'
import type { HubTokenStore } from './tokens.ts'

/** `flow hub token issue|list|revoke` 对应的路由；三个都只允许 user（design D9）。 */
export function createTokenRoutes(store: HubTokenStore): Hono {
  const app = new Hono()
  const guard = userOnly('管理中枢 token')
  app.use('/v1/hub/tokens', guard)
  app.use('/v1/hub/tokens/*', guard)

  app.post(ENDPOINTS['hub-tokens-issue'].path, async (c) => {
    const body = await jsonBody(c, false)
    if (!body.ok) return respond(c, body, issueTokenData)
    const parsed = issueTokenRequest.safeParse(body.data)
    if (!parsed.success) {
      const fields = fieldIssues(parsed.error.issues, body.data)
      return respond(
        c,
        fail(
          'usage',
          'invalid_arguments',
          `请求体不合法：${fields.map((f) => f.message).join('；')}`,
          fields,
        ),
        issueTokenData,
      )
    }
    return respond(c, await store.issue(parsed.data), issueTokenData, 201)
  })

  app.get(ENDPOINTS['hub-tokens-list'].path, (c) =>
    respond(c, ok({ tokens: store.list() }), listTokensData),
  )

  app.post(ENDPOINTS['hub-tokens-revoke'].path, async (c) => {
    const id = c.req.param('id')
    if (!hubTokenId.safeParse(id).success) {
      return respond(c, fail('usage', 'invalid_arguments', 'token id 格式不合法'), revokeTokenData)
    }
    return respond(c, await store.revoke(id), revokeTokenData)
  })

  return app
}
