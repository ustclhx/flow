import type { OutboundFetch } from '../../serve.ts'
import { ChannelError, type ChannelErrorKind } from '../types.ts'

/**
 * Telegram Bot API 客户端（add-m1-inbox 5.1，design D4）：直接用 fetch 调用，不引入 SDK。
 *
 * **token 不外泄**：请求 URL 形如 `<api>/bot<token>/<method>`，运行时（Bun / Node）的网络错误信息里
 * 可能带上 URL。所以这里抛出的错误一律不附 `cause`，错误信息只由方法名、HTTP 状态码与 Telegram 返回的
 * `description` 组成，并且再经过 `scrub` 去掉 token 与任何 `bot<id>:<secret>` 形态的片段。
 *
 * **错误分类**（交给渠道管理器的 `ChannelError`）：
 *
 * | 情况 | 分类 |
 * | --- | --- |
 * | 网络错误、超时、代理返回非 JSON | transport（整个渠道退避） |
 * | 5xx | transport |
 * | 409（另一个 getUpdates 在运行 / 设置了 webhook） | transport + `conflict`：可能有人在用同一个 token |
 * | 429 | transport，并带上 `retry_after`：插件在这之前不再请求 |
 * | 401 / 404（token 无效或被吊销） | transport + `unauthorized`：插件停用，状态报告 disabled |
 * | 403（用户屏蔽了 bot 等） | transport：等用户恢复，条目保持 pending |
 * | 400 message to edit not found / can't be edited / MESSAGE_ID_INVALID | permanent |
 * | 编辑时 400 message is not modified | 成功 |
 * | 其他 400 | message（只影响这一条，连续 5 次后放弃） |
 */

export const TELEGRAM_API_BASE = 'https://api.telegram.org'

export interface TelegramUser {
  id: number
  is_bot?: boolean
  username?: string
  first_name?: string
}

export interface TelegramChat {
  id: number
  type: string
}

export interface TelegramMessage {
  message_id: number
  chat: TelegramChat
  from?: TelegramUser
  text?: string
  reply_to_message?: { message_id: number; chat?: TelegramChat }
  /** 转发来的消息（Bot API 7.0+；旧字段 forward_from / forward_date）。 */
  forward_origin?: unknown
  forward_from?: unknown
  forward_date?: number
  /** 经 inline bot 发出的消息。 */
  via_bot?: TelegramUser
}

export interface TelegramCallbackQuery {
  id: string
  from: TelegramUser
  data?: string
  message?: { message_id: number; chat: TelegramChat }
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  callback_query?: TelegramCallbackQuery
}

export interface InlineButton {
  text: string
  callback_data: string
}

export interface ReplyMarkup {
  inline_keyboard: InlineButton[][]
}

export class TelegramApiError extends ChannelError {
  constructor(
    message: string,
    kind: ChannelErrorKind,
    readonly status: number | null,
    /** 429 时 Telegram 要求等待的毫秒数。 */
    readonly retryAfterMs: number | null = null,
    /** 401 / 404：token 无效或已被吊销。 */
    readonly unauthorized = false,
    /** 409：`polling` 是另一个 getUpdates 在运行，`webhook` 是 bot 设置了 webhook。 */
    readonly conflict: 'polling' | 'webhook' | null = null,
  ) {
    super(message, kind)
    this.name = 'TelegramApiError'
  }
}

export interface TelegramApiOptions {
  token: string
  /** 默认 `https://api.telegram.org`；测试指向假的 Telegram 服务。 */
  apiBase?: string
  fetch: OutboundFetch
}

export interface CallOptions {
  signal?: AbortSignal
  /** 超时毫秒数（与 signal 同时生效）；默认 30 秒。 */
  timeoutMs?: number
}

export interface TelegramApi {
  call<T>(method: string, params: Record<string, unknown>, options?: CallOptions): Promise<T>
  /** 去掉文本中的 token（也用于插件自己的日志）。 */
  scrub(text: string): string
}

/** 任何 `bot<数字>:<密钥>` 形态的片段（URL 路径中的 token）。 */
const TOKEN_SHAPE = /bot\d+:[A-Za-z0-9_-]+/g

const EDIT_METHODS = new Set(['editMessageText', 'editMessageReplyMarkup'])
const PERMANENT_400 = [
  /message to edit not found/i,
  /message can't be edited/i,
  /message_id_invalid/i,
  /message to be replied not found/i,
]

interface ApiBody {
  ok?: boolean
  result?: unknown
  error_code?: number
  description?: string
  parameters?: { retry_after?: number }
}

export function createTelegramApi(o: TelegramApiOptions): TelegramApi {
  const base = (o.apiBase ?? TELEGRAM_API_BASE).replace(/\/+$/, '')
  const token = o.token
  const scrub = (text: string) => {
    let out = text
    if (token.length > 0) out = out.split(token).join('<token>')
    return out.replace(TOKEN_SHAPE, 'bot<token>')
  }
  const fail = (
    method: string,
    detail: string,
    kind: ChannelErrorKind,
    status: number | null,
    retryAfterMs: number | null = null,
    unauthorized = false,
    conflict: 'polling' | 'webhook' | null = null,
  ) =>
    new TelegramApiError(
      scrub(`Telegram ${method} ${detail}`).slice(0, 400),
      kind,
      status,
      retryAfterMs,
      unauthorized,
      conflict,
    )

  async function call<T>(
    method: string,
    params: Record<string, unknown>,
    options: CallOptions = {},
  ): Promise<T> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000)
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
    let res: Response
    try {
      res = await o.fetch(`${base}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal,
      })
    } catch (err) {
      // 不附 cause：运行时的错误对象里可能带着含 token 的 URL。
      const timedOut = timeout.aborted && !options.signal?.aborted
      const name = err instanceof Error ? err.name : ''
      throw fail(
        method,
        timedOut
          ? '请求超时'
          : name === 'AbortError'
            ? '请求已中止'
            : `网络错误：${err instanceof Error ? err.message : String(err)}`,
        'transport',
        null,
      )
    }
    let body: ApiBody
    try {
      body = (await res.json()) as ApiBody
    } catch {
      throw fail(method, `返回了无法解析的响应（HTTP ${res.status}）`, 'transport', res.status)
    }
    if (res.ok && body.ok === true) return body.result as T
    const status = body.error_code ?? res.status
    const description = typeof body.description === 'string' ? body.description : ''
    const detail = `失败（${status}）${description ? `：${description}` : ''}`
    if (status === 429) {
      const after = body.parameters?.retry_after
      const ms = typeof after === 'number' && after > 0 ? Math.min(after, 3600) * 1000 : 1000
      throw fail(method, detail, 'transport', status, ms)
    }
    if (status === 409) {
      const conflict = /webhook/i.test(description) ? 'webhook' : 'polling'
      throw fail(method, detail, 'transport', status, null, false, conflict)
    }
    if (status === 401 || status === 404) {
      throw fail(method, detail, 'transport', status, null, true)
    }
    if (status === 400) {
      if (EDIT_METHODS.has(method) && /message is not modified/i.test(description)) {
        return true as T
      }
      if (PERMANENT_400.some((re) => re.test(description))) {
        throw fail(method, detail, 'permanent', status)
      }
      throw fail(method, detail, 'message', status)
    }
    throw fail(method, detail, 'transport', status)
  }

  return { call, scrub }
}
