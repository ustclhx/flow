import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { runDoctor as actualDoctor, type DoctorReport } from '../src/doctor.ts'
import {
  clipDiffStat,
  completeLeaseRequest,
  createTaskRequest,
  DIFF_STAT_MAX,
  defaultSupervisorConfig,
  delegationEnabled,
  describeSupervisorConfig,
  ledgerEvent,
  loadWorkspaces,
  policyCheckData,
  policyCheckRequest,
  renewLeaseRequest,
  reviewOutput,
  supervisorConfigSchema,
  taskResult,
  taskView,
  validateBrain,
} from '../src/index.ts'
import { initFlowHome } from '../src/init.ts'
import { doctorOptions } from './doctor-helpers.ts'
import { tempHome, writeText } from './helpers.ts'

const ts = '2026-10-26T08:00:00.000Z'
const contract = { goal: 'g', workspace: 'ws/product-res', role: 'supervisor', executor: 'fake' }
const result = { summary: 's', executor: 'claude-sdk', node_id: 'n1' }
const head = 'c'.repeat(40)
const task = { workspace: 'ws/product-res', task_id: 't_1' }
const event = (type: string, body: Record<string, unknown>) =>
  ledgerEvent.safeParse({ seq: 1, ts, type, actor: 'hub', ...body })

describe('合同 inputs.wake 与 inputs.review（1.5）', () => {
  test('唤醒输入：origin、generation、events；不认识的字段被拒', () => {
    const wake = {
      origin: 'instruction',
      generation: 3,
      events: [{ seq: 12, type: 'user.instruction', summary: '看看支付' }],
    }
    const r = createTaskRequest.safeParse({ ...contract, inputs: { wake } })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.inputs?.wake?.events[0]?.seq).toBe(12)
    // reply 唤醒的 origin 合法
    expect(
      createTaskRequest.safeParse({ ...contract, inputs: { wake: { ...wake, origin: 'reply' } } })
        .success,
    ).toBe(true)
    for (const bad of [
      { ...wake, origin: 'patrol' },
      { ...wake, generation: 0 },
      { ...wake, extra: true },
      { ...wake, events: [{ seq: 0, type: 'x' }] },
    ]) {
      expect(createTaskRequest.safeParse({ ...contract, inputs: { wake: bad } }).success).toBe(
        false,
      )
    }
  })

  test('审查输入：PR 链接与不超过 500 字的 focus', () => {
    const pr = 'https://github.com/ustclhx/product-res/pull/12'
    const ok = (review: unknown) =>
      createTaskRequest.safeParse({ ...contract, role: 'pr-reviewer', inputs: { review } }).success
    expect(ok({ pr })).toBe(true)
    expect(ok({ pr, focus: '注意 CI 配置' })).toBe(true)
    expect(ok({ pr, focus: 'x'.repeat(500) })).toBe(true)
    expect(ok({ pr, focus: 'x'.repeat(501) })).toBe(false)
    expect(ok({ pr: 'https://github.com/ustclhx/product-res/issues/12' })).toBe(false)
    expect(ok({ pr: 'http://github.com/o/r/pull/1' })).toBe(false)
    expect(ok({ pr, verdict: 'approve' })).toBe(false)
  })

  test('结果 review：reviewed_sha 必填，approve 时 blocking 必须为空', () => {
    const review = { verdict: 'changes_requested', blocking: ['缺测试'], reviewed_sha: head }
    const parsed = taskResult.safeParse({ ...result, review })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.review?.notes).toBe('')
    expect(
      taskResult.safeParse({ ...result, review: { verdict: 'approve', reviewed_sha: head } })
        .success,
    ).toBe(true)
    for (const bad of [
      { verdict: 'approve', blocking: ['x'], reviewed_sha: head },
      { verdict: 'changes_requested', blocking: ['x'] },
      { verdict: 'lgtm', reviewed_sha: head },
      { ...review, reviewed_sha: 'HEAD' },
    ]) {
      expect(taskResult.safeParse({ ...result, review: bad }).success).toBe(false)
    }
  })

  test('审查会话的结构化输出不含 reviewed_sha（由执行器填入）', () => {
    expect(reviewOutput.safeParse({ verdict: 'approve', blocking: [], notes: '' }).success).toBe(
      true,
    )
    expect(
      reviewOutput.safeParse({ verdict: 'approve', blocking: [], notes: '', reviewed_sha: head })
        .success,
    ).toBe(false)
  })
})

describe('账本事件与协议字段（1.1、1.6）', () => {
  test('task.created 的 origin 只能是 instruction 或 autonomous', () => {
    expect(event('task.created', { ...task, payload: { contract } }).success).toBe(true)
    for (const origin of ['instruction', 'autonomous']) {
      expect(event('task.created', { ...task, payload: { contract, origin } }).success).toBe(true)
    }
    expect(event('task.created', { ...task, payload: { contract, origin: 'reply' } }).success).toBe(
      false,
    )
  })

  test('task.blocked 的 decision_id、diff_stat、no_delegate 可选；diff_stat 最多 2000 字符', () => {
    const base = { reason: 'awaiting_approval', message: '请求运行 pnpm check' }
    expect(event('task.blocked', { ...task, payload: base }).success).toBe(true)
    const full = { ...base, decision_id: 9, diff_stat: 'README.md | 2 ++', no_delegate: true }
    expect(event('task.blocked', { ...task, payload: full }).success).toBe(true)
    expect(
      event('task.blocked', { ...task, payload: { ...base, diff_stat: 'x'.repeat(2001) } }).success,
    ).toBe(false)
    expect(event('task.blocked', { ...task, payload: { ...base, decision_id: 0 } }).success).toBe(
      false,
    )
  })

  test('clipDiffStat：超出截断并注明，结果不超过上限', () => {
    expect(clipDiffStat('a | 1 +')).toBe('a | 1 +')
    const clipped = clipDiffStat('x'.repeat(5000))
    expect(clipped.length).toBe(DIFF_STAT_MAX)
    expect(clipped.endsWith('…')).toBe(true)
  })

  test('task.replied 的 via 可以是 supervisor；收件箱关闭的 via 不行', () => {
    const reply = { reply_id: 'r-1', kind: 'approve', via: 'supervisor' }
    expect(event('task.replied', { ...task, payload: reply }).success).toBe(true)
    expect(
      event('inbox.item_closed', {
        payload: { item_id: 'blk.1', reason: 'task_running', via: 'supervisor' },
      }).success,
    ).toBe(false)
  })

  test('policy.decided 记录节点上报的 push_env_ok、gh_env_ok', () => {
    const payload = {
      task_id: 't_1',
      request: {
        tool: 'Bash',
        actions: ['git.push'],
        command: 'git push origin a',
        push_env_ok: true,
        gh_env_ok: false,
      },
      level: 'user',
      matched_rules: [],
      actions: [],
    }
    expect(event('policy.decided', { ...task, payload }).success).toBe(true)
  })

  test('task.reply_escalated 的原因枚举（D15）', () => {
    expect(event('task.reply_escalated', { ...task, payload: { reason: 'timeout' } }).success).toBe(
      false,
    )
    // superseded 已删去：进入新的卡住时委托隐式失效，不写事件
    expect(
      event('task.reply_escalated', { ...task, payload: { reason: 'superseded', block_seq: 3 } })
        .success,
    ).toBe(false)
    for (const reason of [
      'supervisor',
      'timeout',
      'wake_unavailable',
      'wake_failed',
      'wake_ended',
      'user_dismissed',
      'user_replied',
    ]) {
      expect(
        event('task.reply_escalated', { ...task, payload: { reason, block_seq: 3 } }).success,
      ).toBe(true)
    }
  })

  test('task.branch_reported 拒绝不确定的分支名', () => {
    for (const branch of ['ustclhx/t-1', 'feat_x', 'a.b/c-1']) {
      expect(event('task.branch_reported', { ...task, payload: { branch } }).success).toBe(true)
    }
    for (const branch of ['', '-x', 'a..b', 'a//b', 'a/', 'a.lock', 'HEAD', 'a b', 'a/.b', '+x']) {
      expect(event('task.branch_reported', { ...task, payload: { branch } }).success).toBe(false)
    }
  })

  test('policy/check：新字段可选，旧节点不带时照常通过；响应的 decision_id 可选', () => {
    const req = { task_id: 't_1', tool: 'Bash', command: 'git push origin a' }
    expect(policyCheckRequest.safeParse(req).success).toBe(true)
    expect(
      policyCheckRequest.safeParse({ ...req, push_env_ok: true, gh_env_ok: false }).success,
    ).toBe(true)
    expect(policyCheckRequest.safeParse({ ...req, push_env_ok: 'yes' }).success).toBe(false)
    const data = { level: 'user', matched_rules: [], actions: [] }
    expect(policyCheckData.safeParse(data).success).toBe(true)
    expect(policyCheckData.safeParse({ ...data, decision_id: 5 }).success).toBe(true)
    expect(policyCheckData.safeParse({ ...data, decision_id: 0 }).success).toBe(false)
  })

  test('续约与提交的 blocked 可带代回复字段；旧节点不带时兼容', () => {
    const token = 'x'.repeat(16)
    const blocked = { reason: 'awaiting_approval', message: '等批准' }
    const extra = { decision_id: 3, diff_stat: 'README.md | 2 ++', no_delegate: true }
    expect(renewLeaseRequest.safeParse({ lease_token: token, blocked }).success).toBe(true)
    expect(
      renewLeaseRequest.safeParse({ lease_token: token, blocked: { ...blocked, ...extra } })
        .success,
    ).toBe(true)
    const complete = {
      lease_token: token,
      outcome: 'blocked',
      blocked_reason: 'question',
      message: '哪个方案？',
    }
    expect(completeLeaseRequest.safeParse(complete).success).toBe(true)
    expect(completeLeaseRequest.safeParse({ ...complete, ...extra }).success).toBe(true)
    // 协议上限 8192（中枢入账前截到 2000）
    expect(
      completeLeaseRequest.safeParse({ ...complete, diff_stat: 'x'.repeat(8192) }).success,
    ).toBe(true)
    expect(
      completeLeaseRequest.safeParse({ ...complete, diff_stat: 'x'.repeat(8193) }).success,
    ).toBe(false)
  })

  test('任务视图带 origin 与 branch（无则为 null）', () => {
    const view = {
      id: 't_1',
      workspace: 'ws/product-res',
      status: 'queued',
      contract,
      attempt: 0,
      created_at: ts,
      updated_at: ts,
      started_at: null,
      finished_at: null,
      cancel_requested: false,
      blocked: null,
      lease: null,
      result: null,
      created_by: 'hub',
      origin: 'instruction',
      branch: 'ustclhx/t-1',
      last_activity_at: null,
    }
    expect(taskView.safeParse(view).success).toBe(true)
    expect(taskView.safeParse({ ...view, origin: null, branch: null }).success).toBe(true)
    expect(taskView.safeParse({ ...view, origin: 'reply' }).success).toBe(false)
  })
})

describe('workspace 的 supervisor 配置（1.2）', () => {
  test('默认值', () => {
    expect(defaultSupervisorConfig()).toEqual({
      enabled: true,
      auto_merge: false,
      merge_method: 'squash',
      allow_no_checks: false,
      reviewer_roles: ['pr-reviewer'],
      delegate_replies: true,
      reply_timeout_s: 600,
      limits: {
        tasks_per_wake: 5,
        wakes_per_day: 24,
        autonomous_wakes_per_day: 4,
        reply_wakes_per_day: 48,
        chain_depth: 8,
        review_rounds: 2,
        open_questions: 3,
      },
    })
    // 只写一部分 limits 时其余取默认值
    const partial = supervisorConfigSchema.parse({ limits: { tasks_per_wake: 2 } })
    expect(partial.limits).toMatchObject({ tasks_per_wake: 2, wakes_per_day: 24 })
  })

  test('拼错的键、非法取值与 autonomous 超过总数都被拒', () => {
    for (const bad of [
      { enable: true },
      { merge_method: 'fast-forward' },
      { reviewer_roles: [] },
      { reply_timeout_s: 5 },
      { limits: { tasks_per_wake: -1 } },
      { limits: { wakes_per_day: 2, autonomous_wakes_per_day: 3 } },
      { limits: { tasks_per_wak: 1 } },
    ]) {
      expect(supervisorConfigSchema.safeParse(bad).success).toBe(false)
    }
  })

  test('loadWorkspaces 补默认值；supervisor 段非法时仍加载 workspace、supervisor 视为未启用；global 不启用', async () => {
    const home = tempHome('flow-ws-supervisor-')
    const base = 'kind: product\nname: 测试\ndescription: 测试\nrepos: []\n'
    writeText(join(home, 'config/workspaces/plain.yaml'), `id: plain\n${base}`)
    writeText(
      join(home, 'config/workspaces/custom.yaml'),
      `id: custom\n${base}supervisor:\n  auto_merge: true\n  merge_method: rebase\n  limits:\n    review_rounds: 1\n`,
    )
    writeText(
      join(home, 'config/workspaces/broken.yaml'),
      `id: broken\n${base}supervisor:\n  merge_method: ff\n`,
    )
    const r = await loadWorkspaces(home)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const byId = new Map(r.data.workspaces.map((w) => [w.id, w]))
    expect(byId.get('plain')?.supervisor).toEqual(defaultSupervisorConfig())
    expect(byId.get('custom')?.supervisor).toMatchObject({
      enabled: true,
      auto_merge: true,
      merge_method: 'rebase',
      limits: { review_rounds: 1, tasks_per_wake: 5 },
    })
    expect(byId.get('broken')?.supervisor.enabled).toBe(false)
    expect(byId.get('broken')?.repos).toEqual([])
    expect(byId.get('global')?.supervisor.enabled).toBe(false)
    expect(delegationEnabled(byId.get('plain') as never)).toBe(true)
    expect(delegationEnabled(byId.get('broken') as never)).toBe(false)
    expect(delegationEnabled(byId.get('global') as never)).toBe(false)
    expect(r.data.issues).toEqual([])
    expect(r.data.warnings).toEqual([
      expect.objectContaining({
        file: 'config/workspaces/broken.yaml',
        field: 'supervisor.merge_method',
      }),
    ])
  })

  test('validateBrain：supervisor 段问题按警告报告，不算错误', async () => {
    const home = tempHome('flow-validate-supervisor-')
    await initFlowHome(home)
    const base = 'kind: product\nname: 测试\ndescription: 测试\nrepos: []\n'
    writeText(
      join(home, 'config/workspaces/bad.yaml'),
      `id: bad\n${base}supervisor:\n  merge_method: ff\n`,
    )
    const r = await validateBrain(home)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.errors.filter((e) => e.file === 'config/workspaces/bad.yaml')).toEqual([])
    expect(r.data.warnings).toContainEqual(
      expect.objectContaining({
        file: 'config/workspaces/bad.yaml',
        field: 'supervisor.merge_method',
      }),
    )
  })

  test('doctor 显示每个 workspace 的 supervisor 设置，并报告配置错误', async () => {
    const home = tempHome('flow-doctor-supervisor-')
    await initFlowHome(home)
    const base = 'kind: product\nname: 测试\ndescription: 测试\nrepos: []\n'
    writeText(join(home, 'config/workspaces/on.yaml'), `id: on\n${base}`)
    writeText(
      join(home, 'config/workspaces/off.yaml'),
      `id: off\n${base}supervisor:\n  enabled: false\n`,
    )
    writeText(
      join(home, 'config/workspaces/bad.yaml'),
      `id: bad\n${base}supervisor:\n  limits:\n    chain_depth: -1\n`,
    )
    const r = await actualDoctor(home, 'FLOW_HOME', doctorOptions(home))
    const report = r.ok ? r.data : (r.error.details as DoctorReport)
    const find = (id: string) => report.checks.find((c) => c.id === id)
    expect(find('workspace.on.supervisor')).toMatchObject({ ok: true, severity: 'info' })
    expect(find('workspace.on.supervisor')?.message).toContain('自动合并 关')
    expect(find('workspace.on.supervisor')?.message).toContain('审查角色 pr-reviewer')
    expect(find('workspace.off.supervisor')?.message).toBe('ws/off supervisor：未启用')
    expect(
      find('workspaces.config.config/workspaces/bad.yaml.supervisor.limits.chain_depth'),
    ).toMatchObject({ ok: false, severity: 'warning' })
    // supervisor 段非法：workspace 照常加载，supervisor 显示为未启用
    expect(find('workspace.bad.supervisor')?.message).toBe('ws/bad supervisor：未启用')
    expect(find('workspace.global.supervisor')?.message).toContain('global 不启用 supervisor')
  })

  test('delegationEnabled = enabled && delegate_replies', () => {
    const c = defaultSupervisorConfig()
    expect(delegationEnabled({ supervisor: c })).toBe(true)
    expect(delegationEnabled({ supervisor: { ...c, delegate_replies: false } })).toBe(false)
    expect(delegationEnabled({ supervisor: { ...c, enabled: false } })).toBe(false)
  })

  test('describeSupervisorConfig 列出代回复与上限', () => {
    const text = describeSupervisorConfig(defaultSupervisorConfig())
    expect(text).toContain('代回复 开（超时 600s）')
    expect(text).toContain('每次唤醒 5 个任务')
    expect(text).toContain('reply 48')
  })
})
