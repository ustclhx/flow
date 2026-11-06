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
  const block = (request_id: string) =>
    renew({ blocked: { request_id, reason: 'awaiting_approval', message: request_id } })
  const reply = (kind: 'approve' | 'deny' | 'text') =>
    must(
      ledger.append(
        {
          type: 'task.replied',
          task_id: task.id,
          workspace: task.workspace,
          payload: { reply_id: 'r-human', kind, ...(kind === 'text' ? { text: '继续' } : {}) },
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

test('blocked 回执只绑定同一次request_id，回复携带原blocked seq', async () => {
  const c = await setup()
  const first = c.block('round-1')
  expect(first.blocked).toMatchObject({ request_id: 'round-1' })
  expect(c.block('round-1').blocked).toEqual(first.blocked)
  expect(c.block('round-2').blocked).toBeUndefined()
  c.reply('approve')
  expect(c.renew().reply?.block_seq).toBe(first.blocked?.seq)
  must(
    c.protocol.service.complete(c.lease.lease_id, {
      lease_token: c.lease.lease_token,
      outcome: 'blocked',
      blocked_reason: 'crashed',
      message: '会话结束',
    }),
  )
  const resumed = must(
    await c.protocol.service.acquire({ node_id: 'n1', capabilities: ['executor:fake'], wait_s: 0 }),
  ).lease
  expect(resumed?.resume?.reply.block_seq).toBe(first.blocked?.seq)
})

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
