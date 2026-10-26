import {
  clipText,
  DIFF_STAT_MAX,
  type EventType,
  INBOX_BODY_MAX,
  INBOX_NOTE_MAX,
  INBOX_PUSH_REASON_MAX,
  INBOX_TITLE_MAX,
  PROTOCOL_MESSAGE_MAX,
  redactKnownSecrets,
  redactSecrets,
  sanitizeText,
} from '@flow/core'
import { redactDeep } from '../secrets/redactor.ts'

/**
 * 账本写入前的脱敏（secret-hygiene "已知密钥值的脱敏"）分两档：
 *
 * - **名单替换**（已知密钥值 → `[secret:<路径>]`）作用于载荷中的**所有**字符串：精确匹配，不会误伤；
 * - **正则兜底**（疑似密钥 → `[REDACTED:<规则>]`）只作用于下面列出的**自由文本**字段：
 *   活动、末尾输出、说明、结果摘要、验收输出、回复文字等。
 *
 * 合同（task.created 的 contract）、验收命令的 argv、会话 id、schedule 载荷等结构化、
 * 会被执行或被程序读取的字段只做名单替换，不跑正则：正则的误报会悄悄改掉它们
 * （例如 `tokenizer: bert-base-uncased`、`--token=localtest123`）。合同里的高置信度疑似密钥
 * 在创建任务时直接拒绝（`checkContractSecrets`）。
 */

/** 路径中的 `*` 表示数组的每一项。 */
type FieldPath = readonly string[]

const RESULT_TEXT: readonly FieldPath[] = [
  ['result', 'summary'],
  ['result', 'verify', '*', 'output_tail', '*'],
]

export const FREE_TEXT_FIELDS: Partial<Record<EventType, readonly FieldPath[]>> = {
  'policy.decided': [
    ['request', 'command'],
    ['request', 'paths', '*'],
    ['matched_rules', '*', 'rule', 'when', 'command_prefix'],
    ['matched_rules', '*', 'rule', 'when', 'paths', '*'],
    ['actions', '*', 'matched_rules', '*', 'rule', 'when', 'command_prefix'],
    ['actions', '*', 'matched_rules', '*', 'rule', 'when', 'paths', '*'],
  ],
  'task.done': RESULT_TEXT,
  'task.failed': [...RESULT_TEXT, ['message']],
  'task.cancelled': [...RESULT_TEXT, ['reason']],
  'task.blocked': [['message'], ['tail', '*'], ['diff_stat']],
  'task.reply_escalated': [['note']],
  'supervisor.answered': [['text']],
  'task_proposal.created': [['reason']],
  'task_proposal.rejected': [['note']],
  'task.unblocked': [['note']],
  'task.replied': [['text']],
  'task.requeued': [['note']],
  'task.cancel_requested': [['reason']],
  // 收件箱条目的文字会外发到渠道（notify-channel "外发内容脱敏"），入账前就按自由文本处理。
  'inbox.item_created': [['title'], ['body']],
  'inbox.item_updated': [['title'], ['body']],
  'inbox.item_closed': [['note']],
  'inbox.pushed': [['reason']],
}

/**
 * 自由文本字段的长度上限（字符）：正则兜底前后各截断一次（同 core 的 sanitizeText），
 * 保证脱敏后的载荷仍不超过 schema 的上限。未列出的字段由各自的协议 / 写入方限长。
 */
export const FREE_TEXT_LIMITS: Partial<Record<EventType, Readonly<Record<string, number>>>> = {
  'task.blocked': { diff_stat: DIFF_STAT_MAX },
  'task.reply_escalated': { note: 2000 },
  'supervisor.answered': { text: INBOX_BODY_MAX },
  'task_proposal.created': { reason: 2000 },
  'task_proposal.rejected': { note: 2000 },
  'inbox.item_created': { title: INBOX_TITLE_MAX, body: INBOX_BODY_MAX },
  'inbox.item_updated': { title: INBOX_TITLE_MAX, body: INBOX_BODY_MAX },
  'inbox.item_closed': { note: INBOX_NOTE_MAX },
  'inbox.pushed': { reason: INBOX_PUSH_REASON_MAX },
}

function mapPath(value: unknown, path: FieldPath, fn: (s: string) => string): unknown {
  if (path.length === 0) return typeof value === 'string' ? fn(value) : value
  const [head, ...rest] = path
  if (head === '*') return Array.isArray(value) ? value.map((v) => mapPath(v, rest, fn)) : value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const obj = value as Record<string, unknown>
  if (!((head as string) in obj)) return value
  return { ...obj, [head as string]: mapPath(obj[head as string], rest, fn) }
}

/**
 * 返回脱敏后的载荷：先对全部字符串做名单替换（本账本的 extra 名单 + core 中注册的名单），
 * 再对该事件类型的自由文本字段做正则兜底。
 */
export function scrubPayload(
  type: string,
  payload: unknown,
  extra?: (text: string) => string,
): unknown {
  const known = (text: string) => redactKnownSecrets(extra ? extra(text) : text)
  let out = redactDeep(payload, known)
  const limits = FREE_TEXT_LIMITS[type as EventType] ?? {}
  for (const path of FREE_TEXT_FIELDS[type as EventType] ?? []) {
    const max = limits[path.join('.')]
    out = mapPath(
      out,
      path,
      // 策略命令先在协议上限内脱敏，再裁剪审计文本，避免 2000 字符边界切断 token。
      type === 'policy.decided'
        ? (s) => clipText(sanitizeText(s, PROTOCOL_MESSAGE_MAX), 2000)
        : max === undefined
          ? redactSecrets
          : (s) => clipText(redactSecrets(clipText(s, max)), max),
    )
  }
  return out
}
