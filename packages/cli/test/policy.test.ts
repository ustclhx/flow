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
    '- scope: "*"\n  action: git.push\n  level: always\n- scope: ws/product-res\n  action: git.push\n  level: draft-approve\n',
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

test('policy check 经 HubClient 返回明细，并支持重复路径；hub status 人类输出报告策略错误', async () => {
  const checked = await runCli(
    [
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
    ],
    commands,
  )
  expect(checked.exitCode).toBe(0)
  expect(JSON.parse(checked.stdout)).toMatchObject({
    ok: true,
    data: { level: 'draft-approve', matched_rules: [{ rule_index: 1 }] },
  })
  const shown = await new HubClient({ home, actor: 'user' }).showTask(taskId)
  if (!shown.ok) throw new Error(shown.error.message)
  expect(shown.data.events.at(-1)).toMatchObject({
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
