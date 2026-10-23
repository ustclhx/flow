import { createHash, timingSafeEqual } from 'node:crypto'
import { actor, ENDPOINTS, HEADERS } from '@flow/core'
import type { MiddlewareHandler } from 'hono'
import { errorResponse } from '../app.ts'

// 子应用无需额外的 Hono 泛型即可读取已校验的审计身份。
declare module 'hono' {
  interface ContextVariableMap {
    actor: string
  }
}

/** 对固定长度摘要做常数时间比较，错误响应不包含凭证或账本信息。 */
export function hubAuth(token?: string): MiddlewareHandler {
  const digest = (value: string) => createHash('sha256').update(value).digest()
  const expected = digest(token ?? '')
  return async (c, next) => {
    if (!(c.req.method === ENDPOINTS.health.method && c.req.path === ENDPOINTS.health.path)) {
      const header = c.req.header(HEADERS.authorization) ?? ''
      const match = /^Bearer (\S+)$/i.exec(header)
      const valid = timingSafeEqual(digest(match?.[1] ?? ''), expected)
      if (!token || !match || !valid) return errorResponse(c, 'unauthorized', '未授权')
    }
    const identity = actor.safeParse(c.req.header(HEADERS.actor) || 'unknown')
    if (!identity.success) return errorResponse(c, 'invalid_arguments', '操作者标识格式不合法')
    c.set('actor', identity.data)
    await next()
  }
}
