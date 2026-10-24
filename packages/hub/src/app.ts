import {
  ENDPOINTS,
  fail,
  type HealthData,
  PROTOCOL_ERRORS,
  type ProtocolErrorCode,
  redactSecrets,
  toJsonDocument,
  VERSION,
} from '@flow/core'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { LedgerReader } from './ledger/port.ts'
import { hubAuth } from './server/auth.ts'
import type { HubClock } from './server/clock.ts'
import { createEventsApp } from './server/events.ts'
import { createTokenRoutes } from './server/token-routes.ts'
import type { HubTokenStore } from './server/tokens.ts'

/**
 * 中枢的 HTTP 应用（design D3）。这里只定义路由，不感知运行时；
 * 启动与监听在 `serve.ts`。
 *
 * 认证和 actor 先于所有 /v1 路由；账本与节点的子应用由 mount 组合。
 */

export interface HubDeps {
  /** 中枢版本，默认 `@flow/core` 的 VERSION。 */
  version?: string
  /** user token（`state/hub.token`）。不提供时，只有绑定 token 能访问受保护路由。 */
  token?: string
  /** 绑定 token 的存储；提供时启用绑定 token 鉴权并挂载 token 管理路由。 */
  tokens?: HubTokenStore
  ledger?: LedgerReader
  mount?: Array<{ path: string; app: Hono }>
  clock?: HubClock
  signal?: AbortSignal
  /** 毫秒时钟，默认 `Date.now`；测试可注入。 */
  now?: () => number
  /** 启动时刻（毫秒），默认创建 app 的时刻。 */
  startedAt?: number
  /** 账本最新序号；账本实现之前恒为 0。 */
  ledgerSeq?: () => number
}

/** 以协议错误码返回失败响应，形态与 CLI `--json` 一致。 */
export function errorResponse(
  c: Context,
  code: ProtocolErrorCode,
  message: string,
  details?: unknown,
): Response {
  const { status, kind } = PROTOCOL_ERRORS[code]
  return c.json(toJsonDocument(fail(kind, code, message, details)), status as ContentfulStatusCode)
}

export function createHubApp(deps: HubDeps = {}): Hono {
  const version = deps.version ?? VERSION
  const now = deps.now ?? deps.clock?.now.bind(deps.clock) ?? Date.now
  const startedAt = deps.startedAt ?? now()
  const ledger = deps.ledger
  const ledgerSeq = ledger ? () => ledger.seq() : (deps.ledgerSeq ?? (() => 0))

  const app = new Hono()
  app.use('/v1/*', hubAuth(deps.token, deps.tokens))
  if (deps.tokens) app.route('/', createTokenRoutes(deps.tokens))

  app.get(ENDPOINTS.health.path, (c) => {
    const data: HealthData = {
      version,
      uptime: Math.max(0, (now() - startedAt) / 1000),
      ledger_seq: ledgerSeq(),
    }
    return c.json({ ok: true as const, data })
  })

  if (deps.ledger) {
    app.route(
      '/',
      createEventsApp(deps.ledger, {
        ...(deps.clock ? { clock: deps.clock } : {}),
        ...(deps.signal ? { signal: deps.signal } : {}),
      }),
    )
  }
  for (const { path, app: child } of deps.mount ?? []) app.route(path, child)

  app.notFound((c) => errorResponse(c, 'not_found', `没有这个接口：${c.req.method} ${c.req.path}`))
  app.onError((err, c) => errorResponse(c, 'internal_error', redactSecrets(err.message)))

  return app
}
