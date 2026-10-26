import { createHash } from 'node:crypto'
import {
  clipText,
  type DecisionReviewData,
  type DecisionReviewRequest,
  decisionPath as decisionPathSchema,
  fail,
  INBOX_BODY_MAX,
  INBOX_TITLE_MAX,
  localDate,
  ok,
  type Result,
  readBrainEntries,
  resolveInboxLevel,
  reviewDecision,
} from '@flow/core'
import type { EventInput } from '../ledger/store.ts'
import type { WakeCaller } from '../server/wake-tokens.ts'
import { oneLine, type SupervisorToolsDeps } from './common.ts'

/**
 * 决策到期回看（design D11；task-proposal spec "决策到期回看"、scheduler spec "决策回看到期"；tasks 4.7）。
 *
 * 扫描：中枢注册每天 09:00（中枢时区，即系统本地时区）的内部规则，并在启动时扫描一次（补发停机期间错过的）。
 * `status: approved` 且回看日期已到（早于今天，或就是今天且已过 09:00）的决策：
 * - 决策有 workspace 且该 workspace 启用了 supervisor → 写 `decision.review_due{path, review_date}`
 *   （同一决策同一回看日期只写一次，以账本去重；**唤醒调度器（G10）消费这条事件**，origin autonomous）；
 * - 否则只生成一条 Digest 级的 `source: decision` 提醒条目（同样只生成一次），不写 `decision.review_due`，
 *   也就不会唤醒任何 supervisor。
 *
 * `decision_review`：只限本次唤醒（`supervisor.wake_started.events`）引用的 `decision.review_due` 的那条
 * 决策，否则 `not_review_target`；由中枢以 hub 身份经写入层的窄例外（`reviewDecision`）代写。
 */

/** 回看扫描的时刻（中枢时区）。 */
export const DECISION_REVIEW_HOUR = 9

/** 提醒条目 id：`dec.<sha256(path|review_date) 前 16 位>`。 */
export const decisionItemId = (path: string, reviewDate: string) =>
  `dec.${createHash('sha256').update(`${path}|${reviewDate}`).digest('hex').slice(0, 16)}`

/** 回看日期是否已到：早于今天，或就是今天且已过 09:00。 */
export function reviewDue(reviewDate: string, now: Date): boolean {
  const today = localDate(now)
  if (reviewDate < today) return true
  return reviewDate === today && now.getHours() >= DECISION_REVIEW_HOUR
}

export interface DecisionScanResult {
  /** 写了 `decision.review_due` 的决策路径。 */
  due: string[]
  /** 只生成提醒条目的决策路径。 */
  digest: string[]
}

export async function scanDecisionReviews(
  deps: SupervisorToolsDeps,
  opts: { missed?: boolean } = {},
): Promise<Result<DecisionScanResult>> {
  const read = await readBrainEntries(deps.home)
  if (!read.ok) return read
  const now = new Date(deps.now())
  const today = localDate(now)
  const out: DecisionScanResult = { due: [], digest: [] }
  for (const e of read.data.entries) {
    const fm = e.frontmatter
    if (fm.type !== 'decision' || fm.status !== 'approved') continue
    const rd = fm.review_date
    if (typeof rd !== 'string' || !reviewDue(rd, now)) continue
    const path = `${e.id}.md`
    const ws = typeof fm.workspace === 'string' ? fm.workspace : null
    const valid = decisionPathSchema.safeParse(path).success
    if (ws && valid && (await deps.supervisorActive(ws))) {
      const done = deps.ledger
        .eventsByPayload('decision.review_due', 'path', path)
        .some((ev) => ev.type === 'decision.review_due' && ev.payload.review_date === rd)
      if (done) continue
      const r = deps.ledger.append(
        {
          type: 'decision.review_due',
          workspace: ws,
          payload: { path, review_date: rd, missed: opts.missed === true || rd < today },
        },
        { actor: 'hub' },
      )
      if (r.ok) out.due.push(path)
      continue
    }
    const id = decisionItemId(path, rd)
    if (deps.ledger.getInboxItem(id)) continue
    const title = typeof fm.title === 'string' ? fm.title : e.id
    const draft: EventInput = {
      type: 'inbox.item_created',
      ...(ws ? { workspace: ws } : {}),
      payload: {
        item_id: id,
        level: resolveInboxLevel(deps.levels(), { source: 'decision', workspace: ws }),
        source: 'decision',
        source_ref: clipText(path, 256),
        title: clipText(
          `${ws ? `[${ws}] ` : ''}决策到期回看：${oneLine(title, 150)}`,
          INBOX_TITLE_MAX,
        ),
        body: clipText(
          [
            `决策 brain/${path} 的回看日期 ${rd} 已到。`,
            `预期效果：${String(fm.expected_outcome ?? '')}`,
            `衡量指标：${String(fm.metric ?? '')}`,
            ws
              ? `${ws} 未启用 supervisor，请自行回看，并把决策的 status 改为 reviewed。`
              : '该决策没有 workspace，请自行回看，并把决策的 status 改为 reviewed。',
          ].join('\n'),
          INBOX_BODY_MAX,
        ),
      },
    }
    const r = deps.ledger.append(draft, { actor: 'hub' })
    if (r.ok) out.digest.push(path)
  }
  return ok(out)
}

/**
 * 本次唤醒关联的回看决策：唤醒合并的事件（`supervisor.wake_started.events`）中的 `decision.review_due`。
 */
export function reviewTargets(deps: Pick<SupervisorToolsDeps, 'ledger'>, wakeTaskId: string) {
  const wake = deps.ledger.wakeOf(wakeTaskId)
  if (!wake) return []
  const out: { path: string; workspace: string | undefined }[] = []
  for (const seq of wake.events) {
    const e = deps.ledger.eventsAfter(seq - 1, {}, 1)[0]
    if (e?.seq === seq && e.type === 'decision.review_due') {
      out.push({ path: e.payload.path, workspace: e.workspace })
    }
  }
  return out
}

export async function decisionReview(
  deps: SupervisorToolsDeps,
  wake: WakeCaller,
  input: DecisionReviewRequest,
): Promise<Result<DecisionReviewData>> {
  const target = reviewTargets(deps, wake.task_id).find(
    (t) => t.path === input.path && t.workspace === wake.workspace,
  )
  if (!target) {
    return fail(
      'failure',
      'not_review_target',
      `${input.path} 不是本次回看唤醒关联的决策；decision_review 只能回看唤醒原因中的那条决策`,
      { path: input.path },
    )
  }
  return reviewDecision(
    deps.home,
    { path: input.path, text: input.text, date: localDate(new Date(deps.now())) },
    { actor: 'hub', now: new Date(deps.now()) },
  )
}
