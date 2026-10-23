import {
  fail,
  type HealthData,
  PROTOCOL_ERRORS,
  type ProtocolErrorCode,
  toJsonDocument,
  VERSION,
} from '@flow/core'
import type { Context } from 'hono'
import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

/**
 * 中枢的 HTTP 应用（design D3）。这里只定义路由，不感知运行时；
 * 启动与监听在 `serve.ts`。
 *
 * 目前只有 `GET /v1/health`（add-m1-ledger-daemon 1.2）。账本、认证、事件流、
 * 节点与租约路由由第 2–4 组在此基础上加入。
 */

export interface HubDeps {
  /** 中枢版本，默认 `@flow/core` 的 VERSION。 */
  version?: string
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
  const now = deps.now ?? Date.now
  const startedAt = deps.startedAt ?? now()
  const ledgerSeq = deps.ledgerSeq ?? (() => 0)

  const app = new Hono()

  app.get('/v1/health', (c) => {
    const data: HealthData = {
      version,
      uptime: Math.max(0, (now() - startedAt) / 1000),
      ledger_seq: ledgerSeq(),
    }
    return c.json({ ok: true as const, data })
  })

  app.notFound((c) => errorResponse(c, 'not_found', `没有这个接口：${c.req.method} ${c.req.path}`))
  app.onError((err, c) => errorResponse(c, 'internal_error', err.message))

  return app
}
