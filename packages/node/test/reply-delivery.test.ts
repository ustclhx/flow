import { afterEach, expect, test } from 'bun:test'
import { type DeliveredReply, NO_ADAPTER_CAPABILITIES, ok, type Result } from '@raindown/core'
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

test('round_closed确认临时失败后自行恢复丢弃回复，重试不再追加拒收通知', async () => {
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
    await b.until(id, () => acknowledgements === 2, 60_000)
    await reactor.idle()
    expect(acknowledgements).toBe(2)
    expect(b.types(id)).not.toContain('task.reply_dropped')
    expect(b.ledger.listInboxItems({ source: 'reply_delivery', state: 'open' })).toHaveLength(0)
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

for (const resumedInFlight of [false, true]) {
  test(`${resumedInFlight ? '恢复信号发送失败' : '恢复信号尚未发送'}时保留后续blocked的FIFO，绑定新回合seq`, async () => {
    const activity = new ActivityQueue()
    const bindings: Array<{ seq: number; request_id: string }> = []
    let finish: (value: Result<ExecutorOutcome>) => void = () => {}
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
        bindBlocked: (binding) => {
          bindings.push(binding)
        },
        async cancel() {
          activity.close()
          finish(ok({ outcome: 'cancelled' }))
        },
      }),
    }
    let holdNext = false
    let release = () => {}
    const b = await bench({ executors: [executor] }, 60, (url) => {
      if (holdNext && url.endsWith('/renew')) {
        holdNext = false
        return new Response(
          new ReadableStream({
            start(controller) {
              release = () => {
                controller.enqueue(
                  new TextEncoder().encode(
                    JSON.stringify({
                      ok: false,
                      error: { kind: 'retryable', code: 'hub_busy', message: '稍后重试' },
                    }),
                  ),
                )
                controller.close()
              }
            },
          }),
          { status: 503 },
        )
      }
      return undefined
    })
    current = b
    const id = await b.create({ executor: 'probe' })
    activity.push(
      idleSignal(new Date(b.clock.now()).toISOString(), '旧授权', { request_id: 'old' }),
    )
    await b.until(id, (task) => task.status === 'blocked')
    holdNext = true
    if (resumedInFlight) {
      activity.push(resumedSignal(new Date(b.clock.now()).toISOString(), '旧回合结束'))
      await b.clock.advance(0)
    } else {
      await b.clock.advance(20_000)
      activity.push(resumedSignal(new Date(b.clock.now()).toISOString(), '旧回合结束'))
    }
    activity.push(
      idleSignal(new Date(b.clock.now()).toISOString(), '新授权', { request_id: 'new' }),
    )
    await b.clock.advance(0)
    release()
    await b.until(id, () => bindings.some((binding) => binding.request_id === 'new'), 60_000)
    const transitions = b
      .events(id)
      .filter((event) => event.type === 'task.blocked' || event.type === 'task.unblocked')
    expect(transitions.map((event) => event.type)).toEqual([
      'task.blocked',
      'task.unblocked',
      'task.blocked',
    ])
    const [oldBlocked, , newBlocked] = transitions
    if (!oldBlocked || !newBlocked) throw new Error('缺少新旧授权回合的 blocked 事件')
    expect(bindings).toEqual([
      { seq: oldBlocked.seq, request_id: 'old' },
      { seq: newBlocked.seq, request_id: 'new' },
    ])
  })
}

test('恢复回复同步拒收且确认临时失败时，结束前重试ack一次并通知', async () => {
  let runs = 0
  const executor: ExecutorPlugin = {
    type: 'probe',
    adapterCapabilities: NO_ADAPTER_CAPABILITIES,
    run: (_contract, ctx) => {
      const activity = new ActivityQueue()
      activity.close()
      if (++runs === 1)
        return {
          activity,
          done: Promise.resolve(
            ok({
              outcome: 'blocked',
              reason: 'awaiting_approval',
              message: '授权等待恢复',
              session: 'old-session',
            }),
          ),
          async cancel() {},
        }
      ctx.reportResumeReplyDropped?.({ attempted: true })
      ctx.reportResumeReplyDropped?.({ attempted: true })
      return {
        activity,
        async cancel() {},
        done: Promise.resolve(
          ok({
            outcome: 'done',
            result: {
              summary: '结束',
              artifacts: [],
              verify: [],
              executor: 'probe',
              node_id: ctx.nodeId,
            },
          }),
        ),
      }
    },
  }
  let acknowledgements = 0
  const ackBodies: unknown[] = []
  const b = await bench({ executors: [executor] }, 60, (url, init) => {
    if (!url.endsWith('/ack-reply')) return undefined
    ackBodies.push(JSON.parse(String(init?.body)))
    if (++acknowledgements === 1)
      return new Response(
        JSON.stringify({
          ok: false,
          error: { kind: 'retryable', code: 'hub_busy', message: '稍后重试' },
        }),
        { status: 503 },
      )
    return undefined
  })
  current = b
  const reactor = createInboxReactor({ ledger: b.ledger })
  reactor.start()
  try {
    const id = await b.create({ executor: 'probe' })
    await b.until(id, (task) => task.status === 'blocked')
    expect(b.tasks.replyTask(id, { kind: 'approve' }, { actor: 'user' }).ok).toBe(true)
    await b.until(id, (task) => task.status === 'done', 60_000)
    await reactor.idle()
    expect(acknowledgements).toBe(2)
    expect(ackBodies).toMatchObject([
      { outcome: 'dropped', reason: 'round_closed', attempted: true },
      { outcome: 'dropped', reason: 'round_closed', attempted: true },
    ])
    expect(b.events(id).filter((event) => event.type === 'task.reply_dropped')).toHaveLength(1)
    expect(b.ledger.taskReplies(id)[0]?.state).toBe('dropped')
    const notifications = b.ledger.listInboxItems({ source: 'reply_delivery', state: 'open' })
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.title).toContain('可能没有送达')
    expect(notifications[0]?.body).toContain('可能没有送达')
  } finally {
    reactor.stop()
  }
})

test('已尝试但无法确认的普通回复经ack通知可能没有送达', async () => {
  const activity = new ActivityQueue()
  let finish: (value: Result<ExecutorOutcome>) => void = () => {}
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
        return { outcome: 'dropped', reason: 'round_closed', attempted: true }
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
  const reactor = createInboxReactor({ ledger: b.ledger })
  reactor.start()
  try {
    const id = await b.create({ executor: 'probe' })
    activity.push(idleSignal(new Date(b.clock.now()).toISOString(), '等待授权'))
    await b.until(id, (task) => task.status === 'blocked')
    expect(b.tasks.replyTask(id, { kind: 'approve' }, { actor: 'user' }).ok).toBe(true)
    await b.until(id, () => b.types(id).includes('task.reply_dropped'))
    await reactor.idle()
    expect(ackBodies).toMatchObject([
      { outcome: 'dropped', reason: 'round_closed', attempted: true },
    ])
    const notifications = b.ledger.listInboxItems({ source: 'reply_delivery', state: 'open' })
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.title).toContain('可能没有送达')
    expect(notifications[0]?.body).toContain('可能没有送达')
    expect(b.task(id).status).toBe('blocked')
  } finally {
    reactor.stop()
  }
})

for (const fingerprint of ['a1'.repeat(32), 'A1'.repeat(32), 'a'.repeat(63)]) {
  const valid = fingerprint === 'a1'.repeat(32)
  test(`${valid ? '合法' : '非法'}授权指纹从idle提示经账本、普通回复与恢复回复传递`, async () => {
    const activity = new ActivityQueue()
    const delivered: DeliveredReply[] = []
    const resumed: DeliveredReply[] = []
    let runs = 0
    let finish: (value: Result<ExecutorOutcome>) => void = () => {}
    const done = new Promise<Result<ExecutorOutcome>>((resolve) => {
      finish = resolve
    })
    const executor: ExecutorPlugin = {
      type: 'probe',
      adapterCapabilities: NO_ADAPTER_CAPABILITIES,
      classify: () => ({ reason: 'awaiting_approval', message: `Bearer ${fingerprint}` }),
      run: (_contract, ctx) => {
        if (++runs === 1)
          return {
            activity,
            done,
            async deliver(reply) {
              delivered.push(reply)
              return 'not_running'
            },
            async cancel() {
              activity.close()
              finish(ok({ outcome: 'cancelled' }))
            },
          }
        if (ctx.resume?.reply) resumed.push(ctx.resume.reply)
        const closed = new ActivityQueue()
        closed.close()
        return {
          activity: closed,
          done: Promise.resolve(
            ok({
              outcome: 'done',
              result: {
                summary: '恢复结束',
                artifacts: [],
                verify: [],
                executor: 'probe',
                node_id: ctx.nodeId,
              },
            }),
          ),
          async cancel() {},
        }
      },
    }
    const b = await bench({ executors: [executor] })
    current = b
    const id = await b.create({ executor: 'probe' })
    activity.push({
      ts: new Date(b.clock.now()).toISOString(),
      kind: 'output',
      text: `Bearer ${fingerprint}`,
    })
    activity.push(
      idleSignal(new Date(b.clock.now()).toISOString(), `Bearer ${fingerprint}`, {
        request_id: 'round-with-fingerprint',
        session: 'session-with-fingerprint',
        approval_fingerprint: fingerprint,
      }),
    )
    await b.until(id, (task) => task.status === 'blocked')
    const blocked = b.events(id).find((event) => event.type === 'task.blocked')
    if (blocked?.type !== 'task.blocked') throw new Error('缺少卡住事件')
    expect(blocked.payload.approval_fingerprint).toBe(valid ? fingerprint : undefined)
    expect(blocked.payload.message).not.toContain(fingerprint)
    expect(blocked.payload.tail?.join('\n')).not.toContain(fingerprint)
    expect(b.tasks.replyTask(id, { kind: 'approve' }, { actor: 'user' }).ok).toBe(true)
    await b.until(id, (task) => task.status === 'done', 60_000)
    expect(delivered).toHaveLength(1)
    expect(resumed).toHaveLength(1)
    for (const reply of [...delivered, ...resumed]) {
      expect(reply.block_seq).toBe(blocked.seq)
      expect(reply.approval_fingerprint).toBe(valid ? fingerprint : undefined)
    }
  })
}

test('已尝试的request_changed拒收保留D15恢复与下一轮no_delegate语义', async () => {
  const activity = new ActivityQueue()
  let finish: (value: Result<ExecutorOutcome>) => void = () => {}
  const done = new Promise<Result<ExecutorOutcome>>((resolve) => {
    finish = resolve
  })
  const executor: ExecutorPlugin = {
    type: 'probe',
    adapterCapabilities: NO_ADAPTER_CAPABILITIES,
    classify: () => ({ reason: 'awaiting_approval', message: '等待授权' }),
    run: (_contract, ctx) => {
      void ctx.precheck?.({ tool: 'Read', command: 'cat README.md' }).then((verdict) => {
        activity.push(
          idleSignal(new Date().toISOString(), '等待授权', {
            ...(!verdict.allow ? { decision_id: verdict.decision_id } : {}),
          }),
        )
      })
      return {
        activity,
        done,
        async deliver() {
          return { outcome: 'dropped', reason: 'request_changed', attempted: true }
        },
        async cancel() {
          activity.close()
          finish(ok({ outcome: 'cancelled' }))
        },
      }
    },
  }
  const ackBodies: unknown[] = []
  const b = await bench(
    { executors: [executor], policies: [{ scope: 'ws/demo', action: '*', level: 'supervisor' }] },
    60,
    (url, init) => {
      if (!url.endsWith('/ack-reply')) return undefined
      ackBodies.push(JSON.parse(String(init?.body)))
      if (ackBodies.length === 1)
        return new Response(
          JSON.stringify({
            ok: false,
            error: { kind: 'retryable', code: 'hub_busy', message: '稍后重试' },
          }),
          { status: 503 },
        )
      return undefined
    },
  )
  current = b
  const id = await b.create({ executor: 'probe' })
  await b.until(id, (task) => task.status === 'blocked')
  const firstBlock = b.events(id).find((event) => event.type === 'task.blocked')
  if (!firstBlock) throw new Error('缺少卡住事件')
  expect(
    b.ledger.append(
      {
        type: 'task.reply_delegated',
        task_id: id,
        workspace: b.task(id).workspace,
        payload: {
          task_id: id,
          block_seq: firstBlock.seq,
          kind: 'awaiting_approval',
          decision_id: b.task(id).blocked?.decision_id,
          deadline: '2099-01-01T00:00:00.000Z',
        },
      },
      { actor: 'hub' },
    ).ok,
  ).toBe(true)
  expect(
    b.ledger.append(
      {
        type: 'task.replied',
        task_id: id,
        workspace: b.task(id).workspace,
        payload: { reply_id: 'r-supervisor-attempted', kind: 'approve', via: 'supervisor' },
      },
      { actor: 'supervisor' },
    ).ok,
  ).toBe(true)
  await b.until(id, () => ackBodies.length === 1)
  // request_changed 在确认重试期间与旧字符串 dropped 一样，由 ack 负责恢复。
  activity.push(resumedSignal(new Date(b.clock.now()).toISOString(), '旧授权回合结束'))
  await b.clock.advance(0)
  expect(b.task(id).status).toBe('blocked')
  expect(b.types(id)).not.toContain('task.unblocked')
  await b.until(id, (task) => task.status === 'running', 60_000)
  expect(ackBodies).toMatchObject([
    { outcome: 'dropped', reason: 'request_changed', attempted: true },
    { outcome: 'dropped', reason: 'request_changed', attempted: true },
  ])
  expect(b.ledger.getReply('r-supervisor-attempted')?.state).toBe('dropped')
  activity.push(idleSignal(new Date(b.clock.now()).toISOString(), '新的授权请求'))
  await b.until(id, (task) => task.status === 'blocked')
  expect(b.task(id).blocked?.no_delegate).toBe(true)
  expect(
    b
      .events(id)
      .filter((event) => event.type === 'task.blocked' || event.type === 'task.unblocked')
      .map((event) => event.type),
  ).toEqual(['task.blocked', 'task.unblocked', 'task.blocked'])
})
