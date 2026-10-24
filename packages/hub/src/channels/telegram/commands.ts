import type { InboxItemView } from '@flow/core'
import type { LedgerStore } from '../../ledger/store.ts'
import type { ChannelStatus } from '../types.ts'

/**
 * bot 命令的文字（telegram-channel "命令"）。这里只生成纯文本，发送前由插件统一脱敏、截断、HTML 转义。
 */

export interface ParsedCommand {
  name: string
  args: string
}

/** `/name@bot 参数…`；参数保留换行。不是命令时返回 null。 */
export function parseCommand(text: string): ParsedCommand | null {
  const m = /^\/([A-Za-z][A-Za-z0-9_]{0,31})(?:@[A-Za-z0-9_]{1,64})?(?:\s+([\s\S]*))?$/.exec(text)
  if (!m?.[1]) return null
  return { name: m[1].toLowerCase(), args: (m[2] ?? '').trim() }
}

export const HELP_TEXT = [
  'Flow 可以这样用：',
  '· 直接回复一条条目消息：答复对应的任务',
  '· 点消息下的按钮：批准、驳回、接受、拒绝或忽略',
  '/inbox — 列出未关闭的条目',
  '/status — 中枢、节点与渠道的状态',
  '/capture <内容> — 随手记，写入 raw/inbox/',
  '/ask <workspace> <内容> — 给 supervisor 的指令',
].join('\n')

const LEVEL_TAG = { interrupt: '紧急', decide: '待定', digest: '摘要' } as const
const INBOX_LIST_MAX = 30

export function inboxText(items: readonly InboxItemView[], total: number): string {
  if (items.length === 0) return '收件箱是空的。'
  const lines = items.map((i) => {
    const ws = i.workspace ? ` ${i.workspace}` : ''
    return `#${i.short_id} [${LEVEL_TAG[i.level]}]${ws} ${i.title}`
  })
  const more =
    total > items.length ? `\n…另有 ${total - items.length} 条，用 flow inbox 查看全部` : ''
  return `未关闭的条目（${total} 条）：\n${lines.join('\n')}${more}`
}

export function listOpenItems(ledger: Pick<LedgerStore, 'listInboxItems'>): string {
  const all = ledger.listInboxItems({ state: 'open', limit: 1000 })
  return inboxText(all.slice(0, INBOX_LIST_MAX), all.length)
}

/** `/status` 的内容（中枢在 runHub 里组装）。 */
export interface TelegramStatusSnapshot {
  version: string
  uptime_s: number
  channels: ChannelStatus[]
  nodes: { total: number; online: number }
  tasks: { running: number; blocked: number; queued: number }
  open_items: number
  /** 过去 24 小时策略自动放行（auto、auto-report）的次数。 */
  auto_decisions_24h: number
}

const CHANNEL_STATE: Readonly<Record<ChannelStatus['state'], string>> = {
  running: '正常',
  backoff: '重试中',
  disabled: '未启用',
  stopped: '已停止',
}

const duration = (s: number) => {
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} 分钟`
  if (s < 86_400) return `${Math.round(s / 360) / 10} 小时`
  return `${Math.round(s / 8640) / 10} 天`
}

export function statusText(s: TelegramStatusSnapshot): string {
  const channels = s.channels.map((c) => {
    const extra = c.state === 'backoff' ? `（连续失败 ${c.failures} 次）` : ''
    return `${c.id} ${CHANNEL_STATE[c.state]}${extra}`
  })
  return [
    `中枢：运行中（${s.version}，已运行 ${duration(s.uptime_s)}）`,
    `节点：${s.nodes.online} 个在线 / 共 ${s.nodes.total} 个`,
    `任务：运行中 ${s.tasks.running}，卡住 ${s.tasks.blocked}，排队 ${s.tasks.queued}`,
    `收件箱：${s.open_items} 条未关闭`,
    `过去 24 小时自动放行：${s.auto_decisions_24h} 次`,
    `渠道：${channels.length > 0 ? channels.join('；') : '无'}`,
  ].join('\n')
}

/** 节点视为在线的最近活动时间窗口。 */
const NODE_ONLINE_MS = 5 * 60_000
const TASK_COUNT_LIMIT = 500

/** 由账本组装 `/status`（runHub 与测试共用）。 */
export function buildStatusSnapshot(o: {
  ledger: Pick<LedgerStore, 'listNodes' | 'listTasks' | 'listInboxItems' | 'countAutoDecisions'>
  now: number
  startedAt: number
  version: string
  channels: ChannelStatus[]
}): TelegramStatusSnapshot {
  const count = (status: 'running' | 'blocked' | 'queued') =>
    o.ledger.listTasks({ status, limit: TASK_COUNT_LIMIT }).length
  const nodes = o.ledger.listNodes()
  return {
    version: o.version,
    uptime_s: Math.max(0, (o.now - o.startedAt) / 1000),
    channels: o.channels,
    nodes: {
      total: nodes.length,
      online: nodes.filter(
        (n) => n.last_seen_at !== null && o.now - Date.parse(n.last_seen_at) <= NODE_ONLINE_MS,
      ).length,
    },
    tasks: { running: count('running'), blocked: count('blocked'), queued: count('queued') },
    open_items: o.ledger.listInboxItems({ state: 'open', limit: 10_000 }).length,
    auto_decisions_24h: o.ledger.countAutoDecisions(
      new Date(o.now - 24 * 60 * 60_000).toISOString(),
    ),
  }
}
