import { formatUsd, roundUsd } from '@flow/core'
import type { LedgerStore } from '../ledger/store.ts'

/**
 * supervisor 花费汇总（add-m1-supervisor design D13 "费用"；tasks 6.2）。
 *
 * 按时间范围查询 `supervisor.wake_started`（含 reply 唤醒），**按唤醒开始时间**归入时段，只统计其中已结束的
 * 唤醒任务：费用在会话结束时才由执行器上报（`result.cost.usd`，claude-sdk 的估算值，不是账单）。
 * 唤醒派生的 dev、审查等任务不计入；未结束的唤醒不计入。没有上报 `cost.usd` 的唤醒（例如被取消、
 * 执行器没给出）只计次数，另记 `unreported`。
 */
export interface WakeCostSummary {
  workspace: string
  /** 已结束的唤醒次数（含 reply）。 */
  wakes: number
  /** 其中 reply 唤醒次数。 */
  reply: number
  /** 已上报费用之和（美元，估算，6 位小数）。 */
  usd: number
  /** 没有上报 `cost.usd` 的唤醒次数。 */
  unreported: number
}

export interface WakeCostRange {
  /** 唤醒开始时间的范围 [from, to)（毫秒）。 */
  from: number
  to: number
  /** 范围内再按开始时间筛选（例如调度器的 dayKey 判断"今天"）。 */
  include?: (startedMs: number) => boolean
}

const BATCH = 1000

/** 范围内开始的唤醒按 workspace 汇总；只给 workspace 时只统计该 workspace。 */
export function wakeCosts(
  ledger: Pick<LedgerStore, 'eventsBetween' | 'getTask'>,
  range: WakeCostRange,
  workspace?: string,
): WakeCostSummary[] {
  const by = new Map<string, WakeCostSummary>()
  const seen = new Set<number>()
  const to = new Date(range.to).toISOString()
  let cursor = new Date(range.from).toISOString()
  // 分批读取，不设总量上限：同一时间戳的事件可能跨批，按 seq 去重。
  for (;;) {
    const batch = ledger.eventsBetween('supervisor.wake_started', cursor, to, BATCH)
    let fresh = 0
    for (const e of batch) {
      if (seen.has(e.seq)) continue
      seen.add(e.seq)
      fresh++
      if (e.type !== 'supervisor.wake_started') continue
      if (workspace !== undefined && e.payload.workspace !== workspace) continue
      if (range.include && !range.include(Date.parse(e.ts))) continue
      const t = ledger.getTask(e.payload.task_id)
      if (!t || !['done', 'failed', 'cancelled'].includes(t.status)) continue
      const s = by.get(t.workspace) ?? {
        workspace: t.workspace,
        wakes: 0,
        reply: 0,
        usd: 0,
        unreported: 0,
      }
      s.wakes++
      if (e.payload.origin === 'reply') s.reply++
      const usd = t.result?.cost?.usd
      if (usd === undefined) s.unreported++
      else s.usd = roundUsd(s.usd + usd)
      by.set(t.workspace, s)
    }
    const last = batch.at(-1)
    if (batch.length < BATCH || !last || fresh === 0) break
    cursor = last.ts
  }
  return [...by.values()].sort((a, b) => a.workspace.localeCompare(b.workspace))
}

/** 一行汇总，例如 `- [ws/a] 3 次唤醒（代回复 1） $1.23（1 次未上报费用）`。 */
export function costLine(s: WakeCostSummary): string {
  const reply = s.reply > 0 ? `（代回复 ${s.reply}）` : ''
  const missing = s.unreported > 0 ? `（${s.unreported} 次未上报费用）` : ''
  return `- [${s.workspace}] ${s.wakes} 次唤醒${reply} ${formatUsd(s.usd)}${missing}`
}
