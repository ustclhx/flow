import { afterEach, expect, test } from 'bun:test'
import { NO_ADAPTER_CAPABILITIES, ok, type Result } from '@raindown/core'
import { createInboxReactor } from '@raindown/hub'
import {
  ActivityQueue,
  type ExecutorOutcome,
  type ExecutorPlugin,
  idleSignal,
  resumedSignal,
} from '../src/executor.ts'
import { type Bench, bench } from './harness.ts'

let current: Bench | undefined
afterEach(async () => {
  await current?.close()
  current = undefined
})

test('续约先绑定卡住seq再投递；round_closed确认一次后保留blocked且不重新委托', async () => {
  const activity = new ActivityQueue()
  const calls: string[] = []
  let finish: (outcome: Result<ExecutorOutcome>) => void = () => {}
  const done = new Promise<Result<ExecutorOutcome>>((resolve) => {
    finish = resolve
  })
  const executor: ExecutorPlugin = {
    type: 'probe',
    adapterCapabilities: NO_ADAPTER_CAPABILITIES,
    classify: () => ({ reason: 'awaiting_approval', message: '等待授权' }),
    run: () => ({
      activity,
      done,
      bindBlocked(binding) {
        calls.push(`bind:${binding.seq}:${binding.request_id}`)
      },
      async deliver(reply) {
        calls.push(`deliver:${reply.block_seq}`)
        return { outcome: 'dropped', reason: 'round_closed' }
      },
      async cancel() {
        activity.close()
        finish(ok({ outcome: 'cancelled' }))
      },
    }),
  }
  const ackBodies: unknown[] = []
  const b = await bench({ executors: [executor] }, 60, (url, init) => {
    if (url.endsWith('/ack-reply')) ackBodies.push(JSON.parse(String(init?.body)))
    return undefined
  })
  current = b
  const id = await b.create({ executor: 'probe' })
  const unsub = b.ledger.subscribe((event) => {
    if (event.type !== 'task.blocked' || event.task_id !== id) return
    // 模拟用户足够快，卡住确认与其回复在同一续约响应到达节点。
    const written = b.ledger.append(
      {
        type: 'task.replied',
        task_id: id,
        workspace: b.task(id).workspace,
        payload: { reply_id: 'r-fast', kind: 'approve' },
      },
      { actor: 'user' },
    )
    if (!written.ok) throw new Error(written.error.message)
  })
  activity.push(
    idleSignal(new Date(b.clock.now()).toISOString(), '等待授权', { request_id: 'round-local' }),
  )
  await b.until(id, () => b.types(id).includes('task.reply_dropped'))
  unsub()
  const block = b.events(id).find((event) => event.type === 'task.blocked')
  expect(calls).toEqual([`bind:${block?.seq}:round-local`, `deliver:${block?.seq}`])
  expect(ackBodies).toMatchObject([
    { reply_id: 'r-fast', outcome: 'dropped', reason: 'round_closed' },
  ])
  await b.clock.advance(120_000)
  activity.push(
    idleSignal(new Date(b.clock.now()).toISOString(), '仍在等授权', { request_id: 'round-local' }),
  )
  await b.clock.advance(60_000)
  expect(b.task(id).status).toBe('blocked')
  expect(b.types(id).filter((type) => type === 'task.blocked')).toHaveLength(1)
  expect(b.types(id)).not.toContain('task.unblocked')
  expect(b.ledger.getReply('r-fast')?.state).toBe('dropped')
  expect(calls).toHaveLength(2)
  expect(ackBodies).toHaveLength(1)
})

test('round_closed确认临时失败时仍上报自行恢复，拒收通知最终送达且新回合仍可卡住', async () => {
  const activity = new ActivityQueue()
  let finish: (outcome: Result<ExecutorOutcome>) => void = () => {}
  const done = new Promise<Result<ExecutorOutcome>>((resolve) => {
    finish = resolve
  })
  const executor: ExecutorPlugin = {
    type: 'probe',
    adapterCapabilities: NO_ADAPTER_CAPABILITIES,
    classify: () => ({ reason: 'awaiting_approval', message: '等待授权' }),
    run: () => ({
      activity,
      done,
      async deliver() {
        return { outcome: 'dropped', reason: 'round_closed' }
      },
      async cancel() {
        activity.close()
        finish(ok({ outcome: 'cancelled' }))
      },
    }),
  }
  let acknowledgements = 0
  const b = await bench({ executors: [executor] }, 60, (url) => {
    if (url.endsWith('/ack-reply') && ++acknowledgements === 1) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: { kind: 'retryable', code: 'hub_busy', message: '稍后重试' },
        }),
        { status: 503 },
      )
    }
    return undefined
  })
  current = b
  const reactor = createInboxReactor({ ledger: b.ledger })
  reactor.start()
  try {
    const id = await b.create({ executor: 'probe' })
    activity.push(
      idleSignal(new Date(b.clock.now()).toISOString(), '等待授权', { request_id: 'round-old' }),
    )
    await b.until(id, (task) => task.status === 'blocked')
    expect(b.tasks.replyTask(id, { kind: 'approve' }, { actor: 'user' }).ok).toBe(true)
    await b.until(id, () => acknowledgements === 1)
    activity.push(resumedSignal(new Date(b.clock.now()).toISOString(), '终端自行恢复'))
    await b.until(id, (task) => task.status === 'running', 60_000)
    await b.until(id, () => b.types(id).includes('task.reply_dropped'), 60_000)
    await reactor.idle()
    expect(acknowledgements).toBe(2)
    expect(b.ledger.listInboxItems({ source: 'reply_delivery', state: 'open' })).toMatchObject([
      { level: 'interrupt', reason: 'round_closed' },
    ])
    activity.push(
      idleSignal(new Date(b.clock.now()).toISOString(), '新的授权', { request_id: 'round-new' }),
    )
    await b.until(id, (task) => task.status === 'blocked')
    expect(b.events(id).filter((event) => event.type === 'task.blocked')).toHaveLength(2)
    expect(b.events(id).filter((event) => event.type === 'task.unblocked')).toHaveLength(1)
  } finally {
    reactor.stop()
  }
})
