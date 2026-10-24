/** @jsxImportSource hono/jsx */
import {
  ENDPOINTS,
  fail,
  INBOX_ACTIONS,
  INBOX_LEVELS,
  type InboxItemView,
  inboxActData,
  ok,
  redactSecrets,
  toJsonDocument,
  uiLoginCodeData,
} from '@flow/core'
import type { Context, MiddlewareHandler } from 'hono'
import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { html } from 'hono/html'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import { actOnInbox, type InboxActionDeps } from '../inbox/actions.ts'
import { respond } from '../ledger/routes.ts'
import { userOnly } from '../server/auth.ts'
import { APP_CSS, APP_JS, ICON_SVG } from './assets.ts'
import { Board, type BoardModel, BoardPage, LoginPage, type UiItem } from './page.tsx'
import { SESSION_TTL_MS, type UiSessions } from './sessions.ts'

/**
 * "需要我的"页面（add-m1-inbox 6.1，design D5；inbox-web spec）。
 *
 * 与 `/v1` 分开的鉴权路径：
 * - 只接受 Host 为 `127.0.0.1:<端口>` 或 `localhost:<端口>` 的请求（防 DNS rebinding），
 *   中枢本身只监听回环地址；
 * - 会话 cookie 只对 `/ui` 路径有效（Path=/ui），`/v1` 的鉴权只认 Bearer token，不读 cookie；
 * - 写操作只走 `/ui` 下的专用接口，校验会话与 Origin（必须是本机地址和同一端口，缺少 Origin 一律拒绝），
 *   再以 `user` 身份、`via: web` 调用收件箱的内部操作。
 */

export const SESSION_COOKIE = 'flow_ui_session'
/** 输出片段的长度上限（字符），与渠道默认的截断长度一致（notify-channel spec）。 */
export const SNIPPET_MAX = 1500

/** `/ui` 下所有响应都带的安全头。 */
export const UI_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; " +
    "form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
}

export interface UiAppDeps {
  sessions: UiSessions
  inbox: InboxActionDeps
  /** 中枢实际监听的端口；尚未监听（未知）时拒绝所有 `/ui` 请求。 */
  port: () => number | undefined
  /** 操作完成后等收件箱反应器处理完，使随后的刷新看到最新状态。 */
  settle?: () => Promise<void>
  now?: () => number
}

const uiActRequest = z.strictObject({
  action: z.enum([...INBOX_ACTIONS, 'dismiss']),
  text: z.string().trim().min(1).max(16_384).optional(),
})

function uiError(c: Context, status: ContentfulStatusCode, code: string, message: string) {
  return c.json(toJsonDocument(fail('failure', code, message)), status)
}

const allowedHosts = (port: number) => [`127.0.0.1:${port}`, `localhost:${port}`]

/** Host 校验与安全头。 */
function guard(port: () => number | undefined): MiddlewareHandler {
  return async (c, next) => {
    const p = port()
    const host = (c.req.header('host') ?? '').toLowerCase()
    if (p === undefined || !allowedHosts(p).includes(host)) {
      c.res = c.text('Host 不被允许：只能通过 http://127.0.0.1 或 http://localhost 访问', 421)
    } else {
      await next()
    }
    for (const [k, v] of Object.entries(UI_SECURITY_HEADERS)) c.res.headers.set(k, v)
    if (!c.res.headers.has('Cache-Control')) c.res.headers.set('Cache-Control', 'no-store')
  }
}

/** 写操作的 Origin 校验（CSRF 防护，与 SameSite=Strict 配合）。 */
function sameOrigin(c: Context, port: number): boolean {
  const origin = c.req.header('origin')
  if (!origin) return false
  if (!allowedHosts(port).some((h) => origin === `http://${h}`)) return false
  const site = c.req.header('sec-fetch-site')
  return site === undefined || site === 'same-origin'
}

/** 输出片段：任务最近的 output 活动，取末尾不超过上限的整行，再脱敏。 */
function snippetOf(deps: InboxActionDeps, item: InboxItemView): string | null {
  if (item.source !== 'task' || !item.task_id) return null
  const text = deps.ledger
    .taskActivity(item.task_id)
    .filter((a) => a.kind === 'output' && a.text)
    .map((a) => a.text)
    .join('\n')
    .trimEnd()
  if (!text) return null
  let tail = text.length > SNIPPET_MAX ? text.slice(-SNIPPET_MAX) : text
  if (tail.length < text.length) {
    const cut = tail.indexOf('\n')
    if (cut >= 0 && cut < tail.length - 1) tail = tail.slice(cut + 1)
    tail = `…\n${tail}`
  }
  return redactSecrets(tail)
}

/** 标题开头的 `[workspace] ` 与卡片上的 workspace 标签重复，页面上去掉。 */
function withoutWorkspacePrefix(title: string, workspace: string | null): string {
  const prefix = workspace ? `[${workspace}] ` : null
  return prefix && title.startsWith(prefix) && title.length > prefix.length
    ? title.slice(prefix.length)
    : title
}

function boardModel(deps: InboxActionDeps, now: number): BoardModel {
  const levels = Object.fromEntries(INBOX_LEVELS.map((l) => [l, [] as UiItem[]])) as Record<
    (typeof INBOX_LEVELS)[number],
    UiItem[]
  >
  const waiting: UiItem[] = []
  for (const item of deps.ledger.listInboxItems({ state: 'open', limit: -1 })) {
    const pending = item.task_id ? deps.ledger.pendingReply(item.task_id) : null
    // 账本写入前已脱敏；渲染前再过一遍，作为纵深防御。
    const entry: UiItem = {
      item,
      title: redactSecrets(withoutWorkspacePrefix(item.title, item.workspace)),
      body: redactSecrets(item.body),
      snippet: snippetOf(deps, item),
      pending: pending ? { kind: pending.kind } : null,
    }
    if (pending) waiting.push(entry)
    else levels[item.level].push(entry)
  }
  return { levels, waiting, now }
}

/** 完整页面：显式加上 doctype，其余内容全部由 JSX 转义输出。 */
const page = (node: unknown) => html`<!doctype html>${node}`

export function createUiApp(deps: UiAppDeps): Hono {
  const now = deps.now ?? Date.now
  const app = new Hono().basePath('/ui')
  app.use('*', guard(deps.port))

  const session = (c: Context) => getCookie(c, SESSION_COOKIE)
  const authed = (c: Context) => deps.sessions.valid(session(c))

  app.get('/static/app.css', (c) => {
    c.header('Cache-Control', 'no-cache')
    return c.body(APP_CSS, 200, { 'Content-Type': 'text/css; charset=utf-8' })
  })
  app.get('/static/app.js', (c) => {
    c.header('Cache-Control', 'no-cache')
    return c.body(APP_JS, 200, { 'Content-Type': 'text/javascript; charset=utf-8' })
  })
  app.get('/static/icon.svg', (c) => {
    c.header('Cache-Control', 'no-cache')
    return c.body(ICON_SVG, 200, { 'Content-Type': 'image/svg+xml' })
  })

  app.get('/login', (c) => {
    const redeemed = deps.sessions.redeem(c.req.query('code') ?? '')
    if (!redeemed) return c.html(page(<LoginPage reason="invalid" />), 401)
    // 换发会话：旧会话（如果有）立即作废。
    deps.sessions.revoke(session(c))
    setCookie(c, SESSION_COOKIE, redeemed.session, {
      path: '/ui',
      httpOnly: true,
      sameSite: 'Strict',
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    })
    // 303 跳到 /ui，登录码不留在地址栏与历史记录中。
    return c.redirect('/ui', 303)
  })

  app.get('/', (c) => {
    if (!authed(c)) {
      if (session(c) !== undefined) deleteCookie(c, SESSION_COOKIE, { path: '/ui' })
      return c.html(page(<LoginPage reason="missing" />), 401)
    }
    return c.html(page(<BoardPage model={boardModel(deps.inbox, now())} />))
  })

  /** 局部刷新用的片段。 */
  app.get('/items', (c) => {
    if (!authed(c)) return uiError(c, 401, 'unauthorized', '会话无效，请运行 flow ui 重新登录')
    return c.html(<Board model={boardModel(deps.inbox, now())} />)
  })

  app.post('/items/:id/act', async (c) => {
    const port = deps.port()
    if (port === undefined || !sameOrigin(c, port)) {
      return uiError(c, 403, 'origin_denied', '请求来源不被允许')
    }
    if (!authed(c)) return uiError(c, 401, 'unauthorized', '会话无效，请运行 flow ui 重新登录')
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return uiError(c, 400, 'invalid_arguments', '请求体不是合法的 JSON')
    }
    const parsed = uiActRequest.safeParse(body)
    if (!parsed.success) return uiError(c, 400, 'invalid_arguments', '条目操作参数不合法')
    // 身份固定为 user，渠道固定为 web：页面不能声明其他身份或渠道。
    const result = await actOnInbox(
      deps.inbox,
      c.req.param('id'),
      { ...parsed.data, via: 'web' },
      'user',
    )
    if (result.ok) await deps.settle?.()
    const fresh = result.ok ? (deps.inbox.ledger.getInboxItem(result.data.item.id) ?? null) : null
    return respond(c, result.ok ? ok({ item: fresh ?? result.data.item }) : result, inboxActData)
  })

  app.post('/logout', (c) => {
    const port = deps.port()
    if (port === undefined || !sameOrigin(c, port)) {
      return uiError(c, 403, 'origin_denied', '请求来源不被允许')
    }
    deps.sessions.revoke(session(c))
    deleteCookie(c, SESSION_COOKIE, { path: '/ui' })
    return c.redirect('/ui', 303)
  })

  return app
}

/** `POST /v1/ui/login-code`：经 `/v1` 的 Bearer 鉴权，仅 user（`flow ui` 调用）。 */
export function createUiLoginCodeRoutes(sessions: UiSessions): Hono {
  const app = new Hono()
  app.post(ENDPOINTS['ui-login-code'].path, userOnly('申请 Web 页面登录码'), (c) => {
    const issued = sessions.issueCode()
    return respond(
      c,
      ok({
        code: issued.code,
        login_path: `/ui/login?code=${encodeURIComponent(issued.code)}`,
        expires_at: issued.expires_at,
      }),
      uiLoginCodeData,
      201,
    )
  })
  return app
}
