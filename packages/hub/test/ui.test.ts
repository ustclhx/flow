import { afterEach, describe, expect, test } from 'bun:test'
import {
  createHubApp,
  createInboxReactor,
  createInboxRoutes,
  createNodeProtocol,
  createTaskService,
  createUiApp,
  createUiLoginCodeRoutes,
  createUiSessions,
  LOGIN_CODE_TTL_MS,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from '../src/index.ts'
import { anyRole, contractInput, must, tempLedger } from './ledger-helpers.ts'
import { authHeaders, FakeClock } from './server-fixtures.ts'

/**
 * "需要我的"页面（add-m1-inbox 6.1；inbox-web spec 全部场景）：`app.request` 加 cookie 流程。
 */

const PORT = 47_123
const HOST = `127.0.0.1:${PORT}`
const ORIGIN = `http://${HOST}`

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn()
})

async function setup() {
  const clock = new FakeClock(Date.parse('2026-10-25T08:00:00Z'))
  const { store, dir, cleanup } = await tempLedger({ now: clock.now })
  const tasks = createTaskService({
    ledger: store,
    workspaceExists: () => true,
    roles: anyRole,
    now: clock.now,
  })
  const protocol = createNodeProtocol({ ledger: store, clock, leaseTtlS: 60, leaseWaitMaxS: 30 })
  const reactor = createInboxReactor({ ledger: store })
  reactor.start()
  const inbox = { ledger: store, tasks, home: dir, scanProposals: async () => {} }
  const sessions = createUiSessions({ now: clock.now })
  const app = createHubApp({
    token: 'x'.repeat(43),
    mount: [
      { path: '/', app: createInboxRoutes(inbox) },
      { path: '/', app: createUiLoginCodeRoutes(sessions) },
      {
        path: '/',
        app: createUiApp({
          sessions,
          inbox,
          port: () => PORT,
          settle: () => reactor.idle(),
          now: clock.now,
        }),
      },
    ],
  })
  cleanups.push(() => {
    reactor.stop()
    protocol.stop()
    cleanup()
  })

  const get = (path: string, headers: Record<string, string> = {}) =>
    app.request(path, { headers: { Host: HOST, ...headers } })
  const issueCode = async (actor?: string) => {
    const res = await app.request('/v1/ui/login-code', {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json',
        ...(actor ? { 'X-Flow-Actor': actor } : {}),
      },
      body: '{}',
    })
    return { res, doc: (await res.json()) as { data: { code: string; login_path: string } } }
  }
  /** 完整的登录流程，返回可放进 Cookie 头的值。 */
  const login = async () => {
    const { doc } = await issueCode()
    const res = await get(doc.data.login_path)
    expect(res.status).toBe(303)
    const cookie = /flow_ui_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1]
    if (!cookie) throw new Error('没有会话 cookie')
    return `${SESSION_COOKIE}=${cookie}`
  }
  const act = (
    id: string,
    body: unknown,
    headers: Record<string, string | undefined> = {},
  ): Promise<Response> => {
    const h: Record<string, string> = {
      Host: HOST,
      Origin: ORIGIN,
      'Content-Type': 'application/json',
    }
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined) delete h[k]
      else h[k] = v
    }
    return Promise.resolve(
      app.request(`/ui/items/${encodeURIComponent(id)}/act`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify(body),
      }),
    )
  }
  const createBlocked = async (reason: 'question' | 'awaiting_approval' = 'awaiting_approval') => {
    const task = must(await tasks.createTask(contractInput(), { actor: 'codex' })).task
    must(
      protocol.service.registerNode(
        { node_id: 'n1', hostname: 'test', version: '0.0.0', capabilities: ['executor:fake'] },
        'user',
      ),
    )
    const lease = must(
      await protocol.service.acquire({ node_id: 'n1', capabilities: ['executor:fake'], wait_s: 0 }),
    ).lease
    if (!lease) throw new Error('没有租约')
    must(
      protocol.service.renew(lease.lease_id, {
        lease_token: lease.lease_token,
        blocked: { reason, message: '要执行 git push，请确认' },
      }),
    )
    await reactor.idle()
    const item = store.listInboxItems({ task_id: task.id })[0]
    if (!item) throw new Error('没有条目')
    return { task, lease, item }
  }
  const createItem = (id: string, title: string, body = '', level = 'decide') =>
    must(
      store.append(
        {
          type: 'inbox.item_created',
          payload: {
            item_id: id,
            source: 'supervisor',
            source_ref: id,
            level: level as 'decide',
            title,
            body,
            actions: [],
          },
        },
        { actor: 'hub' },
      ),
    )
  return {
    app,
    store,
    clock,
    protocol,
    reactor,
    get,
    issueCode,
    login,
    act,
    createBlocked,
    createItem,
  }
}

describe('直接访问页面', () => {
  test('没有会话：提示运行 flow ui 登录，不显示任何条目，片段与操作被拒绝', async () => {
    const ctx = await setup()
    const { item } = await ctx.createBlocked()
    const page = await ctx.get('/ui')
    expect(page.status).toBe(401)
    const text = await page.text()
    expect(text).toContain('请运行 flow ui 登录')
    expect(text).not.toContain(item.title)
    expect(text).not.toContain(item.id)
    expect((await ctx.get('/ui/items')).status).toBe(401)
    const seq = ctx.store.seq()
    const denied = await ctx.act(item.id, { action: 'approve' })
    expect(denied.status).toBe(401)
    // 伪造的 cookie 同样无效。
    const forged = await ctx.get('/ui', { Cookie: `${SESSION_COOKIE}=${'A'.repeat(43)}` })
    expect(forged.status).toBe(401)
    expect(await forged.text()).not.toContain(item.title)
    expect(ctx.store.seq()).toBe(seq)
  })
})

describe('在页面上批准', () => {
  test('批准后任务收到回复；条目先移到"已提交"，节点送达后关闭（via web），从列表中移除', async () => {
    const ctx = await setup()
    const { task, lease, item } = await ctx.createBlocked('awaiting_approval')
    const cookie = await ctx.login()
    const page = await ctx.get('/ui', { Cookie: cookie })
    expect(page.status).toBe(200)
    const html = await page.text()
    // 标题开头的 [workspace] 与卡片上的 workspace 标签重复，页面上去掉。
    expect(item.title.startsWith('[ws/demo] ')).toBe(true)
    expect(html).toContain(`<h3 class="title">${item.title.slice('[ws/demo] '.length)}</h3>`)
    expect(html).toContain('<span class="ws">ws/demo</span>')
    expect(html).toContain(`data-id="${item.id}"`)
    expect(html).toContain('data-act="approve"')
    expect(html).toContain('data-act="deny"')
    expect(html).toContain('data-act="dismiss"')
    expect(html).not.toContain('data-act="accept"')

    const res = await ctx.act(item.id, { action: 'approve' }, { Cookie: cookie })
    expect(res.status).toBe(200)
    expect(ctx.store.taskReplies(task.id)[0]).toMatchObject({ kind: 'approve', by: 'user' })

    // 回复待送达：不再出现在待处理分组中，只在"已提交"一栏，没有操作按钮。
    const pending = await (await ctx.get('/ui/items', { Cookie: cookie })).text()
    expect(pending).toContain('data-state="waiting"')
    expect(pending).not.toContain('data-act="approve"')
    expect(pending).toContain('已批准')

    const reply = must(
      ctx.protocol.service.renew(lease.lease_id, { lease_token: lease.lease_token }),
    ).reply
    if (!reply) throw new Error('没有回复')
    must(
      ctx.protocol.service.ackReply(lease.lease_id, {
        lease_token: lease.lease_token,
        reply_id: reply.reply_id,
      }),
    )
    await ctx.reactor.idle()
    expect(ctx.store.getTask(task.id)?.status).toBe('running')
    // 渠道（Telegram）据此关闭事件回改消息：关闭原因、操作者与渠道都在条目上。
    expect(ctx.store.getInboxItem(item.id)?.closed).toMatchObject({
      reason: 'task_running',
      cause_actor: 'user',
      via: 'web',
    })
    const after = await (await ctx.get('/ui/items', { Cookie: cookie })).text()
    expect(after).not.toContain(item.id)
    expect(after).toContain('没有需要你处理的事项')
  })

  test('回复与忽略：只显示条目支持的操作；身份固定为 user、渠道固定为 web', async () => {
    const ctx = await setup()
    const { task, item } = await ctx.createBlocked('question')
    const cookie = await ctx.login()
    const html = await (await ctx.get('/ui', { Cookie: cookie })).text()
    expect(html).toContain('data-act="reply"')
    expect(html).not.toContain('data-act="approve"')
    expect(html).toContain('<textarea')

    // 页面不能自报渠道或身份。
    const spoof = await ctx.act(item.id, { action: 'dismiss', via: 'cli' }, { Cookie: cookie })
    expect(spoof.status).toBe(400)
    const empty = await ctx.act(item.id, { action: 'reply', text: '  ' }, { Cookie: cookie })
    expect(empty.status).toBe(400)

    const replied = await ctx.act(
      item.id,
      { action: 'reply', text: '用方案 A' },
      { Cookie: cookie },
    )
    expect(replied.status).toBe(200)
    expect(ctx.store.taskReplies(task.id)[0]).toMatchObject({ kind: 'text', text: '用方案 A' })

    ctx.createItem('ask.d1', '要不要升级依赖')
    const dismissed = await ctx.act('ask.d1', { action: 'dismiss' }, { Cookie: cookie })
    expect(dismissed.status).toBe(200)
    expect(
      ((await dismissed.json()) as { data: { item: { state: string } } }).data.item.state,
    ).toBe('closed')
    expect(ctx.store.getInboxItem('ask.d1')?.closed).toMatchObject({
      reason: 'dismissed',
      cause_actor: 'user',
      via: 'web',
    })
    const again = await ctx.act('ask.d1', { action: 'dismiss' }, { Cookie: cookie })
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ error: { code: 'item_closed' } })
  })

  test('按级别分组：Interrupt 在最前；输出片段可折叠并再次脱敏', async () => {
    const ctx = await setup()
    const { task } = await ctx.createBlocked('awaiting_approval')
    ctx.createItem('ask.dg', '昨天的摘要', '', 'digest')
    ctx.createItem('ask.dc', '选哪个方案', '', 'decide')
    const secret = `ghp_${'a1B2'.repeat(9)}`
    ctx.store.recordActivity(task.id, [
      { ts: new Date(ctx.clock.now()).toISOString(), kind: 'output', text: `token=${secret}` },
      {
        ts: new Date(ctx.clock.now()).toISOString(),
        kind: 'output',
        text: '$ git push origin main',
      },
    ])
    const cookie = await ctx.login()
    const html = await (await ctx.get('/ui', { Cookie: cookie })).text()
    const at = (s: string) => html.indexOf(s)
    expect(at('id="lvl-interrupt"')).toBeGreaterThan(0)
    expect(at('id="lvl-interrupt"')).toBeLessThan(at('id="lvl-decide"'))
    expect(at('id="lvl-decide"')).toBeLessThan(at('id="lvl-digest"'))
    expect(html).toContain('<details class="snippet">')
    expect(html).toContain('$ git push origin main')
    expect(html).not.toContain(secret)
    expect(html).toContain('[REDACTED')
  })
})

describe('登录码与会话', () => {
  test('登录码：仅 user 可申请；一次性；60 秒后失效；cookie 属性与 303 跳转', async () => {
    const ctx = await setup()
    const ai = await ctx.issueCode('codex')
    expect(ai.res.status).toBe(403)
    expect(ai.doc).toMatchObject({ error: { code: 'user_only' } })
    const anonymous = await ctx.app.request('/v1/ui/login-code', { method: 'POST' })
    expect(anonymous.status).toBe(401)

    const { res, doc } = await ctx.issueCode()
    expect(res.status).toBe(201)
    expect(doc.data.code).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const first = await ctx.get(doc.data.login_path)
    expect(first.status).toBe(303)
    expect(first.headers.get('location')).toBe('/ui')
    expect(first.headers.get('referrer-policy')).toBe('no-referrer')
    const setCookie = first.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')
    expect(setCookie).toContain('Path=/ui')
    expect(setCookie).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`)
    expect(setCookie).not.toContain(doc.data.code)

    const reused = await ctx.get(doc.data.login_path)
    expect(reused.status).toBe(401)
    expect(reused.headers.get('set-cookie')).toBeNull()
    expect(await reused.text()).toContain('登录链接无效或已过期')

    const late = await ctx.issueCode()
    await ctx.clock.advance(LOGIN_CODE_TTL_MS + 1)
    expect((await ctx.get(late.doc.data.login_path)).status).toBe(401)
    expect((await ctx.get('/ui/login?code=')).status).toBe(401)
  })

  test('退出登录或会话过期后请求被拒绝', async () => {
    const ctx = await setup()
    ctx.createItem('ask.x', '一个条目')
    const cookie = await ctx.login()
    expect((await ctx.get('/ui', { Cookie: cookie })).status).toBe(200)
    // 退出同样要校验 Origin。
    const noOrigin = await ctx.app.request('/ui/logout', {
      method: 'POST',
      headers: { Host: HOST, Cookie: cookie },
    })
    expect(noOrigin.status).toBe(403)
    const out = await ctx.app.request('/ui/logout', {
      method: 'POST',
      headers: { Host: HOST, Origin: ORIGIN, Cookie: cookie },
    })
    expect(out.status).toBe(303)
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0')
    expect((await ctx.get('/ui', { Cookie: cookie })).status).toBe(401)
    expect((await ctx.get('/ui/items', { Cookie: cookie })).status).toBe(401)
    expect((await ctx.act('ask.x', { action: 'dismiss' }, { Cookie: cookie })).status).toBe(401)

    const fresh = await ctx.login()
    expect((await ctx.get('/ui', { Cookie: fresh })).status).toBe(200)
    await ctx.clock.advance(SESSION_TTL_MS + 1)
    expect((await ctx.get('/ui', { Cookie: fresh })).status).toBe(401)
    expect((await ctx.act('ask.x', { action: 'dismiss' }, { Cookie: fresh })).status).toBe(401)
    expect(ctx.store.getInboxItem('ask.x')?.state).toBe('open')
  })
})

describe('访问限制与安全头', () => {
  test('Host 不是本机地址加同一端口时拒绝（防 DNS rebinding）', async () => {
    const ctx = await setup()
    const cookie = await ctx.login()
    for (const host of [`evil.example:${PORT}`, '127.0.0.1:1', 'localhost', `127.0.0.2:${PORT}`]) {
      const res = await ctx.app.request('/ui', { headers: { Host: host, Cookie: cookie } })
      expect(res.status).toBe(421)
      expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
    }
    // 缺少 Host 头同样拒绝。
    expect((await ctx.app.request('/ui', { headers: { Cookie: cookie } })).status).toBe(421)
    // Host 被拒时登录码不被消耗。
    const { doc } = await ctx.issueCode()
    const rejected = await ctx.app.request(doc.data.login_path, {
      headers: { Host: `evil.example:${PORT}` },
    })
    expect(rejected.status).toBe(421)
    expect((await ctx.get(doc.data.login_path, { Host: `localhost:${PORT}` })).status).toBe(303)
  })

  test('写操作缺少 Origin 或来源不是本机同一端口时拒绝，不产生事件', async () => {
    const ctx = await setup()
    const { item } = await ctx.createBlocked()
    const cookie = await ctx.login()
    const seq = ctx.store.seq()
    for (const headers of [
      { Origin: undefined },
      { Origin: 'http://evil.example' },
      { Origin: `http://evil.example:${PORT}` },
      { Origin: 'http://127.0.0.1:1' },
      { Origin: `https://${HOST}` },
      { Origin: 'null' },
      { 'Sec-Fetch-Site': 'cross-site' },
    ]) {
      const res = await ctx.act(item.id, { action: 'approve' }, { Cookie: cookie, ...headers })
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ error: { code: 'origin_denied' } })
    }
    expect(ctx.store.seq()).toBe(seq)
    const local = await ctx.act(
      item.id,
      { action: 'approve' },
      { Cookie: cookie, Origin: `http://localhost:${PORT}`, Host: `localhost:${PORT}` },
    )
    expect(local.status).toBe(200)
  })

  test('会话 cookie 不能访问 /v1', async () => {
    const ctx = await setup()
    const { item } = await ctx.createBlocked()
    const cookie = await ctx.login()
    const list = await ctx.get('/v1/inbox', { Cookie: cookie })
    expect(list.status).toBe(401)
    const act = await ctx.app.request(`/v1/inbox/${item.id}/act`, {
      method: 'POST',
      headers: { Host: HOST, Origin: ORIGIN, Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve' }),
    })
    expect(act.status).toBe(401)
    const code = await ctx.app.request('/v1/ui/login-code', {
      method: 'POST',
      headers: { Host: HOST, Origin: ORIGIN, Cookie: cookie },
    })
    expect(code.status).toBe(401)
    expect(ctx.store.getInboxItem(item.id)?.state).toBe('open')
  })

  test('CSP 等安全头；页面只引用同源静态脚本与样式', async () => {
    const ctx = await setup()
    const cookie = await ctx.login()
    for (const path of [
      '/ui',
      '/ui/items',
      '/ui/static/app.js',
      '/ui/static/app.css',
      '/ui/nope',
    ]) {
      const res = await ctx.get(path, { Cookie: cookie })
      const csp = res.headers.get('content-security-policy') ?? ''
      for (const d of [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self'",
        "connect-src 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ]) {
        expect(csp).toContain(d)
      }
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('referrer-policy')).toBe('no-referrer')
    }
    const js = await ctx.get('/ui/static/app.js')
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toContain('text/javascript')
    const css = await ctx.get('/ui/static/app.css')
    expect(css.headers.get('content-type')).toContain('text/css')
    const page = await ctx.get('/ui', { Cookie: cookie })
    expect(page.headers.get('cache-control')).toBe('no-store')
    const html = await page.text()
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html.match(/<script/g)).toHaveLength(1)
    expect(html).toContain('<script src="/ui/static/app.js" defer=""></script>')
    expect(html).not.toMatch(/<style|style="/)
  })

  test('XSS：标题与正文中的标签被转义，不会执行', async () => {
    const ctx = await setup()
    ctx.createItem(
      'ask.xss',
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(2)> & "引号" \'单引号\'',
      'interrupt',
    )
    const cookie = await ctx.login()
    for (const path of ['/ui', '/ui/items']) {
      const html = await (await ctx.get(path, { Cookie: cookie })).text()
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
      expect(html).not.toContain('<script>alert')
      expect(html).not.toContain('<img')
      expect(html).toContain('&lt;img src=x onerror=alert(2)&gt; &amp;')
    }
  })
})
