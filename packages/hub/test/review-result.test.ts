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

test('带 inputs.review 的 claude-sdk 任务保留 review；其他任务的 review 不入账', () => {
  const pr = 'https://github.com/acme/demo/pull/7'
  for (const outcome of ['done', 'failed'] as const) {
    const kept = completionDrafts(task({ review: { pr } }), lease, {
      lease_token: 'x'.repeat(16),
      outcome,
      result,
    })
    const keptPayload = (kept[0]?.payload ?? {}) as { result?: { review?: unknown } }
    expect(keptPayload.result?.review).toEqual(review)
    for (const t of [task({}), task({ review: { pr } }, 'codex-exec')]) {
      const [draft] = completionDrafts(t, lease, { lease_token: 'x'.repeat(16), outcome, result })
      const r = (draft?.payload ?? {}) as { result?: Record<string, unknown> }
      expect(r.result).toBeDefined()
      expect(r.result).not.toHaveProperty('review')
      expect(r.result?.summary).toBe('好')
    }
  }
})
