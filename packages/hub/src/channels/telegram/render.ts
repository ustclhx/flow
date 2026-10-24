import type { InboxAction, InboxLevel } from '@flow/core'
import type { ChannelMessage, OutboundItem } from '../types.ts'
import type { InlineButton, ReplyMarkup } from './api.ts'

/**
 * Telegram 消息的渲染（add-m1-inbox 5.2；telegram-channel "条目消息与交互"）：
 * - `parse_mode=HTML`：**所有动态文本**（标题、正文、片段、workspace、关闭说明）都先截断再 HTML 转义，
 *   条目里的 `<b>`、`&` 原样显示，不会变成格式或破坏消息；
 * - 消息正文（解析后的可见文字）不超过 4096 字符：按预算截断各段，超出时缩小预算重来；
 * - 内联按钮按条目可用的操作生成，`callback_data` 为 `i:<短 id>:<操作>`，不超过 64 字节；
 *   需要文字答复的条目不放按钮，提示"直接回复这条消息"；
 * - Decide 合并消息里每条都带短 id，按钮文字也带短 id，回复时以 `#<短 id>` 开头指明条目。
 *
 * 交给渠道的文字已由渠道管理器脱敏；这里再过一次 `redact`（幂等），保证任何外发文本都经过脱敏。
 */

export const TELEGRAM_TEXT_MAX = 4096
export const CALLBACK_DATA_MAX = 64
/** 一条消息里内联按钮的上限（Telegram 限制为 100）。 */
const BUTTON_MAX = 100

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const unescapeHtml = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')

/** HTML 消息解析后的可见文字长度（去掉标签、实体按一个字符计）。 */
export function visibleLength(html: string): number {
  return html.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot);/g, '_').length
}

const clip = (s: string, max: number) =>
  max <= 0 ? '' : s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s
const clipTail = (s: string, max: number) =>
  max <= 0 ? '' : s.length > max ? `…${s.slice(s.length - (max - 1))}` : s

const LEVEL: Readonly<Record<InboxLevel, string>> = {
  interrupt: '🔴 需要你处理',
  decide: '🟡 待你决定',
  digest: '📋 摘要',
}

/** 按钮上的操作（reply 不是按钮：直接回复消息即可）。 */
export const BUTTON_ACTIONS = ['approve', 'deny', 'accept', 'reject', 'dismiss'] as const
export type ButtonAction = (typeof BUTTON_ACTIONS)[number]

export const ACTION_LABEL: Readonly<Record<InboxAction, string>> = {
  approve: '批准',
  deny: '驳回',
  reply: '回复',
  accept: '接受',
  reject: '拒绝',
  dismiss: '忽略',
}

/** 按钮操作完成后给用户的提示（answerCallbackQuery）。 */
export const ACTION_DONE: Readonly<Record<InboxAction, string>> = {
  approve: '已批准',
  deny: '已驳回',
  reply: '已回复',
  accept: '已接受',
  reject: '已拒绝',
  dismiss: '已忽略',
}

export function callbackData(shortId: string, action: ButtonAction): string {
  return `i:${shortId}:${action}`
}

const CALLBACK_RE = /^i:([0-9a-z]{1,11}):(approve|deny|accept|reject|dismiss)$/

export function parseCallbackData(data: string | undefined): {
  short_id: string
  action: ButtonAction
} | null {
  if (!data || Buffer.byteLength(data, 'utf8') > CALLBACK_DATA_MAX) return null
  const m = CALLBACK_RE.exec(data)
  if (!m?.[1] || !m[2]) return null
  return { short_id: m[1], action: m[2] as ButtonAction }
}

/** 条目当前可用的按钮操作：条目上的操作（reply 除外）加上忽略。 */
export function buttonActions(item: OutboundItem): ButtonAction[] {
  if (item.state !== 'open') return []
  const out: ButtonAction[] = []
  for (const a of item.actions) if (a !== 'reply' && !out.includes(a)) out.push(a)
  out.push('dismiss')
  return out
}

function buttonsFor(item: OutboundItem, prefix: string): InlineButton[] {
  return buttonActions(item)
    .map((a) => ({
      text: `${prefix}${ACTION_LABEL[a]}`,
      callback_data: callbackData(item.short_id, a),
    }))
    .filter((b) => Buffer.byteLength(b.callback_data, 'utf8') <= CALLBACK_DATA_MAX)
}

export interface RenderedTelegram {
  text: string
  reply_markup: ReplyMarkup
}

type Redact = (s: string) => string

function renderItem(item: OutboundItem, scale: number, r: Redact): string {
  const top = [`<b>${escapeHtml(LEVEL[item.level])}</b>`]
  if (item.workspace) top.push(`<code>${escapeHtml(r(item.workspace))}</code>`)
  top.push(`<code>#${escapeHtml(item.short_id)}</code>`)
  const lines = [top.join(' · ')]
  if (item.closed) lines.push(`✅ <b>${escapeHtml(r(item.closed.label))}</b>`)
  lines.push(`<b>${escapeHtml(clip(r(item.title), 200))}</b>`)
  const text = clip(r(item.text), Math.floor(1500 * scale))
  if (text.trim()) lines.push(escapeHtml(text))
  if (item.state === 'open' && item.snippet) {
    const snippet = clipTail(r(item.snippet), Math.floor(1500 * scale))
    if (snippet) lines.push(`<pre>${escapeHtml(snippet)}</pre>`)
  }
  if (item.state === 'open' && item.actions.includes('reply')) {
    lines.push('<i>直接回复这条消息即可答复</i>')
  }
  return lines.join('\n\n')
}

function renderBatch(items: OutboundItem[], scale: number, r: Redact): string {
  const open = items.filter((i) => i.state === 'open').length
  const lines = [
    `<b>${escapeHtml(LEVEL.decide)} · ${items.length} 条</b>${open < items.length ? `（${open} 条待处理）` : ''}`,
  ]
  const per = Math.max(60, Math.floor((2400 * scale) / Math.max(1, items.length)))
  items.forEach((item, index) => {
    const ws = item.workspace ? ` · <code>${escapeHtml(r(item.workspace))}</code>` : ''
    const parts = [
      `${index + 1}. <code>#${escapeHtml(item.short_id)}</code>${ws} <b>${escapeHtml(clip(r(item.title), Math.min(150, per)))}</b>`,
    ]
    if (item.closed) {
      parts.push(`✅ ${escapeHtml(r(item.closed.label))}`)
    } else {
      const text = clip(r(item.text), per)
      if (text.trim()) parts.push(escapeHtml(text))
      if (item.actions.includes('reply')) {
        parts.push(`<i>回复本消息并以 #${escapeHtml(item.short_id)} 开头即可答复这一条</i>`)
      }
    }
    lines.push(parts.join('\n'))
  })
  return lines.join('\n\n')
}

function keyboard(message: ChannelMessage): ReplyMarkup {
  const rows: InlineButton[][] = []
  let count = 0
  const push = (row: InlineButton[]) => {
    const room = BUTTON_MAX - count
    if (room <= 0 || row.length === 0) return
    const kept = row.slice(0, room)
    rows.push(kept)
    count += kept.length
  }
  if (message.kind === 'item') push(buttonsFor(message.item, ''))
  else for (const item of message.items) push(buttonsFor(item, `#${item.short_id} `))
  return { inline_keyboard: rows }
}

/** 渲染一条条目消息或合并消息。 */
export function renderTelegramMessage(message: ChannelMessage, redact: Redact): RenderedTelegram {
  let text = ''
  for (const scale of [1, 0.6, 0.35, 0.15, 0.05]) {
    text =
      message.kind === 'item'
        ? renderItem(message.item, scale, redact)
        : renderBatch(message.items, scale, redact)
    if (visibleLength(text) <= TELEGRAM_TEXT_MAX) break
  }
  if (visibleLength(text) > TELEGRAM_TEXT_MAX) {
    // 兜底：条目极多时只保留开头的纯文本。
    text = escapeHtml(clip(unescapeHtml(text.replace(/<[^>]*>/g, '')), TELEGRAM_TEXT_MAX - 100))
  }
  return { text, reply_markup: keyboard(message) }
}

/** 普通文字回复（命令结果、提示）：脱敏、截断、转义。 */
export function plainText(text: string, redact: Redact): string {
  return escapeHtml(clip(redact(text), TELEGRAM_TEXT_MAX - 16))
}
