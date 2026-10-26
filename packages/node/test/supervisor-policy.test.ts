import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flowPaths, initFlowHome, type TaskView } from '@flow/core'
import { type Bench, bench } from './harness.ts'

/**
 * add-m1-supervisor 2.6：`flow init` 的 policies.yaml 模板中 supervisor 建任务的 auto 规则默认注释掉；
 * 未启用时 supervisor 的 task_create 走审批（blocked awaiting_approval，用户批准后继续），
 * 启用后自动放行。端到端：真实中枢路由（policy/check + 真实 decide）+ 节点 + fake 执行器。
 */

/** `flow init` 在临时 flow-home 中生成的 policies.yaml 原文。 */
let POLICIES_YAML = ''
let initRoot = ''
beforeAll(async () => {
  initRoot = mkdtempSync(join(tmpdir(), 'flow-sup-policy-'))
  const home = join(initRoot, 'home')
  const r = await initFlowHome(home)
  if (!r.ok) throw new Error(r.error.message)
  POLICIES_YAML = readFileSync(join(flowPaths(home).config, 'policies.yaml'), 'utf8')
})
afterAll(() => rmSync(initRoot, { recursive: true, force: true }))

let current: Bench | undefined
afterEach(async () => {
  await current?.close()
  current = undefined
})

const realWait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function settle(b: Bench, id: string, pred: (t: TaskView) => boolean, what: string) {
  for (let i = 0; i < 600; i++) {
    const t = b.task(id)
    if (pred(t)) return t
    await b.clock.advance(200)
    await realWait(2)
  }
  throw new Error(`等待超时（${what}）：${b.task(id).status} ${b.types(id).join(',')}`)
}

/** 模板中 supervisor 建任务的那条规则（取消注释）。 */
const RULE = '# - scope: supervisor\n#   action: task.create\n#   level: auto\n'

async function run(policiesYaml: string) {
  const b = await bench({ policiesYaml, precheckTimeoutMs: 3_600_000 }, 60)
  current = b
  // 唤醒任务只能由中枢（hub）创建；这里只关心 supervisor 角色的 task_create 请求如何判定。
  const r = await b.tasks.createTask(
    {
      goal: '拆任务',
      workspace: 'ws/demo',
      role: 'supervisor',
      executor: 'fake',
      cwd: b.home,
      inputs: {
        fake: {
          script: [{ do: 'approval', tool: 'mcp__flow__task_create' }],
          message: '完成',
        },
      },
    },
    { actor: 'hub' },
  )
  if (!r.ok) throw new Error(r.error.message)
  await b.clock.advance(0)
  return { b, id: r.data.task.id }
}

const decided = (b: Bench, id: string) =>
  b.events(id).filter((e) => e.type === 'policy.decided')[0]?.payload as
    | { level: string }
    | undefined

describe('supervisor 建任务的策略规则（2.6）', () => {
  test('模板含注释掉的规则', () => {
    expect(POLICIES_YAML).toContain(RULE)
  })

  test('未启用（模板原样）：task_create 进入审批，用户批准后继续', async () => {
    const { b, id } = await run(POLICIES_YAML)
    const t = await settle(b, id, (t) => t.status === 'blocked', 'blocked')
    expect(t.blocked?.reason).toBe('awaiting_approval')
    expect(decided(b, id)?.level).not.toMatch(/^auto/)
    const r = await b.api<{ ok: boolean }>('POST', `/v1/tasks/${id}/reply`, { kind: 'approve' })
    expect(r.ok).toBe(true)
    await settle(b, id, (t) => t.status === 'done', 'done')
  })

  test('启用模板中的规则后自动放行，不进入 blocked', async () => {
    const enabled = POLICIES_YAML.replace(RULE, RULE.replaceAll('# ', '').replaceAll('#   ', '  '))
    expect(enabled).not.toContain(RULE)
    const { b, id } = await run(enabled)
    await settle(b, id, (t) => t.status === 'done', 'done')
    expect(b.types(id)).not.toContain('task.blocked')
    expect(decided(b, id)?.level).toBe('auto')
  })
})
