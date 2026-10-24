import type {
  InboxAction,
  InboxCloseReason,
  InboxItemAction,
  InboxLevel,
  InboxSource,
  InboxVia,
  Result,
} from '@flow/core'

/**
 * 推送渠道插件接口（notify-channel "渠道插件接口"；add-m1-inbox 4.1）。
 *
 * 渠道在中枢进程内运行，由渠道管理器（`manager.ts`）统一调度：
 * - 管理器决定推送什么、什么时候推送（推送节奏 3.3），渠道只负责把消息送到用户那里；
 * - 交给渠道的文本都已脱敏（名单 + 正则）、终端片段已截断，渠道不需要再处理密钥；
 * - 渠道的任何方法抛错或超时，只影响该渠道自己：管理器记录警告、按指数退避重试，
 *   未送达的条目保持 pending，恢复后补推；中枢其他功能与其他渠道不受影响。
 */

/** 外发的一个条目（已脱敏、已截断）。 */
export interface OutboundItem {
  /** 条目 id，例如 `blk.42`。 */
  id: string
  /** 短 id（base36），按钮的 callback 等长度受限的地方用它。 */
  short_id: string
  level: InboxLevel
  source: InboxSource
  workspace: string | null
  task_id: string | null
  title: string
  /** 正文（任务卡住时是卡住说明，不含终端片段）。 */
  text: string
  /** 终端输出的末尾片段；没有或配置为不发送时为 null。 */
  snippet: string | null
  /** 可用的操作；条目未关闭时，忽略（dismiss）总是可用，不在这里列出。 */
  actions: InboxItemAction[]
  state: 'open' | 'closed'
  /** 关闭信息；`label` 是给用户看的说明，例如"已处理（来自 CLI）"。 */
  closed: { reason: InboxCloseReason; label: string } | null
}

/**
 * 一条外发消息：
 * - `item`：单个条目（Interrupt、每日摘要）；
 * - `batch`：多个 Decide 条目合并成的一条消息。
 */
export type ChannelMessage =
  | { kind: 'item'; item: OutboundItem }
  | { kind: 'batch'; items: OutboundItem[] }

/** 渠道里用户发起的操作（按钮、回复），由渠道转换后交给收件箱。 */
export interface InboundAction {
  /** 条目 id 或短 id。 */
  item: string
  action: InboxAction
  /** 回复的文字（action 为 reply 时）。 */
  text?: string
}

/** 入站操作的处理结果（渠道据此回应用户，例如 answerCallbackQuery）。 */
export type InboundResult = Result<{ item_id: string }>

export type InboundHandler = (request: InboundAction) => Promise<InboundResult>

export interface ChannelPlugin {
  /** 渠道 id，例如 `telegram`；同一中枢内唯一。 */
  readonly id: string
  /** 经由该渠道发起的操作记为哪个来源（design D3 的 `via`）。 */
  readonly via: InboxVia
  /** 发送一条消息，返回渠道内的消息引用（之后 `update` 用它）。 */
  send(message: ChannelMessage): Promise<string>
  /** 更新已发送的消息，例如把已关闭的条目标记为已处理。 */
  update(ref: string, message: ChannelMessage): Promise<void>
  /** 启动入站（例如 Telegram 的长轮询）；用户的操作交给 `onAction`。 */
  start(onAction: InboundHandler): Promise<void>
  stop(): Promise<void>
}

/**
 * 渠道的注册项。`config` 中可以有 `secret://` 引用：管理器先解析，缺少密钥时该渠道不启动，
 * 在 `flow hub status` 中报告缺少的路径（secret-provider "token 未配置"）。
 */
export interface ChannelSpec<C = unknown> {
  id: string
  config?: C
  create(config: C): ChannelPlugin
}

/** 收件箱操作（3.2 的 `inbox_act`）：渠道的入站操作最终调用它，以 `user` 身份执行。 */
export type InboxActFn = (
  itemId: string,
  action: InboxAction,
  text: string | undefined,
  via: InboxVia,
) => Promise<Result<unknown>>

/** 渠道状态（`flow hub status`）。 */
export interface ChannelStatus {
  id: string
  /**
   * - `running`：正常；
   * - `backoff`：最近一次调用失败，等待重试；
   * - `disabled`：缺少密钥等原因未启动；
   * - `stopped`：中枢正在停止。
   */
  state: 'running' | 'backoff' | 'disabled' | 'stopped'
  missing_secrets: string[]
  failures: number
  next_retry_at: string | null
  last_error: string | null
}
