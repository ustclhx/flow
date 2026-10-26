import type { TaskView } from '@flow/core'
import type { LedgerStore } from '../ledger/store.ts'

/**
 * supervisor 花费汇总（add-m1-supervisor design D13 "费用"；tasks 6.2）。
 *
 * 只统计**唤醒任务本身**（`supervisor.wake_started` 登记的任务，含 reply 唤醒），按结束时间（`finished_at`）
 * 落在统计时段内归入该时段：费用在会话结束时才由执行器上报（`result.cost.usd`，claude-sdk 的估算值，
 * 不是账单）。唤醒派生的 dev、审查等任务不计入；未结束的唤醒也不计入。
 * 没有上报 `cost.usd` 的唤醒（例如被取消、执行器没给出）只计次数，另记 `unreported`。
 */
export interface WakeCostSummary {
  workspace: string
  /** 结束的唤醒次数（含 reply）。 */
  wakes: number
  /** 其中 reply 唤醒次数。 */
  reply: number
  /** 已上报费用之和（美元，估算）。 */
  usd: number
  /** 没有上报 `cost.usd` 的唤醒次数。 */
  unreported: number
}

const FINISHED = ['done', 'failed', 'cancelled'] as const

/**
 * 结束时间满足 `inRange`（毫秒）的唤醒按 workspace 汇总；只给 workspace 时只统计该 workspace。
 * 摘要传 [昨天零点, 今天零点)，`flow supervisor status` 传"与现在同一天"（调度器的 dayKey）。
 */
export function wakeCosts(
  ledger: Pick<LedgerStore, 'listTasks' | 'wakeOf'>,
  inRange: (finishedAtMs: number) => boolean,
  workspace?: string,
): WakeCostSummary[] {
  const by = new Map<string, WakeCostSummary>()
  for (const status of FINISHED) {
    const tasks: TaskView[] = ledger.listTasks({
      status,
      limit: 100_000,
      ...(workspace === undefined ? {} : { workspace }),
    })
    for (const t of tasks) {
      const at = t.finished_at === null ? Number.NaN : Date.parse(t.finished_at)
      if (Number.isNaN(at) || !inRange(at)) continue
      const wake = ledger.wakeOf(t.id)
      if (!wake) continue
      const s = by.get(t.workspace) ?? {
        workspace: t.workspace,
        wakes: 0,
        reply: 0,
        usd: 0,
        unreported: 0,
      }
      s.wakes++
      if (wake.origin === 'reply') s.reply++
      const usd = t.result?.cost?.usd
      if (usd === undefined) s.unreported++
      else s.usd += usd
      by.set(t.workspace, s)
    }
  }
  return [...by.values()].sort((a, b) => a.workspace.localeCompare(b.workspace))
}

/** 美元金额的展示（两位小数，不足 0.01 时三位）。 */
export function formatUsd(usd: number): string {
  return usd > 0 && usd < 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`
}

/** 一行汇总，例如 `[ws/a] 3 次唤醒（代回复 1）$1.23（1 次未上报费用）`。 */
export function costLine(s: WakeCostSummary): string {
  const reply = s.reply > 0 ? `（代回复 ${s.reply}）` : ''
  const missing = s.unreported > 0 ? `（${s.unreported} 次未上报费用）` : ''
  return `- [${s.workspace}] ${s.wakes} 次唤醒${reply} ${formatUsd(s.usd)}${missing}`
}
