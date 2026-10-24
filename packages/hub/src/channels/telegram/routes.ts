import { ENDPOINTS, fail, ok, telegramLinkCodeData } from '@flow/core'
import { Hono } from 'hono'
import { respond } from '../../ledger/routes.ts'
import { userOnly } from '../../server/auth.ts'
import type { TelegramLinks } from './link.ts'

/**
 * `POST /v1/telegram/link-code`：经 `/v1` 的 Bearer 鉴权，仅 user（`flow telegram link` 调用）。
 * Telegram 渠道没有在运行（缺少 token、token 无效或已停用）时返回 `channel_unavailable`：
 * 这时 bot 收不到绑定码，申请了也没用。
 */
export function createTelegramRoutes(o: {
  links: TelegramLinks
  /** 渠道不可用时返回原因；可用时返回 null。 */
  unavailable: () => string | null
}): Hono {
  const app = new Hono()
  app.post(ENDPOINTS['telegram-link-code'].path, userOnly('申请 Telegram 绑定码'), (c) => {
    const reason = o.unavailable()
    if (reason)
      return respond(c, fail('failure', 'channel_unavailable', reason), telegramLinkCodeData)
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
  return app
}
