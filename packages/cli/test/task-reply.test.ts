import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { rm, writeFile } from 'node:fs/promises'
import {
  type FakeStep,
  flowPaths,
  HubClient,
  invokeOperation,
  type Result,
  type TaskView,
  taskReplyOp,
} from '@flow/core'
import { type RunningHub, runHub } from '@flow/hub'
import { type RunningNode, startNode } from '@flow/node'
import { callJson, connect, initTempHome } from '../../mcp/test/helpers.ts'
import { commands } from '../src/commands/index.ts'
import { runCli } from '../src/run.ts'

/**
 * `task_reply` 操作（add-m1-executors 1.3；task-interaction spec）：CLI 位置参数 / `--approve` / `--deny`
 * 与 MCP 共用一份定义；真实中枢（随机端口）+ 进程内节点 + fake 执行器。临时 FLOW_HOME，不碰 ~/flow-home。
 */

let home: string
let hub: RunningHub
let node: RunningNode
let savedHome: string | undefined
const quiet = { info() {}, warn() {} }

function data<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r.data
}
const client = () => new HubClient({ home, actor: 'user' })

beforeAll(async () => {
  home = await initTempHome('flow-task-reply-')
  savedHome = process.env.FLOW_HOME
  process.env.FLOW_HOME = home
  await writeFile(flowPaths(home).hubConfig, 'lease_ttl_s: 5\n')
  hub = data(await runHub({ home, port: 0, logger: { ...quiet, error() {} } as never }))
  await writeFile(flowPaths(home).hubConfig, `port: ${hub.port}\nlease_ttl_s: 5\n`)
  node = data(
    await startNode({ home, hubUrl: hub.url, logger: quiet, nodeId: 'n-reply', concurrency: 8 }),
  )
})

afterAll(async () => {
  await node?.stop()
  await hub?.stop()
  if (savedHome === undefined) delete process.env.FLOW_HOME
  else process.env.FLOW_HOME = savedHome
  await rm(home, { recursive: true, force: true })
})

async function create(script: FakeStep[]): Promise<string> {
  const r = await client().createTask({
    goal: '回复测试',
    workspace: 'ws/product-res',
    role: 'dev',
    executor: 'fake',
    inputs: { fake: { script } },
  })
  return data(r).task.id
}

async function until(id: string, pred: (t: TaskView) => boolean, what: string) {
  const deadline = Date.now() + 10_000
  for (;;) {
    const t = data(await client().showTask(id)).task
    if (pred(t)) return t
    if (Date.now() > deadline) throw new Error(`等待 ${what} 超时：${t.status}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

const cli = async (...args: string[]) => {
  const out = await runCli(['task', 'reply', ...args, '--json'], commands)
  return { code: out.exitCode, doc: JSON.parse(out.stdout) }
}

const ask: FakeStep[] = [
  { do: 'output', text: '要基于哪个分支？' },
  { do: 'idle' },
  { do: 'await_reply' },
]

setDefaultTimeout(20_000)

describe('task_reply', () => {
  test('flow task reply <id> 文字：送达后任务完成，回复者为 user', async () => {
    const id = await create(ask)
    await until(id, (t) => t.status === 'blocked', 'blocked')
    const r = await cli(id, '用', 'main', '分支')
    expect(r.code).toBe(0)
    expect(r.doc.data).toMatchObject({
      requeued: false,
      reply: { kind: 'text', text: '用 main 分支', by: 'user', state: 'pending' },
    })
    await until(id, (t) => t.status === 'done', 'done')
    const shown = data(await client().showTask(id))
    expect(shown.replies).toMatchObject([{ state: 'delivered', by: 'user' }])
    expect(shown.events.map((e) => e.type).slice(-3)).toEqual([
      'task.replied',
      'task.unblocked',
      'task.done',
    ])
    expect(taskReplyOp.human?.(r.doc.data)).toContain('下一次续约')
  })

  test('对提问点了批准：reply_kind_mismatch（退出码 1）；--approve 用于授权请求', async () => {
    const id = await create(ask)
    await until(id, (t) => t.status === 'blocked', 'blocked')
    const r = await cli(id, '--approve')
    expect(r.code).toBe(1)
    expect(r.doc.error.code).toBe('reply_kind_mismatch')

    const approval = await create([
      { do: 'output', text: 'Allow command `git push`? [y/n]' },
      { do: 'idle' },
      { do: 'await_reply' },
    ])
    await until(approval, (t) => t.blocked?.reason === 'awaiting_approval', 'awaiting_approval')
    const denied = await cli(approval, '--deny', '不要推送')
    expect(denied.code).toBe(0)
    expect(denied.doc.data.reply).toMatchObject({ kind: 'deny', text: '不要推送' })
    await until(approval, (t) => t.status === 'done', 'done')
  })

  test('对运行中的任务回复：not_blocked，账本不新增事件', async () => {
    const id = await create([{ do: 'hang', ignore_cancel: false }])
    await until(id, (t) => t.status === 'running', 'running')
    const before = data(await client().showTask(id)).events.length
    const r = await cli(id, '好的')
    expect(r.code).toBe(1)
    expect(r.doc.error.code).toBe('not_blocked')
    expect(data(await client().showTask(id)).events.length).toBe(before)
    data(await client().cancelTask(id))
  })

  test('用法错误：approve 与 deny 同时给出、批准附带文字、什么都没给', async () => {
    for (const args of [['t-x', '--approve', '--deny'], ['t-x', '--approve', '好的'], ['t-x']]) {
      const r = await cli(...args)
      expect(r.code).toBe(2)
      expect(r.doc.error.code).toBe('invalid_arguments')
    }
  })

  test('防止 AI 自批：MCP 一律 user_only，CLI 的 --actor 非 user 也拒绝，中枢同样校验（审查第 2 条）', async () => {
    const id = await create([
      { do: 'output', text: 'Allow command `git push`? [y/n]' },
      { do: 'idle' },
      { do: 'await_reply' },
    ])
    await until(id, (t) => t.blocked?.reason === 'awaiting_approval', 'awaiting_approval')
    const before = data(await client().showTask(id)).events.length
    const mcp = await connect({ home, actor: 'agent:worker' })
    try {
      const r = await callJson(mcp, 'task_reply', { id, approve: true })
      expect(r.doc).toMatchObject({ ok: false, error: { code: 'user_only' } })
    } finally {
      await mcp.close()
    }
    const viaCli = await runCli(
      ['task', 'reply', id, '--approve', '--actor', 'agent:worker', '--json'],
      commands,
    )
    expect(viaCli.exitCode).toBe(1)
    expect(JSON.parse(viaCli.stdout).error.code).toBe('user_only')
    // 绕过操作直接调用中枢：中枢也拒绝非 user 的回复。
    const direct = await new HubClient({ home, actor: 'agent:worker' }).replyTask(id, {
      kind: 'approve',
    })
    expect(direct.ok ? 'ok' : direct.error.code).toBe('user_only')
    expect(data(await client().showTask(id)).events.length).toBe(before)
    // 人可以批准。
    const viaOp = await invokeOperation(
      taskReplyOp,
      { id, approve: true },
      { home, actor: 'user', via: 'cli' },
    )
    expect(viaOp.ok).toBe(true)
    await until(id, (t) => t.status === 'done', 'done')
  })
})
