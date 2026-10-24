import {
  type ChannelsConfig,
  type Result,
  redactSecrets,
  type TelegramBinding,
  type TelegramChannelConfig,
} from '@flow/core'
import type { LedgerStore } from '../../ledger/store.ts'
import { type OutboundFetch, proxiedFetch } from '../../serve.ts'
import type { HubLogger } from '../../server/maintenance.ts'
import {
  type ChannelCallOptions,
  ChannelError,
  type ChannelHealth,
  type ChannelMessage,
  type ChannelPlugin,
  type ChannelSpec,
  type InboundHandler,
} from '../types.ts'
import {
  createTelegramApi,
  type TelegramApi,
  TelegramApiError,
  type TelegramCallbackQuery,
  type TelegramChat,
  type TelegramMessage,
  type TelegramUpdate,
  type TelegramUser,
} from './api.ts'
import {
  HELP_TEXT,
  listOpenItems,
  type ParsedCommand,
  parseCommand,
  statusText,
  type TelegramStatusSnapshot,
} from './commands.ts'
import type { TelegramLinks } from './link.ts'
import { ACTION_DONE, parseCallbackData, plainText, renderTelegramMessage } from './render.ts'
import { botIdOf, loadTelegramState, saveTelegramState } from './state.ts'

/**
 * Telegram 渠道插件（add-m1-inbox 5.1、5.2；telegram-channel spec 全部场景）。
 *
 * **安全边界**（它是手机上的审批入口）：
 * - 只处理已绑定的那个**私聊**里、由绑定时记录的**那个用户**发来的消息和按钮：`chat.type` 必须是
 *   `private`，`chat.id` 与 `from.id` 都要和 `config/channels.yaml` 中的绑定一致；
 * - 其他一律忽略：不回复、不报错、不交给收件箱，只计数（`flow hub status` 的 ignored_inbound）并在日志中
 *   记一笔（日志限流）。唯一例外是私聊里的 `/link <绑定码>`（或 `/start <绑定码>`）：码正确才绑定，
 *   码错误时对未绑定的 chat 同样不回复；
 * - bot token 只存在于内存中的 API 客户端里，错误信息与日志都去掉了 token（见 api.ts）；
 * - 外发的所有文字都经过 `redact`（默认 core 的 `redactSecrets`）再 HTML 转义；入站的文字（回复、随手记、
 *   指令）原样交给收件箱、知识库与账本，由它们各自的脱敏与写入边界处理。
 *
 * **收取**：getUpdates 长轮询（timeout=50，只收 message 与 callback_query），每处理完一条就把 offset
 * 写入 `state/telegram.json`，重启后不重复处理。轮询失败按 1s、2s、4s… 退避（最长 5 分钟）；
 * 429 时在 `retry_after` 之前不再发出任何请求；401 / 404（token 无效）时停用渠道，在状态中报告，
 * 等密钥变化后由渠道管理器重新创建。
 */

export const TELEGRAM_CHANNEL_ID = 'telegram'
/** 轮询失败的最长退避。 */
const POLL_BACKOFF_MAX_MS = 5 * 60_000
/** 被忽略的访问：前 20 次逐条记日志，之后每 100 次记一条。 */
const IGNORE_LOG_FIRST = 20
const IGNORE_LOG_EVERY = 100
/** 普通回复（命令结果等）的超时。 */
const REPLY_TIMEOUT_MS = 20_000

/** 插件依赖中枢的能力（runHub 注入；测试可替换）。 */
export interface TelegramDeps {
  ledger: LedgerStore
  links: TelegramLinks
  logger?: Pick<HubLogger, 'info' | 'warn'>
  /** 外发文字的脱敏，默认 core 的 `redactSecrets`。 */
  redact?: (text: string) => string
  /** `state/telegram.json` 的路径。 */
  statePath: string
  /** 重新读取 `config/channels.yaml`（绑定可能被用户手动修改）。 */
  loadConfig: () => Promise<Result<ChannelsConfig>>
  /** 写入绑定并在 config 仓库提交。 */
  saveBinding: (binding: TelegramBinding) => Promise<Result<void>>
  /** 绑定成功后（渠道管理器立即补推 pending 的条目）。 */
  onBound?: () => void
  /** `/status` 的内容。 */
  status: () => TelegramStatusSnapshot
  /** `/capture`：以 user 身份随手记，来源 telegram。 */
  capture: (text: string) => Promise<Result<{ file: string }>>
  /** `/ask`：写入 `user.instruction`。 */
  ask: (workspace: string, text: string) => Promise<Result<{ seq: number }>>
  /** 测试注入：替换 fetch（默认按代理配置构造）。 */
  fetch?: OutboundFetch
  /** 测试注入：指向假的 Telegram 服务。 */
  apiBase?: string
  /** 代理的环境变量来源，默认 `process.env`。 */
  env?: Record<string, string | undefined>
  /** 测试注入：长轮询的 timeout 秒数，默认 50。 */
  pollTimeoutS?: number
  /** 测试注入：等待（需响应 signal）。 */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  now?: () => number
}

/** 解析后的渠道配置（`bot_token` 已替换为密钥值）。 */
export type ResolvedTelegramConfig = TelegramChannelConfig

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(done, ms)
    function done() {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done)
  })

const bindingOf = (c: TelegramChannelConfig | undefined): TelegramBinding | null =>
  c?.chat_id !== undefined && c.user_id !== undefined
    ? { chat_id: c.chat_id, user_id: c.user_id }
    : null

/** 代理地址只记录协议与主机，去掉可能的用户名密码。 */
const proxyLabel = (proxy: string) => {
  try {
    const u = new URL(proxy)
    return `${u.protocol}//${u.host}`
  } catch {
    return '（无法解析）'
  }
}

export class TelegramChannel implements ChannelPlugin {
  readonly id = TELEGRAM_CHANNEL_ID
  readonly via = 'telegram' as const
  private readonly redact: (text: string) => string
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
  private readonly now: () => number
  private api: TelegramApi | null = null
  private binding: TelegramBinding | null
  private disabled: string | null = null
  private ignored = 0
  private pausedUntil = 0
  private offset = 0
  private botId: number | null
  private stopped = false
  private readonly abort = new AbortController()
  private loop: Promise<void> | null = null
  private onAction: InboundHandler | undefined

  constructor(
    private readonly config: ResolvedTelegramConfig,
    private readonly deps: TelegramDeps,
  ) {
    this.redact = deps.redact ?? redactSecrets
    this.sleep = deps.sleep ?? defaultSleep
    this.now = deps.now ?? Date.now
    this.binding = bindingOf(config)
    this.botId = botIdOf(config.bot_token)
  }

  health(): ChannelHealth {
    return { disabled: this.disabled, ignored: this.ignored }
  }

  async start(onAction: InboundHandler): Promise<void> {
    this.onAction = onAction
    if (!this.api) {
      const env = this.deps.env ?? process.env
      const proxy = this.config.proxy ?? env.HTTPS_PROXY ?? env.https_proxy ?? null
      let fetch = this.deps.fetch
      if (!fetch) {
        const built = await proxiedFetch(proxy)
        if (built.note) this.deps.logger?.warn(built.note)
        fetch = built.fetch
      }
      if (proxy) this.deps.logger?.info('Telegram 经代理访问', { proxy: proxyLabel(proxy) })
      this.api = createTelegramApi({
        token: this.config.bot_token,
        fetch,
        ...(this.deps.apiBase ? { apiBase: this.deps.apiBase } : {}),
      })
    }
    const state = await loadTelegramState(this.deps.statePath)
    // 换了 bot：旧的 offset 属于另一个 bot，从头开始。
    this.offset = state.bot_id !== null && state.bot_id !== this.botId ? 0 : state.offset
    // getMe：确认 token 可用，并取得用户名生成绑定深链接。传输错误抛出，由管理器退避后重试 start。
    try {
      const me = await this.request<TelegramUser>('getMe', {}, { timeoutMs: REPLY_TIMEOUT_MS })
      this.deps.links.botUsername = me.username ?? null
    } catch (err) {
      if (this.disabled) return
      throw err
    }
    if (this.binding === null) {
      this.deps.logger?.info('Telegram 渠道已启动，尚未绑定 chat：运行 flow telegram link')
    }
    this.loop = this.pollLoop()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.abort.abort()
    await this.loop
  }

  async send(message: ChannelMessage, options: ChannelCallOptions): Promise<string> {
    const binding = this.ready()
    const rendered = renderTelegramMessage(message, this.redact)
    const sent = await this.request<{ message_id: number }>(
      'sendMessage',
      {
        chat_id: binding.chat_id,
        text: rendered.text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(rendered.reply_markup.inline_keyboard.length > 0
          ? { reply_markup: rendered.reply_markup }
          : {}),
      },
      { signal: options.signal },
    )
    if (!Number.isSafeInteger(sent?.message_id)) {
      throw new ChannelError('Telegram sendMessage 没有返回消息 id', 'message')
    }
    return `${binding.chat_id}:${sent.message_id}`
  }

  async update(ref: string, message: ChannelMessage, options: ChannelCallOptions): Promise<void> {
    this.ready()
    const m = /^(-?\d{1,20}):(\d{1,20})$/.exec(ref)
    if (!m) throw new ChannelError('消息引用不是 Telegram 的 <chat>:<message>', 'permanent')
    const rendered = renderTelegramMessage(message, this.redact)
    await this.request(
      'editMessageText',
      {
        chat_id: Number(m[1]),
        message_id: Number(m[2]),
        text: rendered.text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        // 已关闭的条目没有按钮：传空键盘去掉原来的按钮。
        reply_markup: rendered.reply_markup,
      },
      { signal: options.signal },
    )
  }

  // ---------------------------------------------------------------------------
  // 请求

  /** 发送与更新前的检查：未停用、已绑定、不在限流等待中。 */
  private ready(): TelegramBinding {
    if (this.disabled) throw new ChannelError(this.disabled, 'transport')
    if (!this.binding) {
      throw new ChannelError('Telegram 尚未绑定 chat，请运行 flow telegram link', 'transport')
    }
    const wait = this.pausedUntil - this.now()
    if (wait > 0) {
      throw new ChannelError(`Telegram 限流中，${Math.ceil(wait / 1000)} 秒后再试`, 'transport')
    }
    return this.binding
  }

  private async request<T>(
    method: string,
    params: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    const api = this.api
    if (!api) throw new ChannelError('Telegram 渠道尚未启动', 'transport')
    try {
      return await api.call<T>(method, params, options)
    } catch (err) {
      if (err instanceof TelegramApiError) {
        if (err.retryAfterMs !== null) {
          this.pausedUntil = Math.max(this.pausedUntil, this.now() + err.retryAfterMs)
        }
        if (err.unauthorized) this.disable(err.status)
      }
      throw err
    }
  }

  private disable(status: number | null) {
    if (this.disabled) return
    this.disabled = `Telegram 拒绝了 bot token（${status ?? '?'}），渠道已停用：请检查 secret://telegram/bot-token`
    this.deps.logger?.warn(this.disabled)
    this.abort.abort()
  }

  /** 发一条文字消息（命令结果、提示）；失败只记日志。 */
  private async reply(chatId: number, text: string, replyTo?: number) {
    if (this.disabled || this.pausedUntil > this.now()) return
    try {
      await this.request(
        'sendMessage',
        {
          chat_id: chatId,
          text: plainText(text, this.redact),
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          ...(replyTo === undefined
            ? {}
            : { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }),
        },
        { timeoutMs: REPLY_TIMEOUT_MS },
      )
    } catch (err) {
      this.warn('Telegram 回复发送失败', err)
    }
  }

  private async answer(queryId: string, text: string) {
    if (this.disabled) return
    try {
      await this.request(
        'answerCallbackQuery',
        { callback_query_id: queryId, text: this.redact(text).slice(0, 190) },
        { timeoutMs: REPLY_TIMEOUT_MS },
      )
    } catch (err) {
      this.warn('Telegram 按钮应答失败', err)
    }
  }

  private warn(message: string, err: unknown) {
    const text = err instanceof Error ? err.message : String(err)
    this.deps.logger?.warn(message, { error: this.api ? this.api.scrub(text) : text })
  }

  // ---------------------------------------------------------------------------
  // 长轮询

  private async pollLoop(): Promise<void> {
    let failures = 0
    const signal = this.abort.signal
    while (!this.stopped && !this.disabled) {
      const wait = this.pausedUntil - this.now()
      if (wait > 0) await this.sleep(wait, signal)
      if (this.stopped || this.disabled) break
      let updates: TelegramUpdate[]
      const timeout = this.deps.pollTimeoutS ?? 50
      try {
        updates = await this.request<TelegramUpdate[]>(
          'getUpdates',
          { offset: this.offset, timeout, allowed_updates: ['message', 'callback_query'] },
          { signal, timeoutMs: (timeout + 15) * 1000 },
        )
        if (failures > 0) this.deps.logger?.info('Telegram 长轮询已恢复', { failures })
        failures = 0
      } catch (err) {
        if (this.stopped || this.disabled) break
        failures += 1
        const delay = Math.min(POLL_BACKOFF_MAX_MS, 1000 * 2 ** Math.min(failures - 1, 20))
        this.warn('Telegram 长轮询失败，稍后重试', err)
        await this.sleep(delay, signal)
        continue
      }
      await this.refreshBinding()
      const sorted = (Array.isArray(updates) ? updates : [])
        .filter((u) => Number.isSafeInteger(u?.update_id))
        .sort((a, b) => a.update_id - b.update_id)
      for (const update of sorted) {
        if (this.stopped) break
        if (update.update_id < this.offset) continue
        try {
          await this.handleUpdate(update)
        } catch (err) {
          this.warn('处理 Telegram 更新失败', err)
        }
        this.offset = update.update_id + 1
        try {
          await saveTelegramState(this.deps.statePath, { offset: this.offset, bot_id: this.botId })
        } catch (err) {
          this.warn('保存 Telegram 进度失败', err)
        }
      }
    }
  }

  /** 重新读取绑定（用户可能手动删除了 chat_id）；读取失败时沿用当前绑定。 */
  private async refreshBinding() {
    const loaded = await this.deps.loadConfig()
    if (!loaded.ok) return
    this.binding = bindingOf(loaded.data.telegram)
  }

  // ---------------------------------------------------------------------------
  // 入站

  /** 消息或按钮来自已绑定的私聊与用户。 */
  private authorized(chat: TelegramChat | undefined, from: TelegramUser | undefined): boolean {
    const b = this.binding
    return (
      b !== null &&
      chat !== undefined &&
      from !== undefined &&
      chat.type === 'private' &&
      from.is_bot !== true &&
      chat.id === b.chat_id &&
      from.id === b.user_id
    )
  }

  private ignore(reason: string, chat: TelegramChat | undefined, from: TelegramUser | undefined) {
    this.ignored += 1
    if (this.ignored <= IGNORE_LOG_FIRST || this.ignored % IGNORE_LOG_EVERY === 0) {
      this.deps.logger?.warn('已忽略 Telegram 访问', {
        reason,
        chat_type: chat?.type ?? null,
        chat_id: chat?.id ?? null,
        from_id: from?.id ?? null,
        ignored_total: this.ignored,
      })
    }
  }

  private async handleUpdate(update: TelegramUpdate) {
    if (update.message) await this.handleMessage(update.message)
    else if (update.callback_query) await this.handleCallback(update.callback_query)
  }

  private async handleMessage(m: TelegramMessage) {
    const { chat, from } = m
    if (chat?.type !== 'private') return this.ignore('不是私聊', chat, from)
    const text = typeof m.text === 'string' ? m.text.trim() : ''
    const command = parseCommand(text)
    if (command && (command.name === 'link' || command.name === 'start') && command.args) {
      if (await this.tryLink(command.args, m)) return
      if (!this.authorized(chat, from)) return this.ignore('绑定码无效', chat, from)
      return this.reply(chat.id, '绑定码无效或已过期，请在电脑上重新运行 flow telegram link。')
    }
    if (!this.authorized(chat, from)) return this.ignore('未绑定的 chat 或用户', chat, from)
    if (m.reply_to_message) return this.handleReply(m, text)
    if (command) return this.handleCommand(command, m)
    return this.reply(chat.id, HELP_TEXT)
  }

  private async tryLink(code: string, m: TelegramMessage): Promise<boolean> {
    const { chat, from } = m
    if (!from || from.is_bot === true || from.id !== chat.id) return false
    if (!this.deps.links.redeem(code)) return false
    const binding = { chat_id: chat.id, user_id: from.id }
    const saved = await this.deps.saveBinding(binding)
    if (!saved.ok) {
      this.deps.logger?.warn('Telegram 绑定写入失败', { error: saved.error.code })
      await this.reply(chat.id, '绑定没有完成：写入配置失败，请在电脑上查看中枢日志后重试。')
      return true
    }
    const previous = this.binding
    this.binding = binding
    if (previous && previous.chat_id !== binding.chat_id) {
      this.deps.logger?.warn('Telegram 已改绑到新的 chat', { from: previous.chat_id })
    }
    this.deps.logger?.info('Telegram 已绑定', { chat_id: binding.chat_id })
    await this.reply(chat.id, `已绑定。之后需要你处理的事情会推送到这里。\n\n${HELP_TEXT}`)
    this.deps.onBound?.()
    return true
  }

  private async handleReply(m: TelegramMessage, text: string) {
    const chatId = m.chat.id
    const target = m.reply_to_message?.message_id
    const ids =
      target === undefined
        ? []
        : this.deps.ledger.channelMessageItems(TELEGRAM_CHANNEL_ID, `${chatId}:${target}`)
    if (ids.length === 0) {
      return this.reply(chatId, '这条消息没有对应的条目。直接回复条目消息即可答复。', m.message_id)
    }
    let itemId = ids[0]
    let body = text
    if (ids.length > 1) {
      // 合并消息：以 #<短 id> 开头指明条目。
      const match = /^#?([0-9a-z]{1,11})\s+([\s\S]+)$/.exec(text)
      const items = ids.map((id) => this.deps.ledger.getInboxItem(id)).filter((i) => i !== null)
      const hit = match ? items.find((i) => i.short_id === match[1]) : undefined
      if (!match?.[2] || !hit) {
        const list = items.map((i) => `#${i.short_id}`).join('、')
        return this.reply(
          chatId,
          `这条消息里有多个条目，请以 #短 id 开头指明答复哪一条，例如 "#${items[0]?.short_id ?? 'a1'} 内容"。可选：${list}`,
          m.message_id,
        )
      }
      itemId = hit.id
      body = match[2].trim()
    }
    if (!body) return this.reply(chatId, '只支持文字回复，内容不能为空。', m.message_id)
    if (!itemId || !this.onAction) return
    const r = await this.onAction({ item: itemId, action: 'reply', text: body })
    return this.reply(chatId, r.ok ? '已回复' : `没有完成：${r.error.message}`, m.message_id)
  }

  private async handleCallback(q: TelegramCallbackQuery) {
    const chat = q.message?.chat
    if (!this.authorized(chat, q.from))
      return this.ignore('未绑定的 chat 或用户的按钮', chat, q.from)
    const parsed = parseCallbackData(q.data)
    const messageId = q.message?.message_id
    const item = parsed ? this.deps.ledger.getInboxItemByShortId(parsed.short_id) : null
    const ids =
      chat && messageId !== undefined
        ? this.deps.ledger.channelMessageItems(TELEGRAM_CHANNEL_ID, `${chat.id}:${messageId}`)
        : []
    // 按钮必须属于这条消息里的条目（防止伪造的 callback_data 操作别的条目）。
    if (!parsed || !item || !ids.includes(item.id) || !this.onAction) {
      return this.answer(q.id, '按钮已失效')
    }
    const r = await this.onAction({ item: item.id, action: parsed.action })
    return this.answer(
      q.id,
      r.ok
        ? ACTION_DONE[parsed.action]
        : r.error.code === 'item_closed'
          ? '这个条目已经处理过了'
          : `没有完成：${r.error.message}`,
    )
  }

  private async handleCommand(c: ParsedCommand, m: TelegramMessage) {
    const chatId = m.chat.id
    switch (c.name) {
      case 'inbox':
        return this.reply(chatId, listOpenItems(this.deps.ledger))
      case 'status':
        return this.reply(chatId, statusText(this.deps.status()))
      case 'capture': {
        if (!c.args) return this.reply(chatId, '用法：/capture <内容>')
        const r = await this.deps.capture(c.args)
        return this.reply(
          chatId,
          r.ok ? `已记下：${r.data.file}` : `没有记下：${r.error.message}`,
          m.message_id,
        )
      }
      case 'ask': {
        const match = /^(\S+)\s+([\s\S]+)$/.exec(c.args)
        if (!match?.[1] || !match[2]?.trim()) {
          return this.reply(
            chatId,
            '用法：/ask <workspace> <内容>，例如 /ask ws/product 看看昨天的部署',
          )
        }
        const ws = match[1].startsWith('ws/') ? match[1] : `ws/${match[1]}`
        const r = await this.deps.ask(ws, match[2].trim())
        return this.reply(
          chatId,
          r.ok ? '已记录，supervisor 尚未启用' : `没有记录：${r.error.message}`,
          m.message_id,
        )
      }
      default:
        return this.reply(chatId, HELP_TEXT)
    }
  }
}

/** 注册 Telegram 渠道：`config` 是 channels.yaml 的 telegram 段，`bot_token` 是 `secret://` 引用。 */
export function telegramChannelSpec(
  config: TelegramChannelConfig,
  deps: TelegramDeps,
): ChannelSpec<TelegramChannelConfig> {
  return {
    id: TELEGRAM_CHANNEL_ID,
    config,
    create: (resolved) => new TelegramChannel(resolved, deps),
  }
}
