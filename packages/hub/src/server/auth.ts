import { createHash, timingSafeEqual } from 'node:crypto'
import { ACTOR_RE, ENDPOINTS, HEADERS, USER_ACTOR } from '@flow/core'
import type { MiddlewareHandler } from 'hono'
import { errorResponse } from '../app.ts'
import type { BoundTokenLookup } from './tokens.ts'

/** 请求的认证方式：user token（`state/hub.token`）或绑定 token。 */
export type AuthInfo = { kind: 'user' } | { kind: 'bound'; token_id: string } | { kind: 'none' }

// 子应用无需额外的 Hono 泛型即可读取已校验的审计身份。
declare module 'hono' {
  interface ContextVariableMap {
    actor: string
    auth: AuthInfo
  }
}

const digest = (value: string) => createHash('sha256').update(value).digest()

/**
 * 鉴权中间件（hub-daemon "Token 认证"、design D9）。判定顺序：
 *
 * | token                 | X-Flow-Actor          | 结果                         |
 * |-----------------------|-----------------------|------------------------------|
 * | 缺失 / 不认识 / 已撤销 | 任意                  | 401 unauthorized             |
 * | user token            | 缺省或空              | user                         |
 * | user token            | user                  | user                         |
 * | user token            | 其他合法身份           | 该身份（只能降级）             |
 * | 任意有效 token         | 格式不合法             | 400 invalid_arguments        |
 * | 绑定 token            | 缺省、空或等于绑定身份 | 绑定身份                     |
 * | 绑定 token            | 其他（含 user）        | 403 actor_mismatch           |
 *
 * 摘要用常数时间比较；错误响应不包含凭证或账本信息。健康检查不鉴权，身份记为 `unknown`。
 */
export function hubAuth(token?: string, tokens?: BoundTokenLookup): MiddlewareHandler {
  const expected = digest(token ?? '')
  return async (c, next) => {
    if (c.req.method === ENDPOINTS.health.method && c.req.path === ENDPOINTS.health.path) {
      c.set('actor', 'unknown')
      c.set('auth', { kind: 'none' })
      await next()
      return
    }
    const header = c.req.header(HEADERS.authorization) ?? ''
    const presented = /^Bearer (\S+)$/i.exec(header)?.[1]
    if (!presented) return errorResponse(c, 'unauthorized', '未授权')
    const isUser =
      timingSafeEqual(digest(presented), expected) && token !== undefined && token !== ''
    // 两种 token 都检查，避免按 token 种类出现时间差。
    const bound = tokens?.authenticate(presented) ?? null
    if (!isUser && !bound) return errorResponse(c, 'unauthorized', '未授权')

    const declared = c.req.header(HEADERS.actor)?.trim() ?? ''
    if (declared !== '' && !ACTOR_RE.test(declared)) {
      return errorResponse(c, 'invalid_arguments', '操作者标识格式不合法')
    }
    if (isUser) {
      c.set('actor', declared === '' ? USER_ACTOR : declared)
      c.set('auth', { kind: 'user' })
    } else if (bound) {
      if (declared !== '' && declared !== bound.actor) {
        return errorResponse(
          c,
          'actor_mismatch',
          `该 token 绑定的身份为 ${bound.actor}，不能声明为 ${declared}`,
        )
      }
      c.set('actor', bound.actor)
      c.set('auth', { kind: 'bound', token_id: bound.id })
    }
    await next()
  }
}

/**
 * 只有用户能做的操作（hub-daemon "只有用户能做的操作"）：身份不是 user 时返回 403 `user_only`，
 * 在读取请求体和调用服务之前拒绝，因此不会产生任何事件。
 */
export function userOnly(what: string): MiddlewareHandler {
  return async (c, next) => {
    const who = c.get('actor')
    if (who !== USER_ACTOR) {
      return errorResponse(c, 'user_only', `只有用户本人可以${what}，当前身份为 ${who}`)
    }
    await next()
  }
}
