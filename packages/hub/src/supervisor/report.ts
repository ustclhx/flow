import type {
  EventOf,
  LedgerEvent,
  SupervisorReportData,
  SupervisorReportWorkspace,
} from '@raindown/core'
import type { LedgerStore } from '../ledger/store.ts'

/**
 * `raindown supervisor report`（add-harness-neutral-coordination D10，tasks 7.4）的统计，全部取自账本：
 *
 * - **observe 判断与用户实际回复的一致率**：每条 `task.reply_observed` 关联到同一任务、同一次卡住上
 *   用户随后的 `task.replied`（判断之后、下一次 `task.blocked` 之前，actor user）。
 *   - 代批：批准 / 拒绝一致即为一致；
 *   - 代答：卡住带结构化选项、且双方的文字都恰好是某个选项（不区分大小写、去掉首尾空白）时比较是否同一选项；
 *     自由文本回答只统计"已回复"，不判一致；
 *   - supervisor 自己也会转交（escalate）的判断单独计数，不参与一致率。
 * - **卡住的 basis**：时间范围内的 `task.blocked`，按任务执行器分组统计 reported / inferred / 未标注。
 * - **observe 下未执行的自主动作**：`supervisor.observed_action` 的数量与类型。
 */

const PAGE = 1000
const DAY_MS = 24 * 60 * 60 * 1000

export interface ReportInput {
  workspace?: string | undefined
  since?: string | undefined
  until?: string | undefined
}

/** 某类型在 [since, until) 内的全部事件（分页读取）。 */
function* eventsIn(
  ledger: Pick<LedgerStore, 'eventsBetween'>,
  type: Parameters<LedgerStore['eventsBetween']>[0],
  since: string,
  until: string,
): Generator<LedgerEvent> {
  let after = 0
  for (;;) {
    const page = ledger.eventsBetween(type, since, until, PAGE, after)
    yield* page
    if (page.length < PAGE) return
    after = page.at(-1)?.seq ?? after
  }
}

const norm = (s: string) => s.trim().toLowerCase()

/** 文字恰好是某个选项时返回该选项（规范化后的 label），否则 null。 */
function optionOf(text: string | undefined, options: readonly { label: string }[]): string | null {
  if (text === undefined) return null
  const t = norm(text)
  return options.find((o) => norm(o.label) === t) ? t : null
}

function emptyWorkspace(workspace: string): SupervisorReportWorkspace {
  return {
    workspace,
    observed_replies: {
      total: 0,
      question: 0,
      awaiting_approval: 0,
      escalate: 0,
      pending: 0,
      replied: 0,
      judged: 0,
      agreed: 0,
      agreement: null,
      approvals: { judged: 0, agreed: 0 },
      choices: { judged: 0, agreed: 0 },
      free_text: 0,
      config_unavailable: 0,
    },
    stuck_basis: [],
    observed_actions: { total: 0, task_create: 0, task_propose: 0, pr_merge_request: 0 },
  }
}

/** 与 observe 判断关联的用户回复：同一次卡住上判断之后、下一次卡住之前用户写的 `task.replied`。 */
function userReplyFor(
  events: readonly LedgerEvent[],
  observed: EventOf<'task.reply_observed'>,
): EventOf<'task.replied'> | null {
  for (const e of events) {
    if (e.seq <= observed.seq) continue
    if (e.type === 'task.blocked') return null
    if (e.type === 'task.replied' && e.actor === 'user') return e
  }
  return null
}

export function supervisorReport(
  ledger: Pick<LedgerStore, 'eventsBetween' | 'taskEvents' | 'getTask'>,
  input: ReportInput,
  nowMs: number,
): SupervisorReportData {
  // 账本的 ts 是 UTC ISO 字符串、按字符串比较：带时区偏移的输入先规范化。
  // 缺省终点为"现在"且包含此刻写入的事件（区间右端不含，所以加 1 毫秒）。
  const until = new Date(input.until ?? nowMs + 1).toISOString()
  const since = new Date(input.since ?? Date.parse(until) - 1 - 7 * DAY_MS).toISOString()
  const rows = new Map<string, SupervisorReportWorkspace>()
  const row = (ws: string | undefined) => {
    if (ws === undefined || (input.workspace !== undefined && ws !== input.workspace)) return null
    let r = rows.get(ws)
    if (!r) {
      r = emptyWorkspace(ws)
      rows.set(ws, r)
    }
    return r
  }
  if (input.workspace !== undefined) row(input.workspace)

  // observe 判断与用户回复
  for (const e of eventsIn(ledger, 'task.reply_observed', since, until)) {
    if (e.type !== 'task.reply_observed') continue
    const r = row(e.workspace)
    if (!r) continue
    const s = r.observed_replies
    const p = e.payload
    // 配置无法读取而未送达的判断不是 observe：单独计数，不计入一致率与各项。
    if (p.forced !== undefined) {
      s.config_unavailable++
      continue
    }
    s.total++
    s[p.kind]++
    if (p.decision === 'escalate') {
      s.escalate++
      continue
    }
    const events = ledger.taskEvents(p.task_id)
    const reply = userReplyFor(events, e)
    if (!reply) {
      s.pending++
      continue
    }
    s.replied++
    if (p.kind === 'awaiting_approval') {
      if (reply.payload.kind !== 'approve' && reply.payload.kind !== 'deny') {
        // 授权请求只接受批准 / 拒绝；其他回复按已回复、不判一致处理。
        continue
      }
      s.approvals.judged++
      if (reply.payload.kind === p.decision) s.approvals.agreed++
      continue
    }
    const blocked = events.find((x) => x.seq === p.block_seq)
    const options =
      blocked?.type === 'task.blocked' ? (blocked.payload.question?.options ?? []) : []
    const mine = optionOf(p.text, options)
    const theirs = optionOf(reply.payload.text, options)
    if (mine === null || theirs === null) {
      s.free_text++
      continue
    }
    s.choices.judged++
    if (mine === theirs) s.choices.agreed++
  }

  // 卡住的 basis（按执行器分组）
  const basis = new Map<string, Map<string, { reported: number; inferred: number; none: number }>>()
  for (const e of eventsIn(ledger, 'task.blocked', since, until)) {
    if (e.type !== 'task.blocked' || e.task_id === undefined) continue
    if (!row(e.workspace)) continue
    const executor = ledger.getTask(e.task_id)?.contract.executor ?? '（未知）'
    const ws = e.workspace as string
    const byExec = basis.get(ws) ?? new Map()
    basis.set(ws, byExec)
    const c = byExec.get(executor) ?? { reported: 0, inferred: 0, none: 0 }
    byExec.set(executor, c)
    if (e.payload.basis === 'reported') c.reported++
    else if (e.payload.basis === 'inferred') c.inferred++
    else c.none++
  }
  for (const [ws, byExec] of basis) {
    const r = row(ws)
    if (!r) continue
    r.stuck_basis = [...byExec.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([executor, c]) => {
        const total = c.reported + c.inferred + c.none
        return {
          executor,
          reported: c.reported,
          inferred: c.inferred,
          unspecified: c.none,
          reported_ratio: total === 0 ? null : c.reported / total,
        }
      })
  }

  // observe 下未执行的自主动作
  for (const e of eventsIn(ledger, 'supervisor.observed_action', since, until)) {
    if (e.type !== 'supervisor.observed_action') continue
    const r = row(e.workspace)
    if (!r) continue
    r.observed_actions.total++
    r.observed_actions[e.payload.action]++
  }

  for (const r of rows.values()) {
    const s = r.observed_replies
    s.judged = s.approvals.judged + s.choices.judged
    s.agreed = s.approvals.agreed + s.choices.agreed
    s.agreement = s.judged === 0 ? null : s.agreed / s.judged
  }
  return {
    since,
    until,
    workspaces: [...rows.values()].sort((a, b) => a.workspace.localeCompare(b.workspace)),
  }
}
