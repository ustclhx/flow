import { afterEach, describe, expect, test } from 'bun:test'
import type { TaskContractInput, WakeOrigin } from '@flow/core'
import { type Bench, bench, fake } from './harness.ts'

/**
 * 预留执行槽（add-m1-supervisor 5.5；design D12；node-protocol "supervisor 预留执行槽"）：
 * 真实的中枢路由 + 节点领取循环 + fake 执行器。唤醒任务按 G1 的 `withCreated` 由 hub
 * 同时写入 `task.created` 与 `supervisor.wake_started`（唤醒身份以后者为准）。
 */

let current: Bench | undefined
afterEach(async () => {
  await current?.close()
  current = undefined
})
const open = async (...args: Parameters<typeof bench>) => {
  current = await bench(...args)
  return current
}

/** 停在提问、持有租约直到收到回复（代表卡住的交互式 dev 任务）。 */
const stuck = () =>
  fake({
    script: [{ do: 'output', text: '要基于哪个分支？' }, { do: 'idle' }, { do: 'await_reply' }],
  })

const generations = new Map<string, number>()

async function wake(
  b: Bench,
  origin: WakeOrigin,
  workspace = 'ws/demo',
  over: Partial<TaskContractInput> = {},
): Promise<string> {
  const generation = (generations.get(workspace) ?? 0) + 1
  generations.set(workspace, generation)
  const r = await b.tasks.createTask(
    {
      goal: `唤醒（${origin}）`,
      workspace,
      role: 'supervisor',
      executor: 'fake',
      cwd: b.home,
      ...over,
    },
    {
      actor: 'hub',
      withCreated: (id) => [
        {
          task_id: id,
          workspace,
          type: 'supervisor.wake_started',
          payload: { task_id: id, workspace, origin, events: [], generation },
        },
      ],
    },
  )
  if (!r.ok) throw new Error(r.error.message)
  await b.clock.advance(0)
  return r.data.task.id
}

afterEach(() => generations.clear())

describe('节点预留执行槽', () => {
  test('concurrency: 1 的 dev 任务卡住并持有租约时，普通唤醒仍被领取并运行', async () => {
    const b = await open({ concurrency: 1 })
    const dev = await b.create(stuck())
    await b.until(dev, (t) => t.status === 'blocked')
    expect(b.task(dev).blocked).toMatchObject({ lease_held: true })

    const other = await b.create(fake({}))
    const w = await wake(b, 'instruction')
    await b.until(w, (t) => t.status === 'done', 60_000)
    expect(b.node.active()).toBe(1)
    // 普通槽仍被卡住的 dev 任务占着：普通任务不会占用预留槽
    expect(b.task(other).status).toBe('queued')
    expect(b.task(dev).status).toBe('blocked')
  })

  test('reply 槽只给 reply 唤醒：supervisor 槽被占满时，普通唤醒排队、reply 唤醒仍能运行', async () => {
    const b = await open({ concurrency: 1 })
    const dev = await b.create(stuck())
    await b.until(dev, (t) => t.status === 'blocked')
    // 两个 workspace 的普通唤醒：第一个占住 supervisor 槽（卡住不结束），第二个只能排队
    const a = await wake(b, 'instruction', 'ws/a', stuck())
    await b.until(a, (t) => t.status === 'blocked')
    const bWake = await wake(b, 'autonomous', 'ws/b')
    const r = await wake(b, 'reply', 'ws/a')
    await b.until(r, (t) => t.status === 'done', 60_000)
    expect(b.task(bWake).status).toBe('queued')
    expect(b.node.active()).toBe(2)
  })

  test('reply 唤醒在 reply 槽被占时可用普通空位', async () => {
    const b = await open({ concurrency: 1, reserved: { supervisor: 1, reply: 1 } })
    const r1 = await wake(b, 'reply', 'ws/a', stuck())
    await b.until(r1, (t) => t.status === 'blocked')
    const r2 = await wake(b, 'reply', 'ws/b')
    await b.until(r2, (t) => t.status === 'done', 60_000)
  })

  test('reserved 为 0 时没有预留槽：dev 任务卡住期间唤醒排队（原有并发语义）', async () => {
    const b = await open({ concurrency: 1, reserved: { supervisor: 0, reply: 0 } })
    const dev = await b.create(stuck())
    await b.until(dev, (t) => t.status === 'blocked')
    const w = await wake(b, 'instruction')
    await b.clock.advance(60_000)
    expect(b.task(w).status).toBe('queued')
  })

  test('预留槽结束后可以再次领取唤醒；普通任务结束后普通槽也恢复', async () => {
    const b = await open({ concurrency: 1 })
    const w1 = await wake(b, 'instruction')
    await b.until(w1, (t) => t.status === 'done', 60_000)
    const w2 = await wake(b, 'autonomous')
    await b.until(w2, (t) => t.status === 'done', 60_000)
    const d = await b.create(fake({}))
    await b.until(d, (t) => t.status === 'done', 60_000)
    expect(b.node.active()).toBe(0)
  })
})
