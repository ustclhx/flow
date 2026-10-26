import { afterEach, describe, expect, test } from 'bun:test'
import type { TaskContractInput, WakeOrigin } from '@flow/core'
import { rejectsField } from '../src/node.ts'
import { type Bench, bench, fake, type Intercept } from './harness.ts'

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

  test('空闲节点上卡住的普通唤醒占 supervisor 槽，之后的 dev 任务仍能领到普通槽', async () => {
    const b = await open({ concurrency: 1 })
    const w = await wake(b, 'instruction', 'ws/demo', stuck())
    await b.until(w, (t) => t.status === 'blocked')
    const d = await b.create(fake({}))
    await b.until(d, (t) => t.status === 'done', 60_000)
    expect(b.task(w).status).toBe('blocked')
  })

  test('普通槽满时，预留槽的租约结束后能再次领取唤醒', async () => {
    const b = await open({ concurrency: 1 })
    const dev = await b.create(stuck())
    await b.until(dev, (t) => t.status === 'blocked')
    const w1 = await wake(b, 'instruction')
    await b.until(w1, (t) => t.status === 'done', 60_000)
    const w2 = await wake(b, 'autonomous')
    await b.until(w2, (t) => t.status === 'done', 60_000)
    const r = await wake(b, 'reply')
    await b.until(r, (t) => t.status === 'done', 60_000)
    expect(b.task(dev).status).toBe('blocked')
  })

  test('节点停止时三个 long-poll 都被中止', async () => {
    const b = await open({ concurrency: 1 })
    await b.clock.advance(0)
    expect(b.protocol.service.waiting()).toBe(3)
    await b.node.stop()
    await b.clock.advance(0)
    expect(b.protocol.service.waiting()).toBe(0)
  })
})

describe('中枢不接受 slots（旧中枢）', () => {
  /** 模拟旧中枢的 strict 校验：带 slots 的领取请求返回 invalid_arguments。 */
  const rejectSlots: Intercept = (url, init) => {
    if (!url.endsWith('/v1/leases') || !String(init?.body ?? '').includes('"slots"')) return
    return Response.json(
      {
        ok: false,
        error: {
          kind: 'usage',
          code: 'invalid_arguments',
          message: '领取请求不合法：Unrecognized key: "slots"',
          retryable: false,
          // 与旧中枢 `parse` 的 details 相同：逐字段问题，未知字段没有 field，只在 message 中。
          details: [{ code: 'invalid_field', message: 'Unrecognized key: "slots"' }],
        },
      },
      { status: 400 },
    )
  }

  test('普通任务照常领取，预留槽循环只告警一次并长退避，中枢升级后自动恢复', async () => {
    const warns: string[] = []
    let upgraded = false
    const logger = { info() {}, warn: (m: string) => void warns.push(m) }
    const b = await open({ concurrency: 1, logger, slotsRetryMs: 300_000 }, 60, (url, init) =>
      upgraded ? undefined : rejectSlots(url, init),
    )
    const d = await b.create(fake({}))
    await b.until(d, (t) => t.status === 'done', 60_000)
    await b.clock.advance(20 * 60_000)
    const slotWarns = warns.filter((m) => m.includes('slots'))
    // supervisor 与 reply 各一次，不随重试刷屏；也没有其他告警
    expect(slotWarns).toHaveLength(2)
    expect(warns).toHaveLength(2)
    // 普通循环不带 slots：旧中枢上也能领取唤醒（落到普通槽）
    const w = await wake(b, 'instruction')
    await b.until(w, (t) => t.status === 'done', 60_000)

    // 中枢升级后，下一次重试起预留槽恢复：dev 卡住占满普通槽时唤醒仍能运行
    upgraded = true
    const dev = await b.create(stuck())
    await b.until(dev, (t) => t.status === 'blocked')
    const w2 = await wake(b, 'instruction')
    await b.until(w2, (t) => t.status === 'done', 10 * 60_000)
    expect(warns).toHaveLength(2)
  })
})

describe('rejectsField：只有 details 提到 slots 才当作旧中枢', () => {
  test.each([
    [[{ code: 'invalid_field', message: 'Unrecognized key: "slots"' }], true],
    [[{ code: 'invalid_field', field: 'slots.general', message: '字段 slots.general：类型错误' }], true],
    [[{ code: 'invalid_field', field: 'wait_s', message: '字段 wait_s：类型错误' }], false],
    [[{ code: 'invalid_field', message: 'Unrecognized key: "reserved_slots"' }], false],
    [undefined, false],
    ['slots', false],
  ] as const)('%j → %p', (details, expected) => {
    expect(rejectsField({ code: 'invalid_arguments', details }, 'slots')).toBe(expected)
  })

  test('错误码不是 invalid_arguments 时不当作旧中枢', () => {
    expect(
      rejectsField(
        { code: 'node_not_registered', details: [{ message: 'Unrecognized key: "slots"' }] },
        'slots',
      ),
    ).toBe(false)
  })
})
