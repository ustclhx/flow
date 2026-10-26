import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  eventPayloads,
  flowPaths,
  HubClient,
  initFlowHome,
  type PolicyCheckRequest,
  type PolicyDecision,
  policyCheckData,
} from '@flow/core'
import { stringify } from 'yaml'
import { z } from 'zod'
import { type RunningHub, runHub } from '../src/index.ts'
import { policyCheckResponse } from '../src/policy/routes.ts'
import { must } from './ledger-helpers.ts'
import { FakeClock } from './server-fixtures.ts'

let root: string
let hub: RunningHub | undefined
afterEach(async () => {
  await hub?.stop()
  hub = undefined
  if (root) rmSync(root, { recursive: true, force: true })
})

async function setup(rules: unknown[] = []) {
  root = mkdtempSync(join(tmpdir(), 'flow-policy-hub-'))
  const home = join(root, 'home')
  must(await initFlowHome(home))
  mkdirSync(join(home, 'config', 'workspaces'), { recursive: true })
  writeFileSync(
    join(home, 'config', 'workspaces', 'xuanxue-saas.yaml'),
    'id: xuanxue-saas\nkind: product\nname: 测试\ndescription: 测试\nrepos: []\n',
  )
  const policies = (input: unknown[]) =>
    writeFileSync(flowPaths(home).policiesConfig, stringify(input))
  policies(rules)
  const clock = new FakeClock(Date.now())
  hub = must(
    await runHub({
      home,
      port: 0,
      clock,
      logger: { info() {}, warn() {} },
      secrets: { watch: false },
    }),
  )
  writeFileSync(flowPaths(home).hubConfig, `port: ${hub.port}\n`)
  const token = readFileSync(flowPaths(home).hubToken, 'utf8').trim()
  const user = new HubClient({ home, actor: 'user', token })
  const task = must(
    await user.createTask({
      goal: '策略预检',
      workspace: 'ws/xuanxue-saas',
      role: 'dev',
      executor: 'fake',
    }),
  ).task
  const request: PolicyCheckRequest = {
    task_id: task.id,
    tool: 'Bash',
    command: 'git push origin feat',
  }
  const raw = (body: unknown, asToken = token, actor?: string) =>
    fetch(`${hub?.url}/v1/policy/check`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${asToken}`,
        'Content-Type': 'application/json',
        ...(actor ? { 'X-Flow-Actor': actor } : {}),
      },
      body: JSON.stringify(body),
    })
  return { home, policies, clock, token, user, task, request, raw }
}

test('具体规则优先：合同 scope 决定 draft-approve，事件可查询且重建不改变投影', async () => {
  const { user, task, request, raw } = await setup([
    { scope: '*', action: 'git.push', level: 'auto' },
    { scope: 'ws/xuanxue-saas', action: 'git.push', level: 'draft-approve' },
  ])
  const checked = must(await user.checkPolicy(request))
  expect(checked.level).toBe('draft-approve')
  expect(checked.matched_rules).toEqual([
    {
      rule_index: 1,
      rule: { scope: 'ws/xuanxue-saas', action: 'git.push', level: 'draft-approve' },
    },
  ])
  expect(checked.actions).toMatchObject([
    { action: 'tool:Bash', level: 'skipped' },
    { action: 'git.push', level: 'draft-approve' },
  ])
  const shown = must(await user.showTask(task.id))
  expect(shown.task).toEqual(task)
  expect(shown.events.at(-1)).toMatchObject({
    type: 'policy.decided',
    actor: 'policy',
    workspace: task.workspace,
    task_id: task.id,
    payload: {
      task_id: task.id,
      request: { tool: request.tool, command: request.command, actions: ['tool:Bash', 'git.push'] },
      level: checked.level,
      matched_rules: checked.matched_rules,
      actions: checked.actions,
    },
  })
  // 客户端不能通过伪造 workspace / role 影响结果。
  expect((await raw({ ...request, workspace: 'ws/other', role: 'admin' })).status).toBe(400)
  must(await user.rebuild())
  const rebuilt = must(await user.showTask(task.id))
  expect(rebuilt.task).toEqual(task)
  expect(rebuilt.events).toEqual(shown.events)
})

test('通配规则不能放行合并；角色与 workspace 的显式规则可自动放行', async () => {
  const { user, request, policies } = await setup([{ scope: '*', action: '*', level: 'auto' }])
  const merge = { ...request, command: 'gh pr merge 42' }
  const guarded = must(await user.checkPolicy(merge))
  expect(guarded.level).toBe('draft-approve')
  expect(guarded.actions.find((a) => a.action === 'pr.merge')?.guarded).toBe(true)
  for (const scope of ['dev', 'ws/xuanxue-saas']) {
    policies([{ scope, action: 'pr.merge', level: 'auto-report' }])
    expect(must(await user.checkPolicy(merge)).level).toBe('auto-report')
  }
})

test('user dry_run：auto-report 只返回脱敏明细、不入账；false 入账且结果一致', async () => {
  const fake = `ghp_${'Ab9'.repeat(12)}`
  const { user, request, task } = await setup([
    {
      scope: 'dev',
      action: 'git.push',
      level: 'auto-report',
      when: { command_prefix: `git push ${fake}` },
    },
  ])
  const input = { ...request, command: `git push ${fake}` }
  const before = must(await user.showTask(task.id))
  const dry = must(await user.checkPolicy({ ...input, dry_run: true }))
  expect(dry.level).toBe('auto-report')
  expect(dry.actions).toMatchObject([
    { action: 'tool:Bash', level: 'skipped' },
    { action: 'git.push', level: 'auto-report' },
  ])
  expect(JSON.stringify(dry)).not.toContain(fake)
  expect(dry.matched_rules[0]?.rule.when?.command_prefix).toContain('[REDACTED:github-token]')
  expect(must(await user.showTask(task.id))).toEqual(before)
  const recorded = must(await user.checkPolicy({ ...input, dry_run: false }))
  expect(recorded).toEqual(dry)
  const after = must(await user.showTask(task.id))
  // auto-report 随后由收件箱反应器在任务上开一个 Digest 条目（inbox.*），这里只看策略审计事件。
  const audited = after.events.filter((e) => !e.type.startsWith('inbox.'))
  expect(audited).toHaveLength(before.events.length + 1)
  expect(audited.at(-1)).toMatchObject({
    type: 'policy.decided',
    payload: { level: 'auto-report' },
  })
})

test('坏规则被跳过、保留原始索引；status 报错，配置修正后立即生效', async () => {
  const { user, request, policies } = await setup([
    { scope: '*', action: 'git.push', level: 'always' },
    { scope: '*', action: 'git.push', level: 'auto' },
  ])
  const status = must(await user.status())
  expect(status.policies).toMatchObject({
    loaded: 1,
    errors: [{ rule_index: 0, field: 'level', code: 'invalid_field' }],
  })
  const checked = must(await user.checkPolicy(request))
  expect(checked.level).toBe('auto')
  expect(checked.matched_rules[0]?.rule_index).toBe(1)
  policies([])
  expect(must(await user.status()).policies).toEqual({ loaded: 0, errors: [] })
  expect(must(await user.checkPolicy(request)).level).toBe('user')
})

test('scope：仅租约持有节点或 user；其他节点、AI、过期或已释放租约均拒绝且不入账', async () => {
  const { home, user, task, request, raw, clock } = await setup()
  const nodeToken = must(await user.issueToken({ actor: 'node:n1' })).secret
  const otherToken = must(await user.issueToken({ actor: 'node:n2' })).secret
  const node = new HubClient({ home, actor: 'node:n1', token: nodeToken })
  must(
    await node.request('nodes-register', {
      node_id: 'n1',
      hostname: 'test',
      version: '0',
      capabilities: ['executor:fake'],
    }),
  )
  const lease = must(
    await node.request('leases-acquire', {
      node_id: 'n1',
      capabilities: ['executor:fake'],
      wait_s: 0,
    }),
  ).lease
  if (!lease) throw new Error('未领取到租约')
  const initial = must(await user.showTask(task.id)).events.length
  const dry = await raw({ ...request, dry_run: true }, nodeToken)
  expect(dry.status).toBe(400)
  expect(await dry.json()).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } })
  expect(must(await user.showTask(task.id)).events).toHaveLength(initial)
  // 节点省略 dry_run 或显式传 false，都必须写审计事件。
  for (const input of [request, { ...request, dry_run: false }]) {
    const before = must(await user.showTask(task.id)).events.length
    expect((await raw(input, nodeToken)).status).toBe(200)
    const events = must(await user.showTask(task.id)).events
    expect(events).toHaveLength(before + 1)
    expect(events.at(-1)?.type).toBe('policy.decided')
  }
  const before = must(await user.showTask(task.id)).events.length
  expect((await raw(request, otherToken)).status).toBe(403)
  expect((await raw(request, undefined, 'codex')).status).toBe(403)
  // 不推进定时器：租约虽仍标为 active，已过期时也不能通过 scope。
  clock.time = Date.parse(lease.expires_at)
  expect((await raw(request, nodeToken)).status).toBe(403)
  expect(must(await user.showTask(task.id)).events).toHaveLength(before)
  expect((await raw(request)).status).toBe(200)
  clock.time -= 1000
  must(
    await node.request(
      'leases-complete',
      {
        lease_token: lease.lease_token,
        outcome: 'blocked',
        blocked_reason: 'question',
        message: '测试',
      },
      lease.lease_id,
    ),
  )
  const ended = must(await user.showTask(task.id)).events.length
  expect((await raw(request, nodeToken)).status).toBe(403)
  expect(must(await user.showTask(task.id)).events).toHaveLength(ended)
})

test('自由文本：命令、路径和命中条件中的假 token 脱敏，长命令限长且按完整输入判定', async () => {
  const fake = `ghp_${'Ab9'.repeat(12)}`
  const { user, request, task } = await setup([
    {
      scope: 'dev',
      action: 'git.push',
      level: 'auto',
      when: { command_prefix: `git push ${fake}` },
    },
  ])
  const checked = must(
    await user.checkPolicy({
      ...request,
      command: `git push ${fake} ${'x'.repeat(3000)}`,
      paths: [`src/${fake}/file`],
    }),
  )
  expect(checked.level).toBe('auto')
  const event = must(await user.showTask(task.id)).events.at(-1)
  expect(event?.type).toBe('policy.decided')
  if (event?.type !== 'policy.decided') throw new Error('缺少策略事件')
  const payload = eventPayloads['policy.decided'].parse(event.payload)
  expect(payload.request.command?.length).toBeLessThanOrEqual(2000)
  expect(payload.request.paths).toEqual(['src/[REDACTED:github-token]/file'])
  expect(JSON.stringify(event)).not.toContain(fake)
  expect(JSON.stringify(checked)).not.toContain(fake)
  expect(payload.request.command).toContain('[REDACTED:github-token]')
  const long = must(
    await user.checkPolicy({
      ...request,
      command: `git push ${'x'.repeat(1970)} ${fake}; gh pr merge 42`,
    }),
  )
  expect(long.level).toBe('user')
  expect(long.actions.some((a) => a.action === 'pr.merge')).toBe(true)
  const audit = JSON.stringify(must(await user.showTask(task.id)).events.at(-1))
  expect(audit).not.toContain('ghp_')
})

test('不存在的任务返回 404，非法或超长请求返回 400；文件级配置错误拒绝检查并由 status 报告', async () => {
  const { home, request, raw, user, task } = await setup()
  const before = must(await user.showTask(task.id)).events.length
  expect((await raw({ ...request, task_id: 't-missing' })).status).toBe(404)
  expect((await raw({ ...request, command: 'x'.repeat(8193) })).status).toBe(400)
  expect((await raw({ ...request, paths: ['x'.repeat(2001)] })).status).toBe(400)
  expect((await raw({ ...request, dry_run: 'true' })).status).toBe(400)
  writeFileSync(flowPaths(home).policiesConfig, '- [\n')
  expect((await raw(request)).status).toBe(500)
  expect(must(await user.status()).policies).toMatchObject({
    loaded: 0,
    errors: [{ code: 'invalid_config' }],
  })
  expect(must(await user.showTask(task.id)).events).toHaveLength(before)
})

test('policy/check：非 supervisor 档位不返回 decision_id，旧节点的 strict 旧版 schema 能解析；记录环境检查', async () => {
  // main 上旧版 policyCheckData 的副本：顶层 strict，只有 level、matched_rules、actions。
  const legacyPolicyCheckData = z.strictObject({
    level: z.enum(['auto', 'auto-report', 'draft-approve', 'user', 'notify']),
    matched_rules: z.array(z.unknown()),
    actions: z.array(z.unknown()),
  })
  const { user, task, request, policies } = await setup([
    { scope: 'ws/xuanxue-saas', action: 'git.push', level: 'auto' },
  ])
  const auto = must(await user.checkPolicy({ ...request, push_env_ok: true, gh_env_ok: false }))
  expect(auto.level).toBe('auto')
  expect(auto).not.toHaveProperty('decision_id')
  expect(legacyPolicyCheckData.safeParse(auto).success).toBe(true)
  const decided = must(await user.showTask(task.id)).events.at(-1)
  expect(decided?.payload).toMatchObject({ request: { push_env_ok: true, gh_env_ok: false } })
  policies([])
  const legacy = must(await user.checkPolicy(request))
  expect(legacy.level).toBe('user')
  expect(legacyPolicyCheckData.safeParse(legacy).success).toBe(true)
  const last = must(await user.showTask(task.id)).events.at(-1)
  expect((last?.payload as { request?: object } | undefined)?.request).not.toHaveProperty(
    'push_env_ok',
  )
})

test('policyCheckResponse：只有 supervisor 档位带 decision_id', () => {
  const base = { matched_rules: [], actions: [] }
  expect(policyCheckResponse({ level: 'user', ...base }, 9)).toEqual({ level: 'user', ...base })
  expect(
    policyCheckResponse({ level: 'supervisor' as PolicyDecision['level'], ...base }, 9),
  ).toEqual({ level: 'supervisor' as PolicyDecision['level'], ...base, decision_id: 9 })
  // 新版 schema 非 strict：以后加字段不破坏解析
  expect(policyCheckData.safeParse({ level: 'user', ...base, future: 1 }).success).toBe(true)
})
