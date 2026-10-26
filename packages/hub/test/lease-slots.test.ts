import { afterEach, describe, expect, test } from 'bun:test'
import type { LeaseSlots, TaskContractInput, WakeOrigin } from '@flow/core'
import {
  createNodeProtocol,
  createTaskService,
  type LedgerStore,
  type NodeProtocol,
} from '../src/index.ts'
import { anyRole, contractInput, tempLedger, WS } from './ledger-helpers.ts'
import { FakeClock, tick } from './server-fixtures.ts'

/**
 * 中枢按执行槽类别分配租约（add-m1-supervisor 5.5；design D12）。
 * 唤醒身份以账本 `supervisor.wake_started` 为准，不看角色名或 inputs。
 */

interface Ctx {
  ledger: LedgerStore
  protocol: NodeProtocol
  dev(over?: Partial<TaskContractInput>): Promise<string>
  wake(origin: WakeOrigin, workspace?: string, over?: Partial<TaskContractInput>): Promise<string>
  acquire(slots?: LeaseSlots, waitS?: number): Promise<string | null>
}

let cleanups: Array<() => void> = []
afterEach(() => {
  for (const c of cleanups) c()
  cleanups = []
})

async function setup(): Promise<Ctx> {
  const clock = new FakeClock(Date.parse('2026-10-26T08:00:00.000Z'))
  const t = await tempLedger({ now: clock.now })
  const protocol = createNodeProtocol({ ledger: t.store, clock, leaseTtlS: 60, leaseWaitMaxS: 30 })
  cleanups.push(() => {
    protocol.stop()
    t.cleanup()
  })
  const tasks = createTaskService({
    ledger: t.store,
    workspaceExists: () => true,
    roles: anyRole,
    now: clock.now,
  })
  const generations = new Map<string, number>()
  const reg = protocol.service.registerNode(
    { node_id: 'n1', hostname: 'h', version: '0', capabilities: ['executor:fake'] },
    'unknown',
  )
  if (!reg.ok) throw new Error(reg.error.message)
  return {
    ledger: t.store,
    protocol,
    async dev(over = {}) {
      const r = await tasks.createTask(contractInput(over), { actor: 'user' })
      if (!r.ok) throw new Error(r.error.message)
      return r.data.task.id
    },
    async wake(origin, workspace = WS, over = {}) {
      const generation = (generations.get(workspace) ?? 0) + 1
      generations.set(workspace, generation)
      const r = await tasks.createTask(contractInput({ role: 'supervisor', workspace, ...over }), {
        actor: 'hub',
        withCreated: (id) => [
          {
            task_id: id,
            workspace,
            type: 'supervisor.wake_started',
            payload: { task_id: id, workspace, origin, events: [], generation },
          },
        ],
      })
      if (!r.ok) throw new Error(r.error.message)
      return r.data.task.id
    },
    async acquire(slots, waitS = 0) {
      const r = await protocol.service.acquire({
        node_id: 'n1',
        capabilities: ['executor:fake'],
        wait_s: waitS,
        ...(slots ? { slots } : {}),
      })
      if (!r.ok) throw new Error(r.error.message)
      return r.data.lease?.task_id ?? null
    },
  }
}

const slots = (over: Partial<LeaseSlots>): LeaseSlots => ({
  general: 0,
  supervisor: 0,
  reply: 0,
  ...over,
})

describe('按执行槽类别分配', () => {
  test('旧节点（不带 slots）：按创建顺序分配任何任务，包括唤醒', async () => {
    const c = await setup()
    const d = await c.dev()
    const w = await c.wake('instruction')
    const r = await c.wake('reply', 'ws/other')
    expect(await c.acquire()).toBe(d)
    expect(await c.acquire()).toBe(w)
    expect(await c.acquire()).toBe(r)
  })

  test('只有 supervisor 空位：跳过排在前面的普通任务与 reply 唤醒，领到普通唤醒', async () => {
    const c = await setup()
    await c.dev()
    await c.wake('reply', 'ws/r')
    const w = await c.wake('autonomous')
    expect(await c.acquire(slots({ supervisor: 1 }))).toBe(w)
    expect(await c.acquire(slots({ supervisor: 1 }))).toBeNull()
  })

  test('只有 reply 空位：普通唤醒与普通任务都不分配，reply 唤醒可以', async () => {
    const c = await setup()
    await c.dev()
    await c.wake('instruction', 'ws/a')
    await c.wake('autonomous', 'ws/b')
    expect(await c.acquire(slots({ reply: 1 }))).toBeNull()
    const r = await c.wake('reply', 'ws/a')
    expect(await c.acquire(slots({ reply: 1 }))).toBe(r)
  })

  test('普通空位可以接任何类别；角色名叫 supervisor 但没有 wake_started 的任务按普通任务处理', async () => {
    const c = await setup()
    const fakeWake = await c.dev({ role: 'supervisor' })
    expect(await c.acquire(slots({ supervisor: 1, reply: 1 }))).toBeNull()
    expect(await c.acquire(slots({ general: 1 }))).toBe(fakeWake)
    const w = await c.wake('instruction')
    const r = await c.wake('reply', 'ws/x')
    expect(await c.acquire(slots({ general: 1 }))).toBe(w)
    expect(await c.acquire(slots({ general: 1 }))).toBe(r)
  })

  test('两个 workspace 的普通唤醒占满 supervisor 槽时，reply 唤醒仍能领取', async () => {
    const c = await setup()
    const a = await c.wake('instruction', 'ws/a')
    const b = await c.wake('instruction', 'ws/b')
    expect(await c.acquire(slots({ supervisor: 1 }))).toBe(a)
    // supervisor 槽已满（节点只上报 reply 空位），ws/b 的普通唤醒排在前面也领不到
    const r = await c.wake('reply', 'ws/a')
    expect(await c.acquire(slots({ reply: 1 }))).toBe(r)
    expect(c.ledger.getTask(b)?.status).toBe('queued')
  })

  test('long-poll 等待者按 slots 过滤：新建的普通任务不唤醒只有 supervisor 空位的等待', async () => {
    const c = await setup()
    const waiting = c.acquire(slots({ supervisor: 1 }), 30)
    await tick()
    expect(c.protocol.service.waiting()).toBe(1)
    const d = await c.dev()
    await tick()
    expect(c.protocol.service.waiting()).toBe(1)
    const w = await c.wake('instruction')
    expect(await waiting).toBe(w)
    expect(c.ledger.getTask(d)?.status).toBe('queued')
  })
})

describe('预留槽等待者优先接唤醒', () => {
  test('不带 slots 的普通领取先把唤醒让给同一节点等待中的预留槽，自己继续领下一个任务', async () => {
    const c = await setup()
    const sup = c.acquire(slots({ supervisor: 1 }), 30)
    const rep = c.acquire(slots({ reply: 1 }), 30)
    await tick()
    expect(c.protocol.service.waiting()).toBe(2)
    const w = await c.wake('instruction')
    const r = await c.wake('reply', 'ws/r')
    const d = await c.dev()
    // drain 已在微任务中把唤醒分给预留槽等待者
    expect(await sup).toBe(w)
    expect(await rep).toBe(r)
    expect(await c.acquire()).toBe(d)
  })

  test('普通等待者排在前面时，唤醒仍分给同一节点后到的 supervisor 等待者', async () => {
    const c = await setup()
    const gen = c.acquire(undefined, 30)
    const sup = c.acquire(slots({ supervisor: 1 }), 30)
    await tick()
    expect(c.protocol.service.waiting()).toBe(2)
    const w = await c.wake('instruction')
    expect(await sup).toBe(w)
    await tick()
    expect(c.protocol.service.waiting()).toBe(1)
    const d = await c.dev()
    expect(await gen).toBe(d)
  })

  test('同一节点没有预留槽等待者时，唤醒落到普通领取', async () => {
    const c = await setup()
    const rep = c.acquire(slots({ reply: 1 }), 30)
    await tick()
    const w = await c.wake('autonomous')
    // reply 等待者不能接普通唤醒，普通领取照常拿到它
    expect(await c.acquire()).toBe(w)
    expect(c.protocol.service.waiting()).toBe(1)
    const r = await c.wake('reply')
    expect(await rep).toBe(r)
  })

  test('等待者被中止后 waiting() 归零', async () => {
    const c = await setup()
    const ac = new AbortController()
    const p = c.protocol.service.acquire(
      { node_id: 'n1', capabilities: ['executor:fake'], wait_s: 30, slots: slots({ reply: 1 }) },
      { signal: ac.signal },
    )
    await tick()
    expect(c.protocol.service.waiting()).toBe(1)
    ac.abort()
    expect(await p).toMatchObject({ ok: true, data: { lease: null } })
    expect(c.protocol.service.waiting()).toBe(0)
  })
})
