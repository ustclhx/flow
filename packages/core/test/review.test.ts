import { describe, expect, test } from 'bun:test'
import {
  defaultSupervisorConfig,
  latestTrustedReview,
  mayCarryReview,
  reviewApproves,
  reviewerRoleIssues,
  reviewerRoleProblem,
  samePrUrl,
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

describe('最新一次可信审查', () => {
  const at = (id: string, finished: string, over: Record<string, unknown> = {}) => ({
    ...reviewTask(over),
    id,
    created_at: '2026-10-26T08:00:00.000Z',
    finished_at: finished,
  })
  test('按结束时间取最新；不可信与其他 PR 的审查不计', () => {
    const tasks = [
      at('t-1', '2026-10-26T08:10:00.000Z'),
      at('t-2', '2026-10-26T08:20:00.000Z'),
      at('t-3', '2026-10-26T08:30:00.000Z', { role: 'reviewer' }),
      at('t-4', '2026-10-26T08:40:00.000Z', {
        inputs: { review: { pr: 'https://github.com/acme/demo/pull/8' } },
      }),
    ]
    expect(latestTrustedReview(tasks, { workspace: 'ws/demo', pr: PR }, sup)?.id).toBe('t-2')
    expect(latestTrustedReview([], { workspace: 'ws/demo', pr: PR }, sup)).toBeUndefined()
  })
})

describe('审查角色必须是只读配置', () => {
  const role = (
    over: Record<string, unknown> = {},
    perms: Record<string, unknown> = {},
  ): Parameters<typeof reviewerRoleProblem>[0] =>
    ({
      executor: 'claude-sdk',
      kind: 'read' as const,
      permissions: {
        setting_sources: [],
        read_scope: 'cwd',
        allowedTools: ['Read', 'Grep', 'Glob'],
        disallowedTools: ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
        ...perms,
      },
      ...over,
    }) as Parameters<typeof reviewerRoleProblem>[0]
  test('reviewerRoleProblem', () => {
    expect(reviewerRoleProblem(role())).toBeUndefined()
    expect(reviewerRoleProblem(role({ executor: 'codex-exec' }))).toContain('claude-sdk')
    expect(reviewerRoleProblem(role({}, { setting_sources: ['project'] }))).toContain('read')
    expect(reviewerRoleProblem(role({}, { read_scope: undefined }))).toContain('read_scope')
    expect(reviewerRoleProblem(role({}, { allowedTools: ['Bash(gh pr review:*)'] }))).toContain(
      'read',
    )
  })

  test('reviewerRoleIssues：只报已存在且不是只读配置的审查角色', () => {
    const ws = {
      id: 'demo',
      ref: 'ws/demo',
      kind: 'product' as const,
      name: 'Demo',
      description: '',
      repos: [],
      file: 'config/workspaces/demo.yaml',
      supervisor: { ...sup, reviewer_roles: ['pr-reviewer', 'reviewer', 'missing'] },
    }
    const issues = reviewerRoleIssues([ws], [
      { name: 'pr-reviewer', prompt: 'x', ...role() },
      {
        name: 'reviewer',
        prompt: 'x',
        ...role({ kind: undefined }, { setting_sources: ['project'] }),
      },
    ] as never)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({
      code: 'review_role_not_read',
      field: 'supervisor.reviewer_roles',
    })
    expect(issues[0]?.message).toContain('reviewer')
  })
})

test('PR 链接比较不区分大小写（reviewApproves、latestTrustedReview）', () => {
  const upper = 'https://github.com/ACME/Demo/pull/7'
  expect(reviewApproves(reviewTask(), { workspace: 'ws/demo', pr: upper }, sup).ok).toBe(true)
  const t = {
    ...reviewTask({ inputs: { review: { pr: upper } } }),
    id: 't-1',
    created_at: '2026-10-26T08:00:00.000Z',
    finished_at: '2026-10-26T08:10:00.000Z',
  }
  expect(latestTrustedReview([t], { workspace: 'ws/demo', pr: PR }, sup)?.id).toBe('t-1')
  expect(samePrUrl(upper, PR)).toBe(true)
  expect(samePrUrl('https://github.com/acme/demo/pull/8', PR)).toBe(false)
})

test('samePrUrl：两边都须是合法 PR 链接；host 去掉 www. 与 :443 后比较', () => {
  expect(samePrUrl('https://www.github.com/acme/demo/pull/7', PR)).toBe(true)
  expect(samePrUrl('https://github.com:443/acme/demo/pull/7', PR)).toBe(true)
  expect(samePrUrl('https://WWW.GitHub.com:443/Acme/Demo/pull/7', PR)).toBe(true)
  expect(samePrUrl('https://github.com:8443/acme/demo/pull/7', PR)).toBe(false)
  expect(samePrUrl('https://github.com/acme/demo/pull/7/', PR)).toBe(false)
  expect(samePrUrl('not a url', 'not a url')).toBe(false)
  expect(samePrUrl(PR, 'https://github.com/acme/demo/pull/70')).toBe(false)
})
