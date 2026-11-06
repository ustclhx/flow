import { afterEach, expect, test } from 'bun:test'
import { actOnInbox } from '../src/inbox/actions.ts'
import { createInboxReactor, createNodeProtocol, createTaskService } from '../src/index.ts'
import { anyRole, contractInput, must, tempLedger } from './ledger-helpers.ts'
import { FakeClock } from './server-fixtures.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

async function setup() {
  const clock = new FakeClock(Date.parse('2026-10-25T08:00:00Z'))
  const temp = await tempLedger({ now: clock.now })
  cleanups.push(temp.cleanup)
  const ledger = temp.store
  const protocol = createNodeProtocol({ ledger, clock, leaseTtlS: 60, leaseWaitMaxS: 30 })
  const reactor = createInboxReactor({ ledger })
  const tasks = createTaskService({ ledger, roles: anyRole, workspaceExists: () => true })
  cleanups.push(() => {
    reactor.stop()
    protocol.stop()
  })
  reactor.start()
  const task = must(await tasks.createTask(contractInput(), { actor: 'user' })).task
  must(
    protocol.service.registerNode(
      { node_id: 'n1', hostname: 'test', version: '0', capabilities: ['executor:fake'] },
      'user',
    ),
  )
  const lease = must(
    await protocol.service.acquire({ node_id: 'n1', capabilities: ['executor:fake'], wait_s: 0 }),
  ).lease
  if (!lease) throw new Error('缺少租约')
  const renew = (fields: Record<string, unknown> = {}) =>
    must(protocol.service.renew(lease.lease_id, { lease_token: lease.lease_token, ...fields }))
  const block = (request_id: string, approval_fingerprint?: string) =>
    renew({
      blocked: {
        request_id,
        reason: 'awaiting_approval',
        message: request_id,
        ...(approval_fingerprint ? { approval_fingerprint } : {}),
      },
    })
  const reply = (kind: 'approve' | 'deny' | 'text', reply_id = 'r-human') =>
    must(
      ledger.append(
        {
          type: 'task.replied',
          task_id: task.id,
          workspace: task.workspace,
          payload: { reply_id, kind, ...(kind === 'text' ? { text: '继续' } : {}) },
        },
        { actor: 'user' },
      ),
    )
  const drop = () =>
    protocol.service.ackReply(lease.lease_id, {
      lease_token: lease.lease_token,
      reply_id: 'r-human',
      outcome: 'dropped',
      reason: 'round_closed',
    })
  return { ...temp, ledger, protocol, reactor, tasks, task, lease, renew, block, reply, drop }
}

test('回复与恢复回复携带原blocked seq和哈希，后续卡住不改变绑定', async () => {
  const c = await setup()
  const fingerprint = 'a'.repeat(64)
  const first = c.block('round-1', fingerprint)
  expect(first.blocked).toMatchObject({ request_id: 'round-1' })
  expect(c.block('round-1').blocked).toEqual(first.blocked)
  expect(c.block('round-2').blocked).toBeUndefined()
  c.reply('approve')
  expect(c.renew().reply).toMatchObject({
    block_seq: first.blocked?.seq,
    approval_fingerprint: fingerprint,
  })
  must(
    c.ledger.appendMany(
      [
        {
          type: 'task.blocked',
          task_id: c.task.id,
          workspace: c.task.workspace,
          payload: {
            reason: 'crashed',
            message: '会话结束',
            approval_fingerprint: 'b'.repeat(64),
          },
        },
        {
          type: 'task.requeued_with_reply',
          task_id: c.task.id,
          workspace: c.task.workspace,
          payload: { reply_id: 'r-human' },
        },
      ],
      { actor: 'node:n1' },
    ),
  )
  const resumed = must(
    await c.protocol.service.acquire({ node_id: 'n1', capabilities: ['executor:fake'], wait_s: 0 }),
  ).lease
  expect(resumed?.resume?.reply).toMatchObject({
    block_seq: first.blocked?.seq,
    approval_fingerprint: fingerprint,
  })
})

test('尝试送达后拒收，收件箱保留可能已送达的措辞且可重建', async () => {
  const c = await setup()
  c.block('round-old')
  c.reply('approve')
  must(
    c.protocol.service.ackReply(c.lease.lease_id, {
      lease_token: c.lease.lease_token,
      reply_id: 'r-human',
      outcome: 'dropped',
      reason: 'round_closed',
      attempted: true,
    }),
  )
  await c.reactor.idle()
  const item = c.ledger.listInboxItems({ source: 'reply_delivery', state: 'open' })[0]
  expect(item?.title).toContain('回复可能没有送达')
  expect(item?.body).toContain('这条回复可能没有送达')
  must(c.ledger.rebuild())
  expect(c.ledger.getInboxItem(item?.id ?? '')?.body).toContain('这条回复可能没有送达')
  expect(c.ledger.getInboxItem(item?.id ?? '')?.title).toContain('回复可能没有送达')
})

for (const nextReply of [false, true]) {
  test(`拒收requeued回复不能跨越旧派工${nextReply ? '或替代本次恢复回复' : ''}`, async () => {
    const c = await setup()
    c.block('round-old')
    c.reply('deny')
    must(
      c.protocol.service.ackReply(c.lease.lease_id, {
        lease_token: c.lease.lease_token,
        reply_id: 'r-human',
        outcome: 'not_running',
      }),
    )
    const acquire = async () => {
      const lease = must(
        await c.protocol.service.acquire({
          node_id: 'n1',
          capabilities: ['executor:fake'],
          wait_s: 0,
        }),
      ).lease
      if (!lease) throw new Error('缺少租约')
      return lease
    }
    const second = await acquire()
    must(
      c.protocol.service.renew(second.lease_id, {
        lease_token: second.lease_token,
        blocked: { reason: 'question', message: '下一轮' },
      }),
    )
    if (nextReply) {
      c.reply('text', 'r-next')
      must(
        c.protocol.service.ackReply(second.lease_id, {
          lease_token: second.lease_token,
          reply_id: 'r-next',
          outcome: 'not_running',
        }),
      )
    } else {
      must(
        c.protocol.service.complete(second.lease_id, {
          lease_token: second.lease_token,
          outcome: 'blocked',
          blocked_reason: 'crashed',
          message: '结束第二次派工',
        }),
      )
      must(
        c.ledger.append(
          {
            type: 'task.requeued',
            task_id: c.task.id,
            workspace: c.task.workspace,
            payload: { reason: 'manual' },
          },
          { actor: 'user' },
        ),
      )
    }
    const third = await acquire()
    const before = c.ledger.seq()
    expect(
      c.protocol.service.ackReply(third.lease_id, {
        lease_token: third.lease_token,
        reply_id: 'r-human',
        outcome: 'dropped',
        reason: 'round_closed',
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_transition' } })
    expect(c.ledger.seq()).toBe(before)
    expect(c.ledger.getReply('r-human')?.state).toBe('requeued')
    if (nextReply) expect(third.resume?.reply.reply_id).toBe('r-next')
    else expect(third.resume).toBeUndefined()
  })
}

for (const kind of ['approve', 'deny', 'text'] as const) {
  test(`${kind}因回合关闭终态丢弃，通知可忽略且不解除当前卡住`, async () => {
    const c = await setup()
    c.block('round-old')
    c.reply(kind)
    expect(
      c.protocol.service.ackReply(c.lease.lease_id, {
        lease_token: c.lease.lease_token,
        reply_id: 'r-human',
        outcome: 'dropped',
        reason: 'request_changed',
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } })
    must(c.drop())
    expect(c.ledger.getReply('r-human')?.state).toBe('dropped')
    expect(c.ledger.getTask(c.task.id)?.status).toBe('blocked')
    expect(c.renew().reply).toBeNull()
    expect(c.ledger.activeLease(c.task.id)?.lease_id).toBe(c.lease.lease_id)
    const seq = c.ledger.seq()
    must(c.drop())
    expect(c.ledger.seq()).toBe(seq)
    await c.reactor.idle()
    const item = c.ledger.listInboxItems({ source: 'reply_delivery', state: 'open' })[0]
    expect(item).toMatchObject({ level: 'interrupt', actions: [], reason: 'round_closed' })
    expect(item?.title).toContain('回复没有送达')
    expect(item?.body).toContain('这条回复没有送达')
    expect(item?.body).toContain('原因')
    c.renew({ resumed: {} })
    c.block('round-new')
    must(c.drop())
    c.reactor.reconcile()
    await c.reactor.idle()
    expect(c.ledger.getTask(c.task.id)?.blocked?.message).toBe('round-new')
    expect(c.ledger.getInboxItem(item?.id ?? '')?.state).toBe('open')
    must(
      await actOnInbox(
        { ledger: c.ledger, tasks: c.tasks, home: c.dir, scanProposals: async () => {} },
        item?.id ?? '',
        { action: 'dismiss' },
        'user',
      ),
    )
    c.reactor.reconcile()
    await c.reactor.idle()
    must(c.ledger.rebuild())
    expect(c.ledger.getInboxItem(item?.id ?? '')?.closed?.reason).toBe('dismissed')
    expect(c.ledger.getReply('r-human')?.state).toBe('dropped')
    expect(c.ledger.getTask(c.task.id)?.blocked?.message).toBe('round-new')
  })
}

test('自行恢复已丢弃的旧回复收到round_closed回执不追加通知', async () => {
  const c = await setup()
  c.block('round-old')
  c.reply('approve')
  c.renew({ resumed: {} })
  const next = c.block('round-new')
  must(c.drop())
  must(c.drop())
  await c.reactor.idle()
  expect(
    c.ledger.taskEvents(c.task.id).filter((e) => e.type === 'task.reply_dropped'),
  ).toHaveLength(0)
  expect(c.ledger.listInboxItems({ source: 'reply_delivery', state: 'open' })).toHaveLength(0)
  expect(c.block('round-new').blocked).toEqual(next.blocked)
  expect(c.ledger.getTask(c.task.id)?.blocked?.message).toBe('round-new')
})

test('重新排队的恢复回复可被主动拒收，通知一次且可重建', async () => {
  const c = await setup()
  c.block('round-old')
  c.reply('deny')
  must(
    c.protocol.service.ackReply(c.lease.lease_id, {
      lease_token: c.lease.lease_token,
      reply_id: 'r-human',
      outcome: 'not_running',
    }),
  )
  const next = must(
    await c.protocol.service.acquire({
      node_id: 'n1',
      capabilities: ['executor:fake'],
      wait_s: 0,
    }),
  ).lease
  if (!next) throw new Error('缺少恢复租约')
  const drop = () =>
    c.protocol.service.ackReply(next.lease_id, {
      lease_token: next.lease_token,
      reply_id: 'r-human',
      outcome: 'dropped',
      reason: 'round_closed',
    })
  expect(c.ledger.getReply('r-human')?.state).toBe('requeued')
  must(drop())
  must(drop())
  await c.reactor.idle()
  expect(
    c.ledger.taskEvents(c.task.id).filter((e) => e.type === 'task.reply_dropped'),
  ).toHaveLength(1)
  expect(c.ledger.listInboxItems({ source: 'reply_delivery', state: 'open' })).toHaveLength(1)
  expect(c.ledger.getTask(c.task.id)?.status).toBe('running')
  must(c.ledger.rebuild())
  expect(c.ledger.getReply('r-human')?.state).toBe('dropped')
})

test('兼容重放历史上自动丢弃后追加的拒收事件', async () => {
  const c = await setup()
  c.block('round-old')
  c.reply('approve')
  c.renew({ resumed: {} })
  expect(c.ledger.getReply('r-human')?.state).toBe('dropped')
  must(
    c.ledger.append(
      {
        task_id: c.task.id,
        workspace: c.task.workspace,
        type: 'task.reply_dropped',
        payload: { reply_id: 'r-human', reason: 'round_closed', message: '历史拒收通知' },
      },
      { actor: 'node:n1' },
    ),
  )
  must(c.ledger.rebuild())
  expect(c.ledger.getReply('r-human')?.state).toBe('dropped')
})
