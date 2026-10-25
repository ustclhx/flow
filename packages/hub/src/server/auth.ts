import { createHash, timingSafeEqual } from 'node:crypto'
import {
  ACTOR_RE,
  ENDPOINTS,
  type EndpointName,
  HEADERS,
  isDeclarableActor,
  isNodeActor,
  USER_ACTOR,
} from '@flow/core'
import type { Context, MiddlewareHandler } from 'hono'
import { errorResponse } from '../app.ts'
import type { BoundTokenLookup } from './tokens.ts'

/** 请求的认证方式：user token（`state/hub.token`）或绑定 token。 */
export type AuthInfo =
  | { kind: 'user' }
  | { kind: 'bound'; token_id: string; remote: boolean }
  | { kind: 'none' }

// 子应用无需额外的 Hono 泛型即可读取已校验的审计身份。
declare module 'hono' {
  interface ContextVariableMap {
    actor: string
    auth: AuthInfo
  }
}

const digest = (value: string) => createHash('sha256').update(value).digest()

export interface HubAuthOptions {
  /** user token（`state/hub.token`）。 */
  token?: string
  tokens?: BoundTokenLookup
  /** 某任务未过期的活动租约所属节点 id；用于任务详情与策略检查的 scope 校验。 */
  leaseHolders?: (taskId: string) => readonly string[]
}

/**
 * node:* 身份可以访问的接口；任务详情与策略检查还要校验任务级 scope。
 * 创建任务（`POST /v1/tasks`）允许节点拆子任务，但只能创建 `creatable_by` 匹配该节点的角色，
 * 由任务服务校验（403 `role_not_allowed`）；列出任务等其他 `/v1/tasks` 接口仍然拒绝。
 */
const NODE_ENDPOINTS: readonly EndpointName[] = [
  'tasks-create',
  'policy-check',
  'nodes-register',
  'leases-acquire',
  'leases-renew',
  'leases-complete',
  'leases-ack-reply',
]

const matcher = (name: EndpointName) => {
  const { method, path } = ENDPOINTS[name]
  const re = new RegExp(`^${path.replace(/:id/g, '([^/]+)')}$`)
  return (c: Context) => (c.req.method === method ? re.exec(c.req.path) : null)
}
const nodeMatchers = NODE_ENDPOINTS.map((n) => ({ name: n, match: matcher(n) }))
const taskShow = matcher('tasks-show')
const policyCheck = matcher('policy-check')

/** 任务级 scope：user 可调试任意任务；节点只能操作自己持有未过期活动租约的任务。 */
export function checkTaskScope(
  c: Context,
  taskId: string,
  leaseHolders: HubAuthOptions['leaseHolders'],
): Response | null {
  const actor = c.get('actor')
  if (actor === USER_ACTOR) return null
  if (isNodeActor(actor) && leaseHolders?.(taskId).includes(actor.slice('node:'.length)))
    return null
  return errorResponse(c, 'scope_denied', `身份 ${actor} 不能访问该任务`)
}

/**
 * node:* 身份的权限范围：节点协议接口，以及自己持有活动租约任务的详情和策略检查。
 * 策略检查需要先校验请求并查到任务，再在路由中调用 checkTaskScope。
 * 注册与领取时，请求体中的 node_id 必须与身份一致。
 */
async function checkNodeScope(
  c: Context,
  actor: string,
  leaseHolders: HubAuthOptions['leaseHolders'],
): Promise<Response | null> {
  const nodeId = actor.slice('node:'.length)
  const denied = () => errorResponse(c, 'scope_denied', `节点身份 ${actor} 不能访问该接口`)
  const hit = nodeMatchers.find((m) => m.match(c))
  if (hit) {
    if (hit.name === 'nodes-register' || hit.name === 'leases-acquire') {
      let bodyNode: unknown
      try {
        // Hono 缓存请求体，后续路由仍可再次读取。
        bodyNode = (JSON.parse(await c.req.text()) as { node_id?: unknown } | null)?.node_id
      } catch {
        bodyNode = undefined
      }
      if (bodyNode !== undefined && bodyNode !== nodeId) {
        return errorResponse(c, 'scope_denied', `节点身份 ${actor} 不能代表 ${String(bodyNode)}`)
      }
    }
    return null
  }
  const show = taskShow(c)
  if (show?.[1]) return checkTaskScope(c, decodeURIComponent(show[1]), leaseHolders)
  return denied()
}

/**
 * 鉴权中间件（hub-daemon "Token 认证"、design D9）。判定表见 `docs/hub-auth.md`：
 *
 * | token                  | X-Flow-Actor                    | 结果                    |
 * |------------------------|---------------------------------|-------------------------|
 * | 缺失 / 不认识 / 已撤销  | 任意                            | 401 unauthorized        |
 * | 任意有效 token          | 格式不合法                       | 400 invalid_arguments   |
 * | user token             | 缺省、空或 user                  | user                    |
 * | user token             | 保留身份（不分大小写）或 node:*  | 403 reserved_actor      |
 * | user token             | 其他合法身份                     | 该身份（只能降级）        |
 * | 绑定 token             | 与绑定身份不一致（含 user）       | 403 actor_mismatch      |
 * | 绑定 token（remote）    | 缺省或一致                       | 403 remote_not_allowed  |
 * | 绑定 token（node:<id>） | 缺省或一致                       | node:<id>，限节点协议与创建任务 |
 *
 * 摘要用常数时间比较；错误响应不包含凭证或账本信息。健康检查不鉴权，身份记为 `unknown`。
 */
export function hubAuth(options: HubAuthOptions = {}): MiddlewareHandler {
  const { token, tokens, leaseHolders } = options
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
    let actor: string
    if (isUser) {
      if (declared !== '' && !isDeclarableActor(declared)) {
        return errorResponse(
          c,
          'reserved_actor',
          `不能声明保留身份 ${declared}（user 之外的保留身份与 node:* 由中枢设置）`,
        )
      }
      actor = declared === '' ? USER_ACTOR : declared
      c.set('auth', { kind: 'user' })
    } else if (bound) {
      if (declared !== '' && declared !== bound.actor) {
        return errorResponse(
          c,
          'actor_mismatch',
          `该 token 绑定的身份为 ${bound.actor}，不能声明为 ${declared}`,
        )
      }
      if (bound.remote) {
        return errorResponse(
          c,
          'remote_not_allowed',
          '远程 token 只能用于远程入口，不能访问本机端口',
        )
      }
      actor = bound.actor
      c.set('auth', { kind: 'bound', token_id: bound.id, remote: bound.remote })
    } else return errorResponse(c, 'unauthorized', '未授权')
    c.set('actor', actor)
    if (policyCheck(c) && actor !== USER_ACTOR && !isNodeActor(actor)) {
      return errorResponse(c, 'scope_denied', '策略检查只允许 user 或持有活动租约的节点调用')
    }
    if (isNodeActor(actor)) {
      const denied = await checkNodeScope(c, actor, leaseHolders)
      if (denied) return denied
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
