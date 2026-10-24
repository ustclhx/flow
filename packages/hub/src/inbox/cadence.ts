import type { InboxCadence, InboxItemView } from '@flow/core'

/**
 * 推送节奏的纯函数（inbox spec "推送节奏"；add-m1-inbox 3.3）。时间都按系统本地时区。
 *
 * 判断"现在该推什么"不依赖内存状态，只看条目投影与当前时间，所以重启、渠道恢复后都能补推：
 * - **静默时段内什么都不推**（Interrupt、Decide 合并消息、每日摘要都顺延到时段结束），
 *   包括渠道在凌晨恢复、机器在凌晨醒来补发的情况；
 * - **Interrupt**：立即推送；有 `deferred_until` 时到点才推送；
 * - **每日摘要条目**（来源 digest）：生成后推送，同样遵守 `deferred_until`；
 * - **Decide**：最近一个 Decide 时间点之前生成、还没推送到该渠道的条目，合并成一条消息推送；
 *   未推送的 Decide 条目达到阈值时提前推送；
 * - 其他 Digest 级条目（策略记录、调低到 Digest 的卡住任务）不单独推送，只进每日摘要。
 */

/** `HH:MM` → 当天的分钟数。 */
export function clockMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

/** 本地日期 base 加 dayOffset 天后的 HH:MM 时刻（毫秒）。 */
export function localAt(base: number, hhmm: string, dayOffset = 0): number {
  const d = new Date(base)
  const minutes = clockMinutes(hhmm)
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + dayOffset,
    Math.floor(minutes / 60),
    minutes % 60,
  ).getTime()
}

/** 本地日期的零点（毫秒）。 */
export const startOfLocalDay = (t: number, dayOffset = 0) => localAt(t, '00:00', dayOffset)

/** 本地日期 `YYYY-MM-DD`。 */
export function localDate(t: number): string {
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** `HH:MM` → 每天该时刻触发的 cron 表达式（本地时区）。 */
export function dailyCron(hhmm: string): string {
  const minutes = clockMinutes(hhmm)
  return `${minutes % 60} ${Math.floor(minutes / 60)} * * *`
}

const minuteOfDay = (t: number) => {
  const d = new Date(t)
  return d.getHours() * 60 + d.getMinutes()
}

/** t 是否在静默时段内（start 含、end 不含；start 晚于 end 时跨越午夜）。 */
export function isQuiet(t: number, quiet: InboxCadence['quiet']): boolean {
  if (!quiet) return false
  const m = minuteOfDay(t)
  const start = clockMinutes(quiet.start)
  const end = clockMinutes(quiet.end)
  return start < end ? m >= start && m < end : m >= start || m < end
}

/** t 所在静默时段的结束时刻（毫秒）；t 不在静默时段时返回 null。 */
export function quietEnd(t: number, quiet: InboxCadence['quiet']): number | null {
  if (!quiet || !isQuiet(t, quiet)) return null
  const today = localAt(t, quiet.end)
  return today > t ? today : localAt(t, quiet.end, 1)
}

/** 不晚于 t 的最近一个时间点（今天或昨天）；没有配置时间点时返回 null。 */
export function lastTimePoint(t: number, times: readonly string[]): number | null {
  let best: number | null = null
  for (const hhmm of times) {
    for (const offset of [0, -1]) {
      const at = localAt(t, hhmm, offset)
      if (at <= t && (best === null || at > best)) best = at
    }
  }
  return best
}

/** 一次推送：单个条目，或合并的 Decide 条目。 */
export interface PlannedPush {
  kind: 'item' | 'batch'
  items: InboxItemView[]
}

/** 一条合并消息最多放多少个 Decide 条目，更多时拆成几条。 */
export const BATCH_MAX = 20

const onChannel = (item: InboxItemView, channel: string) =>
  item.channels.some((c) => c.channel === channel)

/** 单独推送的条目（Interrupt、每日摘要）现在是否该推送。 */
export function interruptDue(item: InboxItemView, now: number, cadence: InboxCadence): boolean {
  if (isQuiet(now, cadence.quiet)) return false
  return item.deferred_until === null || Date.parse(item.deferred_until) <= now
}

/**
 * 某个渠道现在要推送的消息（按 Interrupt、每日摘要、Decide 的顺序）。
 * `open` 是全部未关闭的条目；已推送到该渠道的条目不会再推送。
 */
export function planPushes(
  open: readonly InboxItemView[],
  channel: string,
  now: number,
  cadence: InboxCadence,
): PlannedPush[] {
  if (isQuiet(now, cadence.quiet)) return []
  const pending = open.filter((i) => i.state === 'open' && !onChannel(i, channel))
  const byCreated = (a: InboxItemView, b: InboxItemView) =>
    a.created_at.localeCompare(b.created_at) ||
    Number.parseInt(a.short_id, 36) - Number.parseInt(b.short_id, 36)
  const out: PlannedPush[] = []
  for (const item of pending.filter((i) => i.level === 'interrupt').sort(byCreated)) {
    if (interruptDue(item, now, cadence)) out.push({ kind: 'item', items: [item] })
  }
  for (const item of pending.filter((i) => i.source === 'digest').sort(byCreated)) {
    if (interruptDue(item, now, cadence)) out.push({ kind: 'item', items: [item] })
  }
  const decide = pending
    .filter((i) => i.level === 'decide' && i.source !== 'digest')
    .sort(byCreated)
  if (decide.length > 0) {
    const point = lastTimePoint(now, cadence.decide_times)
    const scheduled = point !== null && decide.some((i) => Date.parse(i.created_at) < point)
    const early = decide.length >= cadence.decide_threshold
    if (scheduled || early) {
      for (let i = 0; i < decide.length; i += BATCH_MAX) {
        out.push({ kind: 'batch', items: decide.slice(i, i + BATCH_MAX) })
      }
    }
  }
  return out
}

/** 下一次需要醒来检查的时刻（顺延的 Interrupt 或摘要到点）；没有时返回 null。 */
export function nextDeferredAt(open: readonly InboxItemView[], now: number): number | null {
  let next: number | null = null
  for (const item of open) {
    if (item.state !== 'open' || item.deferred_until === null) continue
    const at = Date.parse(item.deferred_until)
    if (at > now && (next === null || at < next)) next = at
  }
  return next
}
