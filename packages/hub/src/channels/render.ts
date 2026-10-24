import {
  clipText,
  INBOX_BODY_MAX,
  type InboxCloseReason,
  type InboxItemView,
  type InboxVia,
  redactSecrets,
} from '@flow/core'
import type { LedgerStore } from '../ledger/store.ts'
import type { ChannelMessage, OutboundItem } from './types.ts'

/**
 * 外发内容的生成（notify-channel "外发内容脱敏"）：
 * - 所有文字先经过 `redact`（默认 core 的 `redactSecrets`：已注册的名单替换 + 疑似密钥正则）；
 * - 任务卡住的条目，正文取卡住说明，终端片段取源事件的末尾输出，**先脱敏再截断**到末尾
 *   `snippetMax` 个字符（截断可能切开密钥，切开后的半截就认不出来了）；
 * - 关闭的条目附上给用户看的说明，例如"已处理（来自 CLI）"。
 */

export interface RenderOptions {
  ledger: Pick<LedgerStore, 'eventsAfter'>
  /** 终端片段保留的末尾字符数；0 表示不发片段。 */
  snippetMax: number
  redact?: (text: string) => string
}

const VIA_LABEL: Readonly<Record<InboxVia, string>> = {
  telegram: 'Telegram',
  web: '网页',
  cli: 'CLI',
}

const REASON_LABEL: Readonly<Record<InboxCloseReason, string>> = {
  task_running: '已处理（任务已恢复）',
  task_queued: '已处理（任务已重新排队）',
  task_done: '已处理（任务已完成）',
  task_failed: '已处理（任务已失败）',
  task_cancelled: '已处理（任务已取消）',
  superseded: '已被新的条目取代',
  proposal_accepted: '已处理（提案已接受）',
  proposal_rejected: '已处理（提案已拒绝）',
  proposal_removed: '已处理（提案已不存在）',
  answered: '已处理（已答复）',
  dismissed: '已忽略',
  acted: '已处理',
  digested: '已写入每日摘要',
}

/** 关闭说明：经由某个渠道处理的注明渠道；用户在终端处理（只有 cause_actor=user）的注明 CLI。 */
export function closedLabel(closed: NonNullable<InboxItemView['closed']>): string {
  if (closed.reason === 'dismissed') {
    return closed.via ? `已忽略（来自 ${VIA_LABEL[closed.via]}）` : REASON_LABEL.dismissed
  }
  if (closed.via) return `已处理（来自 ${VIA_LABEL[closed.via]}）`
  if (closed.cause_actor === 'user' || closed.by === 'user') return '已处理（来自 CLI）'
  return REASON_LABEL[closed.reason]
}

/** 保留末尾 max 个字符，超出时以 `…` 开头。 */
export function clipTailText(s: string, max: number): string {
  if (max <= 0) return ''
  return s.length > max ? `…${s.slice(s.length - (max - 1))}` : s
}

/** 任务卡住条目的源事件（`blk.<seq>` 的 task.blocked）。 */
function blockedSource(item: InboxItemView, ledger: RenderOptions['ledger']) {
  if (item.source !== 'task' || !item.id.startsWith('blk.') || item.task_id === null) return null
  const seq = Number(item.id.slice(4))
  if (!Number.isSafeInteger(seq) || seq < 1) return null
  const e = ledger.eventsAfter(seq - 1, { task_id: item.task_id }, 1)[0]
  return e?.seq === seq && e.type === 'task.blocked' ? e : null
}

export function toOutbound(item: InboxItemView, o: RenderOptions): OutboundItem {
  const redact = o.redact ?? redactSecrets
  const source = blockedSource(item, o.ledger)
  let text = item.body
  let snippet: string | null = null
  if (source) {
    text = source.payload.message
    const tail = (source.payload.tail ?? []).join('\n')
    if (tail.length > 0 && o.snippetMax > 0) snippet = clipTailText(redact(tail), o.snippetMax)
  }
  return {
    id: item.id,
    short_id: item.short_id,
    level: item.level,
    source: item.source,
    workspace: item.workspace,
    task_id: item.task_id,
    title: redact(item.title),
    text: clipText(redact(text), INBOX_BODY_MAX),
    snippet,
    actions: item.state === 'open' ? [...item.actions] : [],
    state: item.state,
    closed: item.closed ? { reason: item.closed.reason, label: closedLabel(item.closed) } : null,
  }
}

export function renderMessage(
  kind: 'item' | 'batch',
  items: readonly InboxItemView[],
  o: RenderOptions,
): ChannelMessage {
  const out = items.map((i) => toOutbound(i, o))
  if (kind === 'batch') return { kind: 'batch', items: out }
  const first = out[0]
  if (!first) throw new Error('消息中没有条目')
  return { kind: 'item', item: first }
}
