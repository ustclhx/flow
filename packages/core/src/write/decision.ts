import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseFrontmatter } from '../frontmatter.ts'
import { flowPaths } from '../home.ts'
import { redactSecrets } from '../ledger/redact.ts'
import { fail, ok, type Result } from '../result.ts'
import { renderEntry } from './api.ts'
import { checkRepoReady, commitWrite, hashContent, type WriteContext } from './commit.ts'
import { DECISION_REVIEW } from './decision-capability.ts'
import { type WriteLock, withWriteLock } from './lock.ts'

/**
 * 决策条目（design D11）：任务提案带决策字段时，用户接受后由中枢以 user 身份写入
 * `brain/decisions/<YYYY-MM-DD>-<slug>.md`；到回看日期由 supervisor 经 `decision_review`
 * 追加回看一节（中枢以 hub 身份代写，写入层"AI 不能写 decision"的唯一窄例外）。
 */

/** 回看结论的上限（字符）。 */
export const DECISION_REVIEW_TEXT_MAX = 4000

/** 标题 → 路径中的 slug：只保留 ASCII 字母数字，其他字符折成 `-`，最多 40 字符。 */
export function decisionSlug(title: string): string {
  return title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
}

/**
 * 决策条目的路径（相对 brain/）：`decisions/<日期>-<slug>-<提案标识>.md`。
 * 带上提案标识保证同一天同名的决策不冲突；标题没有 ASCII 字符时只用提案标识。
 */
export function decisionPathFor(date: string, title: string, proposalId: string): string {
  const tag = proposalId
    .replace(/^tp-/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
  const slug = decisionSlug(title)
  return `decisions/${date}-${slug ? `${slug}-` : ''}${tag || 'x'}.md`
}

export interface DecisionDraft {
  title: string
  expected_outcome: string
  metric: string
  review_date: string
  workspace: string
  /** 据此建的任务 id（写入 sources）。 */
  task_id: string
  /** 任务目标与提案理由（写入正文）。 */
  goal: string
  reason?: string
}

const oneLine = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** 决策条目的完整内容（`status: approved`）。 */
export function renderDecision(d: DecisionDraft): string {
  const body = [
    '',
    '## 预期效果',
    '',
    d.expected_outcome,
    '',
    '## 衡量指标',
    '',
    d.metric,
    '',
    '## 任务',
    '',
    `任务 ${d.task_id}：`,
    '',
    d.goal,
    ...(d.reason ? ['', '## 理由', '', d.reason] : []),
    '',
  ].join('\n')
  return renderEntry(
    {
      type: 'decision',
      title: d.title,
      summary: oneLine(d.expected_outcome, 200),
      scope: 'work',
      status: 'approved',
      expected_outcome: d.expected_outcome,
      metric: d.metric,
      review_date: d.review_date,
      workspace: d.workspace,
      sources: [`task:${d.task_id}`],
      last_verified: null,
    },
    body,
  )
}

export interface DecisionReviewWrite {
  /** 相对 brain/ 的路径，例如 `decisions/2026-10-26-cache-ab12.md`。 */
  path: string
  text: string
  /** 回看日期（YYYY-MM-DD，中枢时区）。 */
  date: string
}

export interface DecisionReviewReceipt {
  path: string
  status: 'reviewed'
  last_verified: string
  sha: string
}

/**
 * **只供中枢使用**（`packages/hub/src/supervisor-tools/`）：为一条 `approved` 决策追加
 * `## 回看 <日期>` 一节，并把 `status` 改为 `reviewed`、`last_verified` 改为回看日期，其他字段不变。
 * 是否是本次回看唤醒关联的决策由中枢核对；这里在写锁内再由策略（`checkDecisionReview`）逐项核对修改范围。
 */
export async function reviewDecision(
  home: string,
  input: DecisionReviewWrite,
  ctx: WriteContext,
): Promise<Result<DecisionReviewReceipt>> {
  if (!/^decisions\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(input.path)) {
    return fail('usage', 'invalid_path', `决策路径应形如 decisions/<名称>.md：${input.path}`)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    return fail('usage', 'invalid_arguments', `回看日期应为 YYYY-MM-DD：${input.date}`)
  }
  const text = redactSecrets(input.text).trim()
  if (text === '') return fail('usage', 'invalid_arguments', '回看结论不能为空')
  if (text.length > DECISION_REVIEW_TEXT_MAX) {
    return fail('usage', 'invalid_arguments', `回看结论最多 ${DECISION_REVIEW_TEXT_MAX} 字符`)
  }
  const notReady = checkRepoReady(home, 'brain')
  if (notReady) return notReady
  const abs = join(flowPaths(home).brain, input.path)

  const writeLocked = async (lock: WriteLock): Promise<Result<DecisionReviewReceipt>> => {
    let before: string
    try {
      before = await readFile(abs, 'utf8')
    } catch {
      return fail('failure', 'not_found', `决策不存在：${input.path}`)
    }
    const parsed = parseFrontmatter(before)
    if (!parsed.ok) return parsed
    const fm = parsed.data.data
    if (fm.type !== 'decision') {
      return fail('failure', 'not_found', `${input.path} 不是决策条目`)
    }
    if (fm.status !== 'approved') {
      return fail(
        'failure',
        'invalid_transition',
        `决策状态为 ${String(fm.status)}，只有 approved 的决策可以回看`,
        { status: fm.status },
      )
    }
    const body = `${parsed.data.body.trimEnd()}\n\n## 回看 ${input.date}\n\n${text}\n`
    const content = renderEntry({ ...fm, status: 'reviewed', last_verified: input.date }, body)
    const r = await commitWrite(
      home,
      {
        repo: 'brain',
        op: 'apply',
        summary: `决策回看 ${input.path}`,
        files: [{ op: 'replace', path: input.path, content, baseHash: hashContent(before) }],
      },
      { ...ctx, lock, [DECISION_REVIEW]: true },
    )
    if (!r.ok) return r
    return ok({
      path: input.path,
      status: 'reviewed' as const,
      last_verified: input.date,
      sha: r.data.sha,
    })
  }
  if (ctx.lock) return writeLocked(ctx.lock)
  return withWriteLock(
    home,
    writeLocked,
    ctx.lockTimeoutMs === undefined ? {} : { timeoutMs: ctx.lockTimeoutMs },
  )
}
