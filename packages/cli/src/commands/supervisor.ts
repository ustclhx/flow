import {
  fail,
  formatUsd,
  HubClient,
  resolveRaindownHome,
  SUPERVISOR_QUEUES,
  type SupervisorReportData,
  type SupervisorStatusData,
  type SupervisorWakeData,
  TASK_STAGE_LABELS,
  type WakeSummary,
} from '@raindown/core'
import { defineCommand } from '../command.ts'

/**
 * supervisor 唤醒的用户命令（add-m1-supervisor D3；tasks 3.4）。不属于知识访问，所以在这里单独定义；
 * 全部经中枢的 user-only 路由，AI 身份调用返回 `user_only`。
 */

/** `product-res` 与 `ws/product-res` 都接受。 */
const wsRef = (s: string) => (s.startsWith('ws/') ? s : `ws/${s}`)

const usage = (message: string) => fail('usage', 'invalid_arguments', message)

const wakeLine = (w: WakeSummary) =>
  `${w.task_id}（${w.origin}，第 ${w.generation} 代，${w.events} 个事件，${w.status}${w.stage ? `，${TASK_STAGE_LABELS[w.stage]}` : ''}）`

const humanWake = (d: SupervisorWakeData) =>
  d.state === 'started' && d.wake ? `已唤醒 supervisor：${wakeLine(d.wake)}` : d.message

/** `raindown ask <ws> <说明>`：下达指令（写 `user.instruction`，via cli），输出唤醒任务 id 或排队说明。 */
export const askCommand = defineCommand<SupervisorWakeData>({
  name: 'ask',
  usage: 'ask <workspace> <说明>',
  summary: '给 supervisor 下指令：输出唤醒任务 id 或"已排队"（仅 user）',
  run: async ({ args, actor }) => {
    const [ws, ...rest] = args
    const text = rest.join(' ').trim()
    if (!ws || !text) return usage('用法：raindown ask <workspace> <说明>')
    const home = resolveRaindownHome(process.env)
    return new HubClient({ home, actor }).supervisorWake({ workspace: wsRef(ws), text, via: 'cli' })
  },
  human: humanWake,
})

/** `raindown supervisor wake <ws> [<说明>] [--release <instruction|autonomous>]`。 */
export const supervisorWakeCommand = defineCommand<SupervisorWakeData>({
  name: 'supervisor wake',
  usage: 'supervisor wake <workspace> [<说明>] [--release <instruction|autonomous>]',
  summary: '手动唤醒 supervisor，或放行一条暂停 / 达到上限的队列（仅 user）',
  options: {
    release: {
      type: 'string',
      description:
        '放行队列 instruction 或 autonomous：立刻用该队列现有事件唤醒一次，不计入每日上限',
    },
  },
  run: async ({ args, options, actor }) => {
    const [ws, ...rest] = args
    if (!ws) return usage('用法：raindown supervisor wake <workspace> [<说明>] [--release <queue>]')
    const text = rest.join(' ').trim()
    const release = options.release
    if (release !== undefined) {
      if (
        typeof release !== 'string' ||
        !(SUPERVISOR_QUEUES as readonly string[]).includes(release)
      ) {
        return usage(`--release 只能是 ${SUPERVISOR_QUEUES.join(' 或 ')}`)
      }
      if (text) return usage('--release 不能与说明同时给出')
    }
    const home = resolveRaindownHome(process.env)
    return new HubClient({ home, actor }).supervisorWake({
      workspace: wsRef(ws),
      ...(text ? { text } : {}),
      ...(release === undefined ? {} : { release: release as (typeof SUPERVISOR_QUEUES)[number] }),
      via: 'cli',
    })
  },
  human: humanWake,
})

/** `raindown supervisor status [<ws>]`：当前唤醒、各队列长度、今日唤醒次数与最近一次结果。 */
export const supervisorStatusCommand = defineCommand<SupervisorStatusData>({
  name: 'supervisor status',
  usage: 'supervisor status [<workspace>]',
  summary: '查看 supervisor 的当前唤醒、队列、今日次数与最近一次结果（仅 user）',
  run: async ({ args, actor }) => {
    const home = resolveRaindownHome(process.env)
    const ws = args[0]
    return new HubClient({ home, actor }).supervisorStatus(ws ? { workspace: wsRef(ws) } : {})
  },
  human: ({ workspaces }) => {
    if (workspaces.length === 0) return '没有 workspace'
    return workspaces
      .map((w) => {
        const lines = [`${w.workspace}：${w.enabled ? '已启用' : `未启用（${w.reason ?? ''}）`}`]
        lines.push(`  当前唤醒：${w.current ? wakeLine(w.current) : '无'}`)
        if (w.reply) lines.push(`  代回复唤醒：${wakeLine(w.reply)}`)
        lines.push(
          `  队列：instruction ${w.queues.instruction}，autonomous ${w.queues.autonomous}，reply ${w.queues.reply}`,
        )
        for (const q of SUPERVISOR_QUEUES) {
          const p = w.paused[q]
          if (p) {
            lines.push(
              `  ${q} 队列暂停（连续失败 ${p.failures} 次），${new Date(p.until).toLocaleString()} 自动恢复`,
            )
          }
        }
        if (w.release_pending.length)
          lines.push(`  已放行、等待处理：${w.release_pending.join('、')}`)
        const t = w.today
        lines.push(
          `  今日（${t.date}）：普通唤醒 ${t.wakes}/${t.wakes_per_day}，其中 autonomous ${t.autonomous}/${t.autonomous_wakes_per_day}，代回复 ${t.reply}/${t.reply_wakes_per_day}`,
        )
        if (t.cost_usd !== undefined) {
          const missing = t.cost_unreported ? `，${t.cost_unreported} 次未上报` : ''
          lines.push(
            `  今日花费（估算）：${formatUsd(t.cost_usd)}（已结束的唤醒 ${t.cost_wakes ?? 0} 次，含代回复${missing}）`,
          )
        }
        lines.push(`  最近一次：${w.last ? wakeLine(w.last) : '无'}`)
        return lines.join('\n')
      })
      .join('\n\n')
  },
})

/** 日期（YYYY-MM-DD，按本地时区的 0 点）或 ISO 时间 → UTC ISO 时间；不合法时返回 null。 */
export function parseReportTime(value: string): string | null {
  const v = value.trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  const ms = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : Date.parse(v)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

const pct = (r: number | null) => (r === null ? '—' : `${(r * 100).toFixed(1)}%`)

/** 简单的定宽表格（中文按 2 列宽计）。 */
function table(head: string[], rows: string[][]): string {
  const width = (s: string) => [...s].reduce((n, ch) => n + (/[\u2e80-\uffff]/.test(ch) ? 2 : 1), 0)
  const cols = head.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i] ?? ''))))
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c + ' '.repeat((cols[i] ?? 0) - width(c)))
      .join('  ')
      .trimEnd()
  return [line(head), line(cols.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n')
}

/** `raindown supervisor report [<ws>] [--since] [--until] [--days]`（D10，tasks 7.4）。 */
export const supervisorReportCommand = defineCommand<SupervisorReportData>({
  name: 'supervisor report',
  usage:
    'supervisor report [<workspace>] [--since <日期>] [--until <日期>] [--days <天数>] [--json]',
  summary:
    'observe 判断与用户回复的一致率、卡住 basis 比例与 observe 下未执行的自主动作（仅 user）',
  options: {
    since: { type: 'string', description: '统计起点（含）：YYYY-MM-DD 或 ISO 时间；缺省为 7 天前' },
    until: { type: 'string', description: '统计终点（不含）：YYYY-MM-DD 或 ISO 时间；缺省为现在' },
    days: { type: 'string', description: '统计最近 N 天（与 --since 二选一）' },
  },
  run: async ({ args, options, actor }) => {
    const input: { workspace?: string; since?: string; until?: string } = {}
    if (args[0]) input.workspace = wsRef(args[0])
    for (const key of ['since', 'until'] as const) {
      const raw = options[key]
      if (raw === undefined) continue
      const t = typeof raw === 'string' ? parseReportTime(raw) : null
      if (!t) return usage(`--${key} 应为 YYYY-MM-DD 或 ISO 时间`)
      input[key] = t
    }
    if (options.days !== undefined) {
      if (input.since) return usage('--days 不能与 --since 同时给出')
      const days = Number(options.days)
      if (!Number.isInteger(days) || days < 1 || days > 3650) {
        return usage('--days 应为 1–3650 的整数')
      }
      const end = input.until ? Date.parse(input.until) : Date.now()
      input.since = new Date(end - days * 24 * 60 * 60 * 1000).toISOString()
    }
    const home = resolveRaindownHome(process.env)
    return new HubClient({ home, actor }).supervisorReport(input)
  },
  human: (d) => {
    const range = `${new Date(d.since).toLocaleString()} — ${new Date(d.until).toLocaleString()}`
    if (d.workspaces.length === 0) return `统计范围：${range}\n没有记录`
    const out = [`统计范围：${range}`]
    for (const w of d.workspaces) {
      const s = w.observed_replies
      out.push(
        '',
        `${w.workspace}`,
        '',
        'observe 判断与用户实际回复',
        table(
          ['类别', '判断', '已回复', '可判定', '一致', '一致率'],
          [
            [
              '代批',
              String(s.awaiting_approval),
              '',
              String(s.approvals.judged),
              String(s.approvals.agreed),
              pct(s.approvals.judged ? s.approvals.agreed / s.approvals.judged : null),
            ],
            [
              '代答',
              String(s.question),
              '',
              String(s.choices.judged),
              String(s.choices.agreed),
              pct(s.choices.judged ? s.choices.agreed / s.choices.judged : null),
            ],
            [
              '合计',
              String(s.total),
              String(s.replied),
              String(s.judged),
              String(s.agreed),
              pct(s.agreement),
            ],
          ],
        ),
        `  supervisor 也会转交 ${s.escalate}，用户尚未回复 ${s.pending}，自由文本回答（只计已回复）${s.free_text}`,
        '',
        '卡住记录的 basis（按执行器）',
        w.stuck_basis.length
          ? table(
              ['执行器', 'reported', 'inferred', '未标注', 'reported 比例'],
              w.stuck_basis.map((b) => [
                b.executor,
                String(b.reported),
                String(b.inferred),
                String(b.unspecified),
                pct(b.reported_ratio),
              ]),
            )
          : '  没有卡住记录',
        '',
        `observe 下未执行的自主动作：${w.observed_actions.total}（task_create ${w.observed_actions.task_create}，task_propose ${w.observed_actions.task_propose}，pr_merge_request ${w.observed_actions.pr_merge_request}）`,
      )
    }
    return out.join('\n')
  },
})

export const supervisorCommands = [
  askCommand,
  supervisorWakeCommand,
  supervisorStatusCommand,
  supervisorReportCommand,
]
