import { afterAll, beforeAll, expect, test } from 'bun:test'
import { rm, writeFile } from 'node:fs/promises'
import { flowPaths, HUB_TOKEN_ENV, HubClient } from '@flow/core'
import { type RunningHub, runHub } from '@flow/hub'
import { initTempHome } from '../../mcp/test/helpers.ts'
import { commands } from '../src/commands/index.ts'
import { runCli } from '../src/run.ts'

let home: string
let hub: RunningHub | undefined
let taskId: string
const saved: Record<string, string | undefined> = {}
beforeAll(async () => {
  home = await initTempHome('flow-policy-cli-')
  for (const key of ['FLOW_HOME', 'FLOW_ACTOR', HUB_TOKEN_ENV]) saved[key] = process.env[key]
  process.env.FLOW_HOME = home
  delete process.env.FLOW_ACTOR
  delete process.env[HUB_TOKEN_ENV]
  const started = await runHub({
    home,
    port: 0,
    logger: { info() {}, warn() {} },
    secrets: { watch: false },
  })
  if (!started.ok) throw new Error(started.error.message)
  hub = started.data
  await writeFile(flowPaths(home).hubConfig, `port: ${hub.port}\n`)
  await writeFile(
    flowPaths(home).policiesConfig,
    '- scope: "*"\n  action: git.push\n  level: always\n- scope: ws/product-res\n  action: git.push\n  level: auto-report\n',
  )
  const created = await new HubClient({ home, actor: 'user' }).createTask({
    goal: '调试策略',
    workspace: 'ws/product-res',
    role: 'dev',
    executor: 'fake',
  })
  if (!created.ok) throw new Error(created.error.message)
  taskId = created.data.task.id
})
afterAll(async () => {
  await hub?.stop()
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (home) await rm(home, { recursive: true, force: true })
})

test('policy check 默认只判定 auto-report，--record 才入账；支持重复路径并报告策略错误', async () => {
  const client = new HubClient({ home, actor: 'user' })
  const before = await client.showTask(taskId)
  if (!before.ok) throw new Error(before.error.message)
  const args = [
    'policy',
    'check',
    '--task',
    taskId,
    '--tool',
    'Bash',
    '--command',
    'git push',
    '--path',
    'src/a',
    '--path',
    'src/b',
    '--json',
  ]
  const checked = await runCli(args, commands)
  expect(checked.exitCode).toBe(0)
  expect(JSON.parse(checked.stdout)).toMatchObject({
    ok: true,
    data: { level: 'auto-report', matched_rules: [{ rule_index: 1 }] },
  })
  const dry = await client.showTask(taskId)
  if (!dry.ok) throw new Error(dry.error.message)
  expect(dry.data).toEqual(before.data)
  const recorded = await runCli([...args, '--record'], commands)
  expect(recorded.exitCode).toBe(0)
  // auto-report 档位不返回 decision_id（只随 supervisor 档位返回），与只判定的输出一致。
  expect(JSON.parse(recorded.stdout)).toEqual(JSON.parse(checked.stdout))
  const shown = await client.showTask(taskId)
  if (!shown.ok) throw new Error(shown.error.message)
  // auto-report 随后由收件箱反应器在任务上开一个 Digest 条目（inbox.*），这里只看策略审计事件。
  const audited = shown.data.events.filter((e) => !e.type.startsWith('inbox.'))
  expect(audited).toHaveLength(before.data.events.length + 1)
  expect(audited.at(-1)).toMatchObject({
    type: 'policy.decided',
    payload: { request: { paths: ['src/a', 'src/b'] } },
  })
  const status = await runCli(['hub', 'status'], commands)
  expect(status.exitCode).toBe(0)
  expect(status.stdout).toContain('策略规则错误')
  expect(status.stdout).toContain('第 1 条规则')
})

test('缺少必需参数为用法错误；FLOW_ACTOR 不能通过 --actor user 绕过权限', async () => {
  expect((await runCli(['policy', 'check', '--tool', 'Bash'], commands)).exitCode).toBe(2)
  process.env.FLOW_ACTOR = 'codex'
  try {
    const denied = await runCli(
      ['policy', 'check', '--task', taskId, '--tool', 'Bash', '--actor', 'user', '--json'],
      commands,
    )
    expect(denied.exitCode).toBe(1)
    expect(JSON.parse(denied.stdout)).toMatchObject({ ok: false, error: { code: 'scope_denied' } })
  } finally {
    delete process.env.FLOW_ACTOR
  }
})
