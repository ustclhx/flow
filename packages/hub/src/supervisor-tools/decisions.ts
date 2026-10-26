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

/** 回看兜底：回看日期过了这么多天仍是 approved，补一条 Digest 提醒用户。 */
export const REVIEW_OVERDUE_DAYS = 14

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export async function scanDecisionReviews(
  deps: SupervisorToolsDeps,
): Promise<Result<DecisionScanResult>> {
  const read = await readBrainEntries(deps.home)
  if (!read.ok) return read
  const now = new Date(deps.now())
  const today = localDate(now)
  const out: DecisionScanResult = { due: [], digest: [] }
  const approved = new Map<string, string>()

  const remind = (
    path: string,
    rd: string,
    ws: string | null,
    fm: Record<string, unknown>,
    title: string,
    why: string,
    id: string,
  ) => {
    if (deps.ledger.getInboxItem(id)) return
    const r = deps.ledger.append(
      {
        type: 'inbox.item_created',
        ...(ws ? { workspace: ws } : {}),
        payload: {
          item_id: id,
          level: resolveInboxLevel(deps.levels(), { source: 'decision', workspace: ws }),
          source: 'decision',
          source_ref: clipText(path, 256),
          title: clipText(`${ws ? `[${ws}] ` : ''}${title}`, INBOX_TITLE_MAX),
          body: clipText(
            [
              `决策 brain/${path} 的回看日期 ${rd} 已到。`,
              `预期效果：${String(fm.expected_outcome ?? '')}`,
              `衡量指标：${String(fm.metric ?? '')}`,
              why,
            ].join('\n'),
            INBOX_BODY_MAX,
          ),
        },
      } satisfies EventInput,
      { actor: 'hub' },
    )
    if (r.ok) out.digest.push(path)
  }

  for (const e of read.data.entries) {
    const fm = e.frontmatter
    if (fm.type !== 'decision' || fm.status !== 'approved') continue
    const rd = fm.review_date
    const path = `${e.id}.md`
    if (typeof rd !== 'string') continue
    approved.set(path, rd)
    if (!reviewDue(rd, now)) continue
    const ws = typeof fm.workspace === 'string' ? fm.workspace : null
    const valid = decisionPathSchema.safeParse(path).success
    const title = oneLine(typeof fm.title === 'string' ? fm.title : e.id, 150)
    if (ws && valid && (await deps.supervisorActive(ws))) {
      const done = deps.ledger
        .eventsByPayload('decision.review_due', 'path', path)
        .some((ev) => ev.type === 'decision.review_due' && ev.payload.review_date === rd)
      if (!done) {
        const r = deps.ledger.append(
          {
            type: 'decision.review_due',
            workspace: ws,
            // 只有回看日期早于今天才算补发；当天按时（或启动时）到期的不标 missed。
            payload: { path, review_date: rd, missed: rd < today },
          },
          { actor: 'hub' },
        )
        if (r.ok) out.due.push(path)
      }
      // 兜底：supervisor 迟迟没有回看（例如唤醒失败），过期 14 天后提醒用户。
      if (addDays(rd, REVIEW_OVERDUE_DAYS) <= today) {
        remind(
          path,
          rd,
          ws,
          fm,
          `决策回看已逾期：${title}`,
          `回看日期已过 ${REVIEW_OVERDUE_DAYS} 天，决策仍为 approved：supervisor 未完成回看，请检查或自行回看。`,
          // 与"到期回看"提醒共用同一个 id：同一决策同一回看日期最多一条提醒（先生成的保留）。
          decisionItemId(path, rd),
        )
      }
      continue
    }
    remind(
      path,
      rd,
      ws,
      fm,
      `决策到期回看：${title}`,
      ws
        ? `${ws} 未启用 supervisor，请自行回看，并把决策的 status 改为 reviewed。`
        : '该决策没有 workspace，请自行回看，并把决策的 status 改为 reviewed。',
      decisionItemId(path, rd),
    )
  }

  // 用户已手动改了决策（status 不再是 approved、换了回看日期或删除）：关闭对应的提醒条目。
  // 本次读取有问题（例如正在编辑、frontmatter 暂时解析失败）的文件跳过，不误关它的提醒。
  const unreadable = new Set(
    read.data.issues.flatMap((i) => [
      i.file.replace(/^brain\//, ''),
      ...(i.id ? [`${i.id}.md`] : []),
    ]),
  )
  for (const item of deps.ledger.listInboxItems({ source: 'decision', state: 'open', limit: -1 })) {
    if (unreadable.has(item.source_ref)) continue
    const rd = approved.get(item.source_ref)
    if (rd !== undefined && item.id === decisionItemId(item.source_ref, rd)) continue
    deps.ledger.append(
      {
        type: 'inbox.item_closed',
        ...(item.workspace ? { workspace: item.workspace } : {}),
        payload: { item_id: item.id, reason: 'acted', note: '决策已不是待回看状态' },
      },
      { actor: 'hub' },
    )
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
