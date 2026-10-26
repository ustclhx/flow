import {
  type ChannelsConfig,
  chatDigest,
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
 *   记一笔（日志限流）。唯一例外是私聊里的 `/link <绑定码>`（或 `/start <绑定码>`）：码正确才绑定；
 *   码错误时对未绑定的 chat 同样不回复，并按 chat 限流（见 link.ts）；
 * - **改绑**：已绑定时兑换新码，先给原 chat 发通知，再切换，并写 `channel.rebound`（只记 chat id 摘要）；
 *   `flow telegram link` 在已绑定时必须加 `--rebind` 才发码。持有 user token 的本机进程（包括 worker）
 *   能申请绑定码是已知边界，所以改绑一定通知原 chat；
 * - bot token 只存在于内存中的 API 客户端里，错误信息与日志都去掉了 token（见 api.ts）；
 * - 外发的所有文字都经过 `redact`（默认 core 的 `redactSecrets`）再 HTML 转义；
 * - 入站的文字（回复、`/capture`、`/ask`）也先经过 `redact`（名单 + 正则）再交给收件箱、raw 与账本：
 *   用户在手机上粘贴的密钥不会原样写进 git 或账本；`/ask` 拒绝转发来的消息与经 inline bot 发出的消息，
 *   指令必须是用户本人直接输入的。
 *
 * **token 泄露的迹象**（状态的 `warning`）：getUpdates 返回 409（另一个 getUpdates 在运行，或 bot 被设置了
 * webhook）、启动时 getWebhookInfo 发现 webhook，都说明可能有人在使用同一个 token。只告警，不自动删除
 * webhook。token 泄露意味着消息可被篡改、送达可被劫持，需要立即在 @BotFather 吊销（docs/telegram.md）。
 *
 * **收取**：getUpdates 长轮询（timeout=50，只收 message 与 callback_query），每处理完一条就把 offset
 * 写入 `state/telegram.json`，重启后不重复处理。轮询失败按 1s、2s、4s… 退避（最长 5 分钟）；
 * 429 时在 `retry_after` 之前不再发出任何请求；401 / 404（token 无效）时停用渠道并在状态中报告，
 * 之后每 30 分钟用 getMe 重试一次，恢复后继续轮询并补推；密钥变化时由渠道管理器重新创建。
 */

export const TELEGRAM_CHANNEL_ID = 'telegram'
/** 轮询失败的最长退避。 */
const POLL_BACKOFF_MAX_MS = 5 * 60_000
/** 被忽略的访问：前 20 次逐条记日志，之后每 100 次记一条。 */
const IGNORE_LOG_FIRST = 20
const IGNORE_LOG_EVERY = 100
/** 普通回复（命令结果等）的超时。 */
const REPLY_TIMEOUT_MS = 20_000
/** token 被拒绝（401）后重试 getMe 的间隔。 */
export const TOKEN_RETRY_MS = 30 * 60_000

/** 改绑时发给原 chat 的通知。 */
export const REBIND_NOTICE =
  'Flow 的 Telegram 渠道已改绑到另一个 Telegram 账号。若非本人操作，请立即在电脑上运行 flow telegram unlink，并在 @BotFather 吊销 bot token。'

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
  /** 绑定成功、token 恢复可用后调用：渠道管理器立即补推 pending 的条目。 */
  wake?: () => void
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

/** 转发来的消息、经 inline bot 发出的消息：不是用户本人直接输入的。 */
const isForwarded = (m: TelegramMessage) =>
  m.forward_origin !== undefined ||
  m.forward_from !== undefined ||
  m.forward_date !== undefined ||
  m.via_bot !== undefined

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
  /** 停用后下一次重试 getMe 的时间。 */
  private retryAt: number | null = null
  private warning: string | null = null
  private ignored = 0
  private pausedUntil = 0
  private offset = 0
  private botId: number | null
  private stopped = false
  /** 停止插件（stop）。 */
  private readonly abort = new AbortController()
  /** 停止当前这一轮长轮询（停用时）。 */
  private pollAbort = new AbortController()
  private loop: Promise<void> | null = null
  private retryLoop: Promise<void> | null = null
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
    return {
      disabled: this.disabled,
      ignored: this.ignored,
      warning: this.warning,
      retry_at:
        this.disabled && this.retryAt !== null ? new Date(this.retryAt).toISOString() : null,
    }
  }

  async start(onAction: InboundHandler): Promise<void> {
    this.onAction = onAction
    if (!this.api) {
      const env = this.deps.env ?? process.env
      const proxy = this.config.proxy ?? env.HTTPS_PROXY ?? env.https_proxy ?? null
      let fetch = this.deps.fetch
      if (!fetch) {
        // Node 的代理是进程级的：只有配置文件显式写了 telegram.proxy 才启用。
        const built = await proxiedFetch(proxy, { global: this.config.proxy !== undefined })
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
    this.deps.links.onUnlinked = () => {
      this.binding = null
    }
    try {
      const me = await this.request<TelegramUser>('getMe', {}, { timeoutMs: REPLY_TIMEOUT_MS })
      this.deps.links.botUsername = me.username ?? null
    } catch (err) {
      // token 被拒绝：已停用并安排定时重试，start 本身算成功（状态报告 disabled）。
      if (this.disabled) return
      throw err
    }
    await this.checkWebhook()
    if (this.binding === null) {
      this.deps.logger?.info('Telegram 渠道已启动，尚未绑定 chat：运行 flow telegram link')
    }
    this.loop = this.pollLoop()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.abort.abort()
    this.pollAbort.abort()
    this.deps.links.onUnlinked = null
    await this.loop
    await this.retryLoop
  }

  /** 启动时检查 webhook：设置了 webhook 说明有别的程序在用这个 token。只告警，不删除。 */
  private async checkWebhook() {
    try {
      const info = await this.request<{ url?: string }>(
        'getWebhookInfo',
        {},
        { timeoutMs: REPLY_TIMEOUT_MS },
      )
      if (typeof info?.url === 'string' && info.url.length > 0) {
        this.setWarning('bot 设置了 webhook：可能有人在使用同一个 bot token（未自动删除）')
      }
    } catch (err) {
      this.warn('Telegram getWebhookInfo 失败', err)
    }
  }

  private setWarning(text: string) {
    if (this.warning?.startsWith(text)) return
    this.warning = `${text}；${new Date(this.now()).toISOString()}`
    this.deps.logger?.warn('Telegram 可能有人在使用同一个 bot token', { warning: text })
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
        if (err.conflict === 'webhook') {
          this.setWarning('getUpdates 冲突：bot 设置了 webhook，可能有人在使用同一个 bot token')
        } else if (err.conflict === 'polling') {
          this.setWarning(
            'getUpdates 冲突：另一个程序也在用这个 bot token 轮询，可能有人在使用同一个 bot token',
          )
        }
      }
      throw err
    }
  }

  private disable(status: number | null) {
    if (this.disabled) return
    this.disabled = `Telegram 拒绝了 bot token（${status ?? '?'}），渠道已停用：请检查 secret://telegram/bot-token；每 30 分钟自动重试`
    this.retryAt = this.now() + TOKEN_RETRY_MS
    this.deps.logger?.warn(this.disabled)
    this.pollAbort.abort()
    if (!this.retryLoop && !this.stopped) this.retryLoop = this.retryToken()
  }

  /** 停用后每 30 分钟用 getMe 重试；恢复后重新开始轮询，并请渠道管理器补推。 */
  private async retryToken(): Promise<void> {
    try {
      while (!this.stopped && this.disabled) {
        this.retryAt = this.now() + TOKEN_RETRY_MS
        await this.sleep(TOKEN_RETRY_MS, this.abort.signal)
        if (this.stopped) return
        const api = this.api
        if (!api) return
        try {
          const me = await api.call<TelegramUser>('getMe', {}, { timeoutMs: REPLY_TIMEOUT_MS })
          this.deps.links.botUsername = me.username ?? null
        } catch (err) {
          this.warn('Telegram token 仍不可用', err)
          continue
        }
        await this.loop
        this.disabled = null
        this.retryAt = null
        this.deps.logger?.info('Telegram bot token 已恢复可用')
        this.pollAbort = new AbortController()
        this.loop = this.pollLoop()
        this.deps.wake?.()
      }
    } finally {
      this.retryLoop = null
    }
  }

  /** 发一条文字消息（命令结果、提示）；失败只记日志。 */
  private async reply(chatId: number, text: string, replyTo?: number): Promise<boolean> {
    if (this.disabled || this.pausedUntil > this.now()) return false
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
      return true
    } catch (err) {
      this.warn('Telegram 回复发送失败', err)
      return false
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
    const signal = AbortSignal.any([this.abort.signal, this.pollAbort.signal])
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
      const outcome = await this.tryLink(command.args, m)
      if (outcome === 'ok') return
      // 格式不合法、被限流：一律静默忽略；格式正确但无效：只告诉已绑定的用户本人。
      if (outcome !== 'invalid' || !this.authorized(chat, from)) {
        return this.ignore(`绑定码${outcome === 'limited' ? '尝试过多' : '无效'}`, chat, from)
      }
      await this.reply(chat.id, '绑定码无效或已过期，请在电脑上重新运行 flow telegram link。')
      return
    }
    if (!this.authorized(chat, from)) return this.ignore('未绑定的 chat 或用户', chat, from)
    if (m.reply_to_message) return this.handleReply(m, text)
    if (command) return this.handleCommand(command, m)
    return this.reply(chat.id, HELP_TEXT)
  }

  private async tryLink(
    code: string,
    m: TelegramMessage,
  ): Promise<'ok' | 'invalid' | 'malformed' | 'limited'> {
    const { chat, from } = m
    if (!from || from.is_bot === true || from.id !== chat.id) return 'malformed'
    const outcome = this.deps.links.redeem(code, chat.id)
    if (outcome !== 'ok') return outcome
    const binding = { chat_id: chat.id, user_id: from.id }
    const previous = this.binding
    if (previous && previous.chat_id === binding.chat_id && previous.user_id === binding.user_id) {
      await this.reply(chat.id, '这个账号已经绑定，无需重复绑定。')
      return 'ok'
    }
    if (previous) {
      // 改绑：先通知原 chat，再切换。通知发不出去（例如原账号屏蔽了 bot）也继续，但记日志。
      const notified = await this.reply(previous.chat_id, REBIND_NOTICE)
      if (!notified) this.deps.logger?.warn('Telegram 改绑通知未能送达原 chat')
    }
    const saved = await this.deps.saveBinding(binding)
    if (!saved.ok) {
      this.deps.logger?.warn('Telegram 绑定写入失败', { error: saved.error.code })
      await this.reply(chat.id, '绑定没有完成：写入配置失败，请在电脑上查看中枢日志后重试。')
      return 'ok'
    }
    this.binding = binding
    if (previous) {
      const r = this.deps.ledger.append(
        {
          type: 'channel.rebound',
          payload: {
            channel: TELEGRAM_CHANNEL_ID,
            from_chat: chatDigest(TELEGRAM_CHANNEL_ID, previous.chat_id),
            to_chat: chatDigest(TELEGRAM_CHANNEL_ID, binding.chat_id),
            via: 'telegram',
          },
        },
        { actor: 'user' },
      )
      if (!r.ok) this.deps.logger?.warn('改绑记录写入失败', { error: r.error.code })
      this.deps.logger?.warn('Telegram 已改绑到新的 chat')
    } else {
      this.deps.logger?.info('Telegram 已绑定')
    }
    await this.reply(chat.id, `已绑定。之后需要你处理的事情会推送到这里。\n\n${HELP_TEXT}`)
    this.deps.wake?.()
    return 'ok'
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
      // 合并消息：必须以 #<短 id> 开头指明条目（不把开头的普通单词当作短 id）。
      const match = /^#([0-9a-z]{1,11})\s+([\s\S]+)$/.exec(text)
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
    const r = await this.onAction({ item: itemId, action: 'reply', text: this.redact(body) })
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
    let r: Awaited<ReturnType<InboundHandler>>
    if ('option' in parsed) {
      // 提问的选项按钮：以该选项原文答复（选项取自条目本身，不取自 callback_data）。
      const text = item.options?.[parsed.option]
      if (text === undefined || item.state !== 'open') return this.answer(q.id, '按钮已失效')
      r = await this.onAction({ item: item.id, action: 'reply', text })
    } else {
      r = await this.onAction({ item: item.id, action: parsed.action })
    }
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
        const r = await this.deps.capture(this.redact(c.args))
        return this.reply(
          chatId,
          r.ok ? `已记下：${r.data.file}` : `没有记下：${r.error.message}`,
          m.message_id,
        )
      }
      case 'ask': {
        if (isForwarded(m)) return this.reply(chatId, '请直接输入指令，不要转发', m.message_id)
        const match = /^(\S+)\s+([\s\S]+)$/.exec(c.args)
        if (!match?.[1] || !match[2]?.trim()) {
          return this.reply(
            chatId,
            '用法：/ask <workspace> <内容>，例如 /ask ws/product 看看昨天的部署',
          )
        }
        const ws = match[1].startsWith('ws/') ? match[1] : `ws/${match[1]}`
        const r = await this.deps.ask(ws, this.redact(match[2].trim()))
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
