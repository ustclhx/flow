import {
  ENDPOINTS,
  fail,
  ok,
  type Result,
  telegramLinkCodeData,
  telegramLinkCodeRequest,
  telegramUnlinkData,
} from '@flow/core'
import { Hono } from 'hono'
import { respond } from '../../ledger/routes.ts'
import { userOnly } from '../../server/auth.ts'
import type { TelegramLinks } from './link.ts'

/**
 * Telegram 绑定相关的路由（经 `/v1` 的 Bearer 鉴权，仅 user；user token 降级声明的 AI 身份同样被拒绝）：
 * - `POST /v1/telegram/link-code`：申请绑定码。渠道没有在运行时返回 `channel_unavailable`；
 *   已绑定时必须带 `rebind: true`，否则返回 `already_bound`（防止静默改绑）；
 * - `POST /v1/telegram/unlink`：解除绑定（`flow telegram unlink`）。
 *
 * 已知边界：本机能读 `state/hub.token` 的进程（包括 worker）都能以 user 身份申请改绑码，
 * 所以改绑成功前一定会通知原 chat（plugin.ts）。
 */
export function createTelegramRoutes(o: {
  links: TelegramLinks
  /** 渠道不可用时返回原因；可用时返回 null。 */
  unavailable: () => string | null
  /** 当前是否已绑定（读 config/channels.yaml）。 */
  isBound: () => Promise<boolean>
  unlink: () => Promise<Result<{ unlinked: boolean }>>
}): Hono {
  const app = new Hono()
  app.post(ENDPOINTS['telegram-link-code'].path, userOnly('申请 Telegram 绑定码'), async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const input = telegramLinkCodeRequest.safeParse(body ?? {})
    if (!input.success) {
      return respond(c, fail('usage', 'invalid_arguments', '请求参数不合法'), telegramLinkCodeData)
    }
    const reason = o.unavailable()
    if (reason) {
      return respond(c, fail('failure', 'channel_unavailable', reason), telegramLinkCodeData)
    }
    if (!input.data.rebind && (await o.isBound())) {
      return respond(
        c,
        fail(
          'failure',
          'already_bound',
          'Telegram 已绑定。要改绑到另一个账号请运行 flow telegram link --rebind（原账号会收到通知）',
        ),
        telegramLinkCodeData,
      )
    }
    const issued = o.links.issue()
    const username = o.links.botUsername
    return respond(
      c,
      ok({
        code: issued.code,
        command: `/link ${issued.code}`,
        link_url: username ? `https://t.me/${username}?start=${issued.code}` : null,
        expires_at: issued.expires_at,
      }),
      telegramLinkCodeData,
      201,
    )
  })
  app.post(ENDPOINTS['telegram-unlink'].path, userOnly('解除 Telegram 绑定'), async (c) =>
    respond(c, await o.unlink(), telegramUnlinkData),
  )
  return app
}
