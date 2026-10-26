import { formatUsd, roundUsd } from '@flow/core'
import type { LedgerStore } from '../ledger/store.ts'

/**
 * supervisor 花费汇总（add-m1-supervisor design D13 "费用"；tasks 6.2）。
 *
 * **按唤醒结束时间**归入时段：查询时间范围内的终态事件（`task.done` / `task.failed` / `task.cancelled`），
 * 只取唤醒任务（以 `supervisor.wake_started` 为准，含 reply 唤醒）。每个任务恰好有一个终态事件，所以每个
 * 唤醒恰好计入一份摘要（按开始时间归日会漏掉"昨天开始、在摘要生成之后才结束"的唤醒）。费用在会话结束时
 * 才由执行器上报（`result.cost.usd`，claude-sdk 的估算值，不是账单）。唤醒派生的 dev、审查等任务不计入；
 * 未结束的唤醒不计入。没有上报 `cost.usd` 的唤醒（例如被取消、执行器没给出）只计次数，另记 `unreported`。
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
  /** 唤醒结束时间（终态事件的 ts）的范围 [from, to)（毫秒）。 */
  from: number
  to: number
  /** 范围内再按结束时间筛选（例如调度器的 dayKey 判断"今天"）。 */
  include?: (endedMs: number) => boolean
}

const BATCH = 1000
const TERMINAL_EVENTS = ['task.done', 'task.failed', 'task.cancelled'] as const

/** 范围内结束的唤醒按 workspace 汇总；只给 workspace 时只统计该 workspace。 */
export function wakeCosts(
  ledger: Pick<LedgerStore, 'eventsBetween' | 'getTask' | 'wakeOf'>,
  range: WakeCostRange,
  workspace?: string,
): WakeCostSummary[] {
  const by = new Map<string, WakeCostSummary>()
  const counted = new Set<string>()
  const from = new Date(range.from).toISOString()
  const to = new Date(range.to).toISOString()
  for (const type of TERMINAL_EVENTS) {
    // 分批读取，不设总量上限；游标为 seq（同一时间戳的事件不会跨批重复或遗漏）。
    let after = 0
    for (;;) {
      const batch = ledger.eventsBetween(type, from, to, BATCH, after)
      for (const e of batch) {
        const id = e.task_id
        if (id === undefined || counted.has(id)) continue
        const wake = ledger.wakeOf(id)
        if (!wake) continue
        if (workspace !== undefined && wake.workspace !== workspace) continue
        if (range.include && !range.include(Date.parse(e.ts))) continue
        const t = ledger.getTask(id)
        if (!t) continue
        counted.add(id)
        const s = by.get(wake.workspace) ?? {
          workspace: wake.workspace,
          wakes: 0,
          reply: 0,
          usd: 0,
          unreported: 0,
        }
        s.wakes++
        if (wake.origin === 'reply') s.reply++
        const usd = t.result?.cost?.usd
        if (usd === undefined) s.unreported++
        else s.usd = roundUsd(s.usd + usd)
        by.set(wake.workspace, s)
      }
      const last = batch.at(-1)
      if (batch.length < BATCH || !last) break
      after = last.seq
    }
  }
  return [...by.values()].sort((a, b) => a.workspace.localeCompare(b.workspace))
}

/** 一行汇总，例如 `- [ws/a] 3 次唤醒（代回复 1） $1.23（1 次未上报费用）`。 */
export function costLine(s: WakeCostSummary): string {
  const reply = s.reply > 0 ? `（代回复 ${s.reply}）` : ''
  const missing = s.unreported > 0 ? `（${s.unreported} 次未上报费用）` : ''
  return `- [${s.workspace}] ${s.wakes} 次唤醒${reply} ${formatUsd(s.usd)}${missing}`
}
