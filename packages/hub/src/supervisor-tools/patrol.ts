import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  appendJournal,
  BRAIN_JOURNAL_DIR,
  clipText,
  fail,
  flowPaths,
  git,
  INBOX_BODY_MAX,
  INBOX_TITLE_MAX,
  type InboxItemView,
  localDate,
  ok,
  type PatrolReportData,
  type PatrolReportRequest,
  type Result,
  redactSecrets,
  SUPERVISOR_ACTOR,
} from '@flow/core'
import type { LedgerStore } from '../ledger/store.ts'
import type { WakeCaller } from '../server/wake-tokens.ts'
import type { SupervisorToolsDeps } from './common.ts'

/**
 * 巡检日报（add-m1-supervisor design D13；scheduler spec "每日巡检"；tasks 6.2）。
 *
 * 日报进入每日摘要需要一个确定性的通道：supervisor 调用 `patrol_report`，中枢
 * 1. 核对调用方是合并了巡检触发的非 reply 唤醒（`checkWakeCaller` 已排除 reply 唤醒），
 *    且本次唤醒尚未提交过日报；
 * 2. 正文先脱敏、转义行首标题标记，再以 supervisor 身份经写入层追加一条 journal（与 `kb_journal` 写的是
 *    同一份 journal；首行带唤醒 id，账本写入失败后重试不会重复追加）；
 * 3. 写一条 Digest 级、`source: supervisor` 的条目 `patrol.<唤醒任务 id>`（不推送），
 *    每日摘要生成时把它列入"supervisor 巡检日报"一节并以 `digested` 关闭。
 *
 * 不扩大权限：journal 本来就允许 supervisor 写；条目只是 Digest 级的展示，没有任何动作；
 * 每次巡检唤醒最多一份，受每日 autonomous 唤醒上限约束。
 */

/** 巡检日报条目 id：`patrol.<唤醒任务 id>`（每次唤醒一份）。 */
export const patrolItemId = (wakeTaskId: string) => `patrol.${wakeTaskId}`

/** 是否为巡检日报条目。 */
export const isPatrolItem = (i: Pick<InboxItemView, 'id' | 'source'>) =>
  i.source === 'supervisor' && i.id.startsWith('patrol.')

/** 唤醒合并的事件中是否有巡检触发（`schedule.fired{payload.kind: supervisor_patrol}`）。 */
export function isPatrolWake(
  ledger: Pick<LedgerStore, 'wakeOf' | 'eventsAfter'>,
  wakeTaskId: string,
) {
  const wake = ledger.wakeOf(wakeTaskId)
  if (!wake) return false
  return wake.events.some((seq) => {
    const e = ledger.eventsAfter(seq - 1, {}, 1)[0]
    return (
      e?.seq === seq &&
      e.type === 'schedule.fired' &&
      (e.payload.payload as { kind?: unknown } | undefined)?.kind === 'supervisor_patrol'
    )
  })
}

/** 正在处理的唤醒：同一唤醒并发提交时只放行一个（journal 写入是异步的）。 */
const inflight = new Set<string>()

/** journal 中这条日报的首行（带唤醒 id，用于重试去重）。 */
const patrolHeading = (wakeTaskId: string) => `巡检日报（唤醒 ${wakeTaskId}）`

/**
 * 日报正文经中枢写入前的处理：先脱敏（已登记的密钥值与正则兜底），再转义行首的 Markdown 标题标记，
 * 防止正文伪造 journal 记录的 `## <时间 · 身份>` 标题（行首 `#` 前加 `\`）。
 */
export function sanitizePatrolText(text: string): string {
  return redactSecrets(text).replace(/^([ \t]*)(#{1,6})(?=[ \t]|$)/gm, '$1\\$2')
}

/**
 * 重试去重：账本写入失败后再次提交时，journal 里可能已有本次唤醒的日报。
 * 只查今天与昨天的 journal（巡检唤醒不会跨更多天）；正文行首的 `#` 已转义，标题行无法伪造。
 */
async function existingJournal(
  home: string,
  wakeTaskId: string,
  now: Date,
): Promise<{ file: string; sha: string } | null> {
  const record = new RegExp(
    `^## [^\n]*\n\n${patrolHeading(wakeTaskId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
    'm',
  )
  for (const date of [localDate(now), localDate(new Date(now.getTime() - 24 * 3600_000))]) {
    const rel = `${BRAIN_JOURNAL_DIR}/${date}.md`
    let text: string
    try {
      text = await readFile(join(flowPaths(home).brain, rel), 'utf8')
    } catch {
      continue
    }
    if (!record.test(text)) continue
    const log = await git(flowPaths(home).brain, ['log', '-1', '--format=%H', '--', rel])
    return { file: `brain/${rel}`, sha: log.stdout.trim() }
  }
  return null
}

export async function reportPatrol(
  deps: SupervisorToolsDeps,
  wake: WakeCaller,
  input: PatrolReportRequest,
): Promise<Result<PatrolReportData>> {
  const { ledger } = deps
  if (!isPatrolWake(ledger, wake.task_id)) {
    return fail(
      'failure',
      'not_patrol_wake',
      'patrol_report 只限巡检唤醒（合并了 payload.kind: supervisor_patrol 的定时触发）；其他唤醒用 kb_journal 记录',
    )
  }
  const id = patrolItemId(wake.task_id)
  if (ledger.getInboxItem(id) || inflight.has(id)) {
    return fail('failure', 'patrol_already_reported', `本次巡检唤醒已经提交过日报（${id}）`)
  }
  inflight.add(id)
  try {
    const now = new Date(deps.now())
    const date = localDate(now)
    const text = sanitizePatrolText(input.text)
    let journal = await existingJournal(deps.home, wake.task_id, now)
    if (!journal) {
      const r = await appendJournal(
        deps.home,
        { text: `${patrolHeading(wake.task_id)}\n\n${text}`, workspace: input.workspace },
        { actor: SUPERVISOR_ACTOR, now },
      )
      if (!r.ok) return r
      journal = { file: r.data.file, sha: r.data.sha }
    }
    const r = ledger.append(
      {
        type: 'inbox.item_created',
        workspace: input.workspace,
        payload: {
          item_id: id,
          // 固定 Digest：日报只进每日摘要，不单独推送（不受 levels 配置调高）。
          level: 'digest',
          source: 'supervisor',
          source_ref: wake.task_id,
          title: clipText(`[${input.workspace}] 巡检日报 ${date}`, INBOX_TITLE_MAX),
          body: clipText(text, INBOX_BODY_MAX),
        },
      },
      { actor: 'hub' },
    )
    if (!r.ok) return r
    const item = ledger.getInboxItem(id)
    if (!item) return fail('failure', 'internal_error', '巡检日报条目写入后不可见')
    return ok({ item, journal })
  } finally {
    inflight.delete(id)
  }
}
