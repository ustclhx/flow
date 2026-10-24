import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * 假的 Telegram Bot API 服务（add-m1-inbox 5.x 测试用，绝不访问真实的 api.telegram.org）：
 * - 只认一个 token，其他 token 返回 401；
 * - getUpdates 长轮询：有新更新时立即返回，否则等到 timeout 秒；记录每次请求的 offset；
 * - sendMessage / editMessageText / answerCallbackQuery 记录在内存中；editMessageText 对不存在的消息返回
 *   "message to edit not found"，内容不变时返回 "message is not modified"；
 * - `failNext` 让某个方法的下一次调用返回指定的错误（例如 429 retry_after、500）。
 */

/** 不像真实 token 的测试 token（运行时拼出，源码中没有 token 形态的字面量）。 */
export const fakeBotToken = () =>
  ['424242', ['FLOWFAKE', 'TGTOKEN', 'q'.repeat(12)].join('_')].join(':')

export const BOT_ID = 424242
export const USER_ID = 7001
export const STRANGER_ID = 9009

export interface SentMessage {
  chat_id: number
  message_id: number
  text: string
  parse_mode?: string
  reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] }
  reply_to?: number
}

interface PendingFailure {
  status: number
  body: Record<string, unknown>
}

export class FakeTelegram {
  server: Server | undefined
  url = ''
  token: string
  /** 全部收到的请求：方法名与参数。 */
  calls: { method: string; params: Record<string, unknown> }[] = []
  /** getUpdates 请求的 offset。 */
  offsets: number[] = []
  messages = new Map<string, SentMessage>()
  /** 按发送先后的消息（含之后被编辑的最新内容）。 */
  sent: SentMessage[] = []
  edits: { chat_id: number; message_id: number; text: string }[] = []
  answers: { callback_query_id: string; text?: string }[] = []
  private updates: Record<string, unknown>[] = []
  private nextUpdateId = 100
  private nextMessageId = 500
  private waiters = new Set<() => void>()
  private failures = new Map<string, PendingFailure[]>()

  constructor(token = fakeBotToken()) {
    this.token = token
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      void this.handle(req, res)
    })
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve))
    const { port } = this.server.address() as AddressInfo
    this.url = `http://127.0.0.1:${port}`
    return this
  }

  async close() {
    for (const w of this.waiters) w()
    this.waiters.clear()
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve()
      this.server.close(() => resolve())
      this.server.closeAllConnections()
    })
  }

  /** 下一次调用该方法时返回错误。 */
  failNext(method: string, status: number, body: Record<string, unknown> = {}) {
    const list = this.failures.get(method) ?? []
    list.push({
      status,
      body: { ok: false, error_code: status, description: `模拟错误 ${status}`, ...body },
    })
    this.failures.set(method, list)
  }

  /** 推入一条更新（update_id 自动递增），返回 update_id。 */
  push(update: Record<string, unknown>): number {
    const id = this.nextUpdateId++
    this.updates.push({ update_id: id, ...update })
    for (const w of this.waiters) w()
    this.waiters.clear()
    return id
  }

  /** 用户发来一条文字消息。 */
  say(
    text: string,
    o: { chat?: number; from?: number; type?: string; replyTo?: number; isBot?: boolean } = {},
  ): number {
    const chat = o.chat ?? USER_ID
    return this.push({
      message: {
        message_id: this.nextMessageId++,
        chat: { id: chat, type: o.type ?? 'private' },
        from: { id: o.from ?? chat, is_bot: o.isBot ?? false, first_name: '测试' },
        text,
        ...(o.replyTo === undefined
          ? {}
          : { reply_to_message: { message_id: o.replyTo, chat: { id: chat, type: 'private' } } }),
      },
    })
  }

  /** 用户点击一条消息上的按钮。 */
  press(messageId: number, data: string, o: { chat?: number; from?: number; type?: string } = {}) {
    const chat = o.chat ?? USER_ID
    return this.push({
      callback_query: {
        id: `cq-${this.nextUpdateId}`,
        from: { id: o.from ?? chat, is_bot: false, first_name: '测试' },
        data,
        message: { message_id: messageId, chat: { id: chat, type: o.type ?? 'private' } },
      },
    })
  }

  /** 发给某个 chat 的消息。 */
  to(chat: number): SentMessage[] {
    return this.sent.filter((m) => m.chat_id === chat)
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '')
    const reply = (status: number, body: unknown) => {
      if (res.writableEnded) return
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (!m) return reply(404, { ok: false, error_code: 404, description: 'Not Found' })
    const [, token, method = ''] = m
    let params: Record<string, unknown> = {}
    try {
      params = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    } catch {
      return reply(400, { ok: false, error_code: 400, description: 'Bad Request: invalid JSON' })
    }
    this.calls.push({ method, params })
    if (token !== this.token) {
      return reply(401, { ok: false, error_code: 401, description: 'Unauthorized' })
    }
    const failure = this.failures.get(method)?.shift()
    if (failure) return reply(failure.status, failure.body)
    const ok = (result: unknown) => reply(200, { ok: true, result })
    switch (method) {
      case 'getMe':
        return ok({ id: BOT_ID, is_bot: true, username: 'flow_test_bot', first_name: 'Flow' })
      case 'getUpdates': {
        const offset = Number(params.offset ?? 0)
        this.offsets.push(offset)
        const pick = () => this.updates.filter((u) => Number(u.update_id) >= offset)
        let found = pick()
        if (found.length === 0) {
          const timeout = Math.min(Number(params.timeout ?? 0), 5) * 1000
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(t)
              this.waiters.delete(done)
              resolve()
            }
            const t = setTimeout(done, timeout)
            this.waiters.add(done)
            req.on('close', done)
          })
          found = pick()
        }
        return ok(found)
      }
      case 'sendMessage': {
        const msg: SentMessage = {
          chat_id: Number(params.chat_id),
          message_id: this.nextMessageId++,
          text: String(params.text ?? ''),
          ...(typeof params.parse_mode === 'string' ? { parse_mode: params.parse_mode } : {}),
          ...(params.reply_markup
            ? { reply_markup: params.reply_markup as NonNullable<SentMessage['reply_markup']> }
            : {}),
          ...(params.reply_parameters
            ? { reply_to: Number((params.reply_parameters as { message_id: number }).message_id) }
            : {}),
        }
        if (msg.text.length === 0) {
          return reply(400, {
            ok: false,
            error_code: 400,
            description: 'Bad Request: text is empty',
          })
        }
        this.messages.set(`${msg.chat_id}:${msg.message_id}`, msg)
        this.sent.push(msg)
        return ok({ message_id: msg.message_id, chat: { id: msg.chat_id, type: 'private' } })
      }
      case 'editMessageText': {
        const key = `${Number(params.chat_id)}:${Number(params.message_id)}`
        const msg = this.messages.get(key)
        if (!msg) {
          return reply(400, {
            ok: false,
            error_code: 400,
            description: 'Bad Request: message to edit not found',
          })
        }
        const text = String(params.text ?? '')
        const markup = params.reply_markup as SentMessage['reply_markup'] | undefined
        if (text === msg.text && JSON.stringify(markup) === JSON.stringify(msg.reply_markup)) {
          return reply(400, {
            ok: false,
            error_code: 400,
            description:
              'Bad Request: message is not modified: specified new message content and reply markup are exactly the same',
          })
        }
        msg.text = text
        if (markup) msg.reply_markup = markup
        else delete msg.reply_markup
        this.edits.push({ chat_id: msg.chat_id, message_id: msg.message_id, text })
        return ok(true)
      }
      case 'answerCallbackQuery':
        this.answers.push({
          callback_query_id: String(params.callback_query_id),
          ...(typeof params.text === 'string' ? { text: params.text } : {}),
        })
        return ok(true)
      default:
        return reply(404, { ok: false, error_code: 404, description: 'Not Found' })
    }
  }
}

/** 一个最小的 HTTP 正向代理（只转发 http:// 的绝对 URL 请求），记录经过它的请求。 */
export async function startForwardProxy() {
  const { request } = await import('node:http')
  const seen: string[] = []
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    const upstream = request(req.url ?? '', { method: req.method, headers: req.headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers)
      up.pipe(res)
    })
    upstream.on('error', () => {
      res.writeHead(502)
      res.end()
    })
    req.pipe(upstream)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}
