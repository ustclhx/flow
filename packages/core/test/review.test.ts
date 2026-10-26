import { describe, expect, test } from 'bun:test'
import {
  defaultSupervisorConfig,
  mayCarryReview,
  reviewApproves,
  stripUntrustedReview,
  type TaskView,
  taskContract,
  taskResult,
  trustedReview,
} from '../src/index.ts'

/** 审查结论的采信规则（add-m1-supervisor D10；pr-acceptance "审查结论由执行器把关"）。 */

const PR = 'https://github.com/acme/demo/pull/7'
const SHA = 'a'.repeat(40)
const sup = defaultSupervisorConfig()

const reviewTask = (over: Record<string, unknown> = {}, result: Record<string, unknown> = {}) =>
  ({
    workspace: 'ws/demo',
    status: 'done',
    contract: taskContract.parse({
      goal: '审查',
      workspace: 'ws/demo',
      role: 'pr-reviewer',
      executor: 'claude-sdk',
      inputs: { review: { pr: PR } },
      ...over,
    }),
    result: taskResult.parse({
      summary: '好',
      executor: 'claude-sdk',
      node_id: 'n-1',
      review: { verdict: 'approve', reviewed_sha: SHA },
      ...result,
    }),
  }) as Pick<TaskView, 'workspace' | 'status' | 'contract' | 'result'>

describe('审查结论的采信', () => {
  test('reviewer_roles 角色、claude-sdk、带 inputs.review、done：采信；approve 时给出 reviewed_sha', () => {
    expect(trustedReview(reviewTask(), sup)).toMatchObject({ ok: true, pr: PR })
    expect(reviewApproves(reviewTask(), { workspace: 'ws/demo', pr: PR }, sup)).toEqual({
      ok: true,
      reviewed_sha: SHA,
    })
  })

  test('非审查角色、其他执行器、没有 inputs.review、未 done、没有结论：不采信', () => {
    for (const t of [
      reviewTask({ role: 'reviewer' }),
      reviewTask({ executor: 'codex-exec' }),
      reviewTask({ inputs: {} }),
      { ...reviewTask(), status: 'failed' as const },
      reviewTask({}, { review: undefined }),
    ])
      expect(trustedReview(t, sup).ok).toBe(false)
    expect(
      trustedReview(reviewTask({ role: 'reviewer' }), { reviewer_roles: ['reviewer'] }).ok,
    ).toBe(true)
  })

  test('合并资格：workspace、PR 与结论都要一致', () => {
    const r = reviewTask(
      {},
      { review: { verdict: 'changes_requested', blocking: ['x'], reviewed_sha: SHA } },
    )
    expect(reviewApproves(r, { workspace: 'ws/demo', pr: PR }, sup).ok).toBe(false)
    expect(reviewApproves(reviewTask(), { workspace: 'ws/other', pr: PR }, sup).ok).toBe(false)
    expect(
      reviewApproves(
        reviewTask(),
        { workspace: 'ws/demo', pr: 'https://github.com/acme/demo/pull/8' },
        sup,
      ).ok,
    ).toBe(false)
  })

  test('入账前丢弃不可能是审查结论的 review', () => {
    const t = reviewTask()
    const result = t.result ?? taskResult.parse({ summary: 'x', executor: 'fake', node_id: 'n' })
    expect(stripUntrustedReview(t.contract, result).review).toBeDefined()
    for (const over of [{ inputs: {} }, { executor: 'fake' }]) {
      const c = reviewTask(over).contract
      expect(mayCarryReview(c)).toBe(false)
      const stripped = stripUntrustedReview(c, result)
      expect(stripped).not.toHaveProperty('review')
      expect(stripped.summary).toBe(result.summary)
    }
  })
})
