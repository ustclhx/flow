import type { SupervisorConfig } from '../schema/supervisor.ts'
import { type ReviewResult, reviewResult, type TaskResult, type TaskView } from './task.ts'

/**
 * 审查结论的采信规则（add-m1-supervisor D10；pr-acceptance "审查结论由执行器把关"）。
 *
 * 中枢与 pr-merge 执行器共用这里的纯函数，不要各自判断：
 * - 只有合同带 `inputs.review`、执行器为 claude-sdk、角色属于 workspace `supervisor.reviewer_roles`、
 *   已 `done` 的任务，其 `result.review` 才是审查结论；
 * - `reviewed_sha` 是执行器在会话前记录的 PR head（不取自模型）。
 */

export const REVIEW_EXECUTOR = 'claude-sdk'

/** 合同是否可能产出审查结论（不看角色；角色由 `trustedReview` 按 workspace 配置判断）。 */
export function mayCarryReview(contract: TaskView['contract']): boolean {
  return contract.executor === REVIEW_EXECUTOR && contract.inputs?.review !== undefined
}

/**
 * 节点提交的结果中，不可能是审查结论的 `review` 一律丢弃（中枢入账前调用）：
 * 结果不是 done、合同没有 `inputs.review` 或执行器不是 claude-sdk 时，`result.review` 不入账。
 * 角色是否属于 `reviewer_roles` 取决于 workspace 配置（可能之后才改），在采信时再判断。
 */
export function stripUntrustedReview<T extends Pick<TaskResult, 'review'>>(
  contract: TaskView['contract'],
  result: T,
  outcome: 'done' | 'failed' | 'cancelled' = 'done',
): T {
  // 只有 done 的审查任务才可能产出结论：failed / cancelled 一律不入账 review。
  if (result.review === undefined || (outcome === 'done' && mayCarryReview(contract))) return result
  const { review: _dropped, ...rest } = result
  return rest as T
}

/** 采信的审查结论：任务满足全部条件时返回 `result.review`，否则返回原因。 */
export type TrustedReview =
  | { ok: true; review: ReviewResult; pr: string }
  | { ok: false; reason: string }

export function trustedReview(
  task: Pick<TaskView, 'status' | 'contract' | 'result' | 'workspace'>,
  supervisor: Pick<SupervisorConfig, 'reviewer_roles'>,
): TrustedReview {
  const pr = task.contract.inputs?.review?.pr
  if (pr === undefined) return { ok: false, reason: '任务没有 inputs.review' }
  if (task.contract.executor !== REVIEW_EXECUTOR)
    return { ok: false, reason: `执行器 ${task.contract.executor} 不是 ${REVIEW_EXECUTOR}` }
  if (!supervisor.reviewer_roles.includes(task.contract.role))
    return { ok: false, reason: `角色 ${task.contract.role} 不在 supervisor.reviewer_roles 中` }
  if (task.status !== 'done')
    return { ok: false, reason: `审查任务状态为 ${task.status}，不是 done` }
  const parsed = reviewResult.safeParse(task.result?.review)
  if (!parsed.success) return { ok: false, reason: '审查任务没有合法的 result.review' }
  return { ok: true, review: parsed.data, pr }
}

/**
 * 该 PR 在 workspace 中最新一次可信审查（D10：合并请求与 pr-merge 都要求它就是给出 approve 的那次审查）。
 * 在 `tasks` 中挑出 `trustedReview` 采信、审查同一 PR 的任务，按结束时间（其次创建时间、id）取最新；没有时返回 undefined。
 */
export function latestTrustedReview<
  T extends Pick<
    TaskView,
    'id' | 'status' | 'contract' | 'result' | 'workspace' | 'finished_at' | 'created_at'
  >,
>(
  tasks: readonly T[],
  expected: { workspace: string; pr: string },
  supervisor: Pick<SupervisorConfig, 'reviewer_roles'>,
): T | undefined {
  const key = (t: T) => [t.finished_at ?? '', t.created_at, t.id].join('\u0000')
  return tasks
    .filter((t) => t.workspace === expected.workspace)
    .filter((t) => {
      const r = trustedReview(t, supervisor)
      return r.ok && r.pr === expected.pr
    })
    .sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0))[0]
}

/**
 * 合并请求中审查任务一侧的资格（D10 第 4 步后半；pr-merge 执行器在合并前再次核对）：
 * 同一 workspace、审查结论被采信、`inputs.review.pr` 等于该 PR、结论为 approve。
 * 通过时返回审查的 head（`reviewed_sha`）。
 */
export function reviewApproves(
  task: Pick<TaskView, 'status' | 'contract' | 'result' | 'workspace'>,
  expected: { workspace: string; pr: string },
  supervisor: Pick<SupervisorConfig, 'reviewer_roles'>,
): { ok: true; reviewed_sha: string } | { ok: false; reason: string } {
  if (task.workspace !== expected.workspace)
    return { ok: false, reason: `审查任务属于 ${task.workspace}，不是 ${expected.workspace}` }
  const trusted = trustedReview(task, supervisor)
  if (!trusted.ok) return trusted
  if (trusted.pr !== expected.pr)
    return { ok: false, reason: `审查任务审查的是 ${trusted.pr}，不是 ${expected.pr}` }
  if (trusted.review.verdict !== 'approve')
    return { ok: false, reason: `审查结论为 ${trusted.review.verdict}` }
  return { ok: true, reviewed_sha: trusted.review.reviewed_sha }
}
