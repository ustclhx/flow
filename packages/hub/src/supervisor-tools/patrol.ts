import {
  appendJournal,
  clipText,
  fail,
  INBOX_BODY_MAX,
  INBOX_TITLE_MAX,
  type InboxItemView,
  localDate,
  ok,
  type PatrolReportData,
  type PatrolReportRequest,
  type Result,
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
 * 2. 以 supervisor 身份经写入层追加一条 journal（与 `kb_journal` 写的是同一份 journal）；
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
    const journal = await appendJournal(
      deps.home,
      { text: `巡检日报（唤醒 ${wake.task_id}）\n\n${input.text}`, workspace: input.workspace },
      { actor: SUPERVISOR_ACTOR, now },
    )
    if (!journal.ok) return journal
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
          body: clipText(input.text, INBOX_BODY_MAX),
        },
      },
      { actor: 'hub' },
    )
    if (!r.ok) return r
    const item = ledger.getInboxItem(id)
    if (!item) return fail('failure', 'internal_error', '巡检日报条目写入后不可见')
    return ok({ item, journal: { file: journal.data.file, sha: journal.data.sha } })
  } finally {
    inflight.delete(id)
  }
}
