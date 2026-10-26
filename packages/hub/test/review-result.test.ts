import { expect, test } from 'bun:test'
import { type TaskView, taskContract } from '@flow/core'
import { completionDrafts, type LeaseRecord } from '../src/index.ts'

/** 中枢入账前丢弃不可能是审查结论的 result.review（add-m1-supervisor D10）。 */

const review = {
  verdict: 'approve' as const,
  blocking: [],
  notes: '',
  reviewed_sha: 'a'.repeat(40),
}
const result = {
  summary: '好',
  artifacts: [],
  verify: [],
  executor: 'claude-sdk',
  node_id: 'n-1',
  review,
}
const PR = 'https://github.com/acme/demo/pull/7'

function task(inputs: Record<string, unknown>, executor = 'claude-sdk'): TaskView {
  return {
    id: 't-1',
    workspace: 'ws/demo',
    status: 'running',
    contract: taskContract.parse({ goal: 'x', workspace: 'ws/demo', role: 'r', executor, inputs }),
    cancel_requested: false,
  } as unknown as TaskView
}
const lease = { lease_id: 'l-1', node_id: 'n-1' } as unknown as LeaseRecord
const resultOf = (drafts: ReturnType<typeof completionDrafts>) =>
  ((drafts[0]?.payload ?? {}) as { result?: Record<string, unknown> }).result

test('只有 done、带 inputs.review 的 claude-sdk 任务保留 review', () => {
  const kept = completionDrafts(task({ review: { pr: PR } }), lease, {
    lease_token: 'x'.repeat(16),
    outcome: 'done',
    result,
  })
  expect(resultOf(kept)?.review).toEqual(review)
  for (const t of [task({}), task({ review: { pr: PR } }, 'codex-exec')]) {
    const r = resultOf(
      completionDrafts(t, lease, { lease_token: 'x'.repeat(16), outcome: 'done', result }),
    )
    expect(r).not.toHaveProperty('review')
    expect(r?.summary).toBe('好')
  }
})

test('failed 与 cancelled 一律剥离 review（即使是审查任务）', () => {
  const failed = resultOf(
    completionDrafts(task({ review: { pr: PR } }), lease, {
      lease_token: 'x'.repeat(16),
      outcome: 'failed',
      result,
    }),
  )
  expect(failed).not.toHaveProperty('review')
  expect(failed?.summary).toBe('好')
  const t = { ...task({ review: { pr: PR } }), cancel_requested: true } as TaskView
  const cancelled = resultOf(
    completionDrafts(t, lease, { lease_token: 'x'.repeat(16), outcome: 'cancelled', result }),
  )
  expect(cancelled).not.toHaveProperty('review')
})
