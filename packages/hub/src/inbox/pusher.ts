import {
  clipText,
  INBOX_BODY_MAX,
  INBOX_TITLE_MAX,
  type InboxCadence,
  type InboxConfig,
  type InboxItemView,
  inboxCadence,
  resolveInboxLevel,
  type TaskView,
} from '@flow/core'
import type { EventInput, LedgerStore } from '../ledger/store.ts'
import type { Scheduler } from '../scheduler/index.ts'
import type { HubClock } from '../server/clock.ts'
import type { HubLogger } from '../server/maintenance.ts'
import {
  dailyCron,
  isQuiet,
  localDate,
  nextDeferredAt,
  quietEnd,
  startOfLocalDay,
} from './cadence.ts'

/**
 * 推送节奏的驱动（inbox spec "推送节奏"；add-m1-inbox 3.3、design D8）。
 *
 * - **静默顺延**：静默时段内生成的 Interrupt 条目写 `inbox.item_updated(deferred_until)`，
 *   到点由定时器唤醒推送；
 * - **定时唤醒**：用调度器的内部规则（id 以 `inbox:` 开头，不写进 schedules.yaml）在 Decide 时间点、
 *   静默时段结束、每日摘要时间唤醒，交给渠道管理器按 `planPushes` 推送；
 * - **每日摘要**：在摘要时间生成 `dig.<本地日期>` 条目（昨天完成和失败的任务、auto-report 记录、
 *   待处理的 Decide 条目数、可能过时的知识条目数），同时关闭上一份摘要（superseded）和已写进摘要的
 *   策略记录（digested）。条目 id 按日期确定，重复触发、重启补发都不会生成第二份；
 *   中枢停机期间错过的摘要时间，由调度器在内部规则首次设置时补发最近一次（同 schedules.yaml）；
 * - 账本中有新的收件箱事件时，也做一次（微任务里，避免在账本通知循环中同步写入）。
 */

export interface InboxPusherOptions {
  ledger: LedgerStore
  clock: HubClock
  config: () => InboxConfig
  /** 内部定时规则；缺省只靠账本事件与顺延定时器唤醒（测试可直接调用 `fireDigest` 等）。 */
  scheduler?: Pick<Scheduler, 'setInternalRules'>
  /** 渠道管理器的 flush；没有渠道时可省略。 */
  flush?: () => Promise<void>
  /**
   * 可能过时的知识条目数量。
   * TODO(add-m1-inbox)：core 还没有判断知识条目过时的函数，接入前返回 0。
   */
  staleKnowledge?: () => number | Promise<number>
  logger?: Pick<HubLogger, 'warn'>
  actor?: string
}

export interface InboxPusher {
  start(): Promise<void>
  /** 顺延静默时段内的 Interrupt，然后让渠道推送到期的条目。 */
  tick(): Promise<void>
  /** 生成当天的每日摘要（已存在则不动），然后推送。 */
  fireDigest(at?: number): Promise<void>
  /** 配置变化后重新设置内部定时规则。 */
  reconfigure(): void
  stop(): void
}

export const digestItemId = (date: string) => `dig.${date}`

const SHOW_MAX = 10

function taskLine(t: TaskView): string {
  return `- [${t.workspace}] ${t.contract.goal.split('\n')[0] ?? ''}（${t.id}）`
}

function listLines<T>(items: readonly T[], line: (x: T) => string): string[] {
  const shown = items.slice(0, SHOW_MAX).map(line)
  if (items.length > SHOW_MAX) shown.push(`- ……另有 ${items.length - SHOW_MAX} 项`)
  return shown
}

export function createInboxPusher(o: InboxPusherOptions): InboxPusher {
  const { ledger, clock } = o
  const actor = o.actor ?? 'hub'
  const cadence = (): InboxCadence => inboxCadence(o.config())
  let stopped = false
  let unsubscribe: (() => void) | undefined
  let scheduled = false
  let cancelDeferred: (() => void) | undefined
  let deferredAt: number | null = null
  let lastRules = ''

  const warnWrite = (what: string, r: ReturnType<LedgerStore['appendMany']>) => {
    if (!r.ok && r.error.code !== 'duplicate_item' && r.error.code !== 'item_closed') {
      o.logger?.warn(what, r.error)
    }
  }

  /** 静默时段内生成、尚未推送也未顺延的 Interrupt：写 deferred_until。 */
  function deferQuiet(open: readonly InboxItemView[]) {
    const c = cadence()
    const now = clock.now()
    const end = quietEnd(now, c.quiet)
    if (end === null) return
    const drafts: EventInput[] = []
    for (const item of open) {
      if (item.level !== 'interrupt' || item.source === 'digest') continue
      if (item.deferred_until !== null || item.pushed_at !== null) continue
      if (!isQuiet(Date.parse(item.created_at), c.quiet)) continue
      drafts.push({
        type: 'inbox.item_updated',
        ...(item.task_id ? { task_id: item.task_id } : {}),
        ...(item.workspace ? { workspace: item.workspace } : {}),
        payload: { item_id: item.id, deferred_until: new Date(end).toISOString() },
      })
    }
    // 逐条写：某条刚被关闭（item_closed）不影响其他条目。
    for (const d of drafts) warnWrite('静默顺延写入失败', ledger.appendMany([d], { actor }))
  }

  /** 顺延的条目到点时唤醒（内部规则也会在静默结束时唤醒，这里兜住配置改过的情况）。 */
  function armDeferred(open: readonly InboxItemView[]) {
    const next = nextDeferredAt(open, clock.now())
    if (next === deferredAt) return
    cancelDeferred?.()
    cancelDeferred = undefined
    deferredAt = next
    if (next === null || stopped) return
    cancelDeferred = clock.setTimeout(
      () => {
        cancelDeferred = undefined
        deferredAt = null
        void tick()
      },
      Math.max(0, next - clock.now()),
    )
  }

  /** 顺延与唤醒是同步的账本操作；推送交给渠道管理器（各渠道自己串行，挂起的渠道不拖住这里）。 */
  function prepare() {
    if (stopped) return
    try {
      const open = ledger.listInboxItems({ state: 'open', limit: 10_000 })
      deferQuiet(open)
      armDeferred(ledger.listInboxItems({ state: 'open', level: 'interrupt', limit: 10_000 }))
    } catch (err) {
      o.logger?.warn('推送节奏处理失败', String(err))
    }
  }

  /** 返回的 Promise 在本次推送完成时兑现（测试用；正常路径不等待）。 */
  async function tick(): Promise<void> {
    prepare()
    if (stopped) return
    await o.flush?.()
  }

  async function buildDigest(now: number): Promise<EventInput[]> {
    const date = localDate(now)
    const id = digestItemId(date)
    if (ledger.getInboxItem(id)) return []
    const from = startOfLocalDay(now, -1)
    const to = startOfLocalDay(now)
    const yesterday = (t: TaskView) => {
      const at = t.finished_at === null ? Number.NaN : Date.parse(t.finished_at)
      return at >= from && at < to
    }
    const done = ledger.listTasks({ status: 'done', limit: 100_000 }).filter(yesterday)
    const failed = ledger.listTasks({ status: 'failed', limit: 100_000 }).filter(yesterday)
    const open = ledger.listInboxItems({ state: 'open', limit: 10_000 })
    const policy = open.filter((i) => i.source === 'policy')
    const quietTasks = open.filter((i) => i.source === 'task' && i.level === 'digest')
    const decide = open.filter((i) => i.level === 'decide').length
    let stale = 0
    try {
      stale = (await o.staleKnowledge?.()) ?? 0
    } catch (err) {
      o.logger?.warn('统计过时知识条目失败', String(err))
    }
    const day = localDate(from)
    const lines = [`昨天（${day}）完成 ${done.length} 个任务，失败 ${failed.length} 个。`]
    if (done.length > 0) lines.push('完成：', ...listLines(done, taskLine))
    if (failed.length > 0) lines.push('失败：', ...listLines(failed, taskLine))
    lines.push(`策略自动放行记录 ${policy.length} 条。`)
    if (policy.length > 0) lines.push(...listLines(policy, (i) => `- ${i.title}`))
    if (quietTasks.length > 0) {
      lines.push(`只进摘要的卡住任务 ${quietTasks.length} 个：`)
      lines.push(...listLines(quietTasks, (i) => `- ${i.title}`))
    }
    lines.push(`待处理的 Decide 条目 ${decide} 个。`)
    lines.push(`可能过时的知识条目 ${stale} 个。`)
    const drafts: EventInput[] = []
    for (const prev of open.filter((i) => i.source === 'digest')) {
      drafts.push({
        type: 'inbox.item_closed',
        payload: { item_id: prev.id, reason: 'superseded' },
      })
    }
    drafts.push({
      type: 'inbox.item_created',
      payload: {
        item_id: id,
        level: resolveInboxLevel(o.config(), { source: 'digest' }),
        source: 'digest',
        source_ref: date,
        title: clipText(`每日摘要 ${date}`, INBOX_TITLE_MAX),
        body: clipText(lines.join('\n'), INBOX_BODY_MAX),
      },
    })
    for (const p of policy) {
      drafts.push({
        type: 'inbox.item_closed',
        ...(p.task_id ? { task_id: p.task_id } : {}),
        ...(p.workspace ? { workspace: p.workspace } : {}),
        payload: { item_id: p.id, reason: 'digested', note: `已写入每日摘要 ${date}` },
      })
    }
    return drafts
  }

  async function fireDigest(at = clock.now()) {
    if (stopped) return
    try {
      const drafts = await buildDigest(at)
      if (drafts.length > 0) warnWrite('每日摘要写入失败', ledger.appendMany(drafts, { actor }))
    } catch (err) {
      o.logger?.warn('生成每日摘要失败', String(err))
    }
    await tick()
  }

  function reconfigure() {
    if (!o.scheduler || stopped) return
    const c = cadence()
    const rules = [
      ...c.decide_times.map((t) => ({
        id: `inbox:decide-${t.replace(':', '')}`,
        cron: dailyCron(t),
        onFire: () => tick(),
      })),
      ...(c.quiet
        ? [{ id: 'inbox:quiet-end', cron: dailyCron(c.quiet.end), onFire: () => tick() }]
        : []),
      { id: 'inbox:digest', cron: dailyCron(c.digest_time), onFire: () => fireDigest() },
    ]
    const key = JSON.stringify(rules.map((r) => [r.id, r.cron]))
    if (key === lastRules) return
    const r = o.scheduler.setInternalRules('inbox:', rules)
    if (r.ok) lastRules = key
    else o.logger?.warn('收件箱定时规则设置失败', r.error)
  }

  return {
    async start() {
      if (unsubscribe || stopped) return
      unsubscribe = ledger.subscribe((e) => {
        if (stopped || !e.type.startsWith('inbox.') || e.type === 'inbox.pushed') return
        if (scheduled) return
        scheduled = true
        queueMicrotask(() => {
          scheduled = false
          void tick()
        })
      })
      // 停机期间错过的摘要时间由调度器补发（内部规则首次设置时按上次停机前的位置补发最近一次）。
      reconfigure()
      // 不等待推送：渠道挂起不能拖住中枢启动。
      void tick()
    },
    tick,
    fireDigest,
    reconfigure,
    stop() {
      stopped = true
      unsubscribe?.()
      unsubscribe = undefined
      cancelDeferred?.()
      cancelDeferred = undefined
      o.scheduler?.setInternalRules('inbox:', [])
    },
  }
}
