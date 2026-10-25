import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createProposal, type InboxItemView, renderEntry } from '@flow/core'
import { initTempHome } from '../../core/test/helpers.ts'
import {
  createHubApp,
  createInboxReactor,
  createInboxRoutes,
  createNodeProtocol,
  createProposalWatcher,
  createTaskService,
} from '../src/index.ts'
import { anyRole, contractInput, must, tempLedger } from './ledger-helpers.ts'
import { authHeaders, FakeClock, testToken } from './server-fixtures.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn()
})

async function setup() {
  const clock = new FakeClock(Date.parse('2026-10-25T08:00:00Z'))
  const { store, dir, cleanup } = await tempLedger({ now: clock.now })
  const tasks = createTaskService({
    ledger: store,
    workspaceExists: () => true,
    roles: anyRole,
    now: clock.now,
  })
  const protocol = createNodeProtocol({ ledger: store, clock, leaseTtlS: 60, leaseWaitMaxS: 30 })
  const reactor = createInboxReactor({ ledger: store })
  reactor.start()
  const proposals = createProposalWatcher({ ledger: store, home: dir, clock })
  const routes = createInboxRoutes({
    ledger: store,
    home: dir,
    tasks,
    scanProposals: proposals.scan,
  })
  const app = createHubApp({ token: testToken, mount: [{ path: '/', app: routes }] })
  cleanups.push(() => {
    proposals.stop()
    reactor.stop()
    protocol.stop()
    cleanup()
  })
  const act = (id: string, body: unknown, actor = 'user') =>
    app.request(`/v1/inbox/${id}/act`, {
      method: 'POST',
      headers: { ...authHeaders, 'X-Flow-Actor': actor, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  const createBlocked = async (reason: 'question' | 'awaiting_approval' = 'question') => {
    const task = must(await tasks.createTask(contractInput(), { actor: 'codex' })).task
    must(
      protocol.service.registerNode(
        {
          node_id: 'n1',
          hostname: 'test',
          version: '0.0.0',
          capabilities: ['executor:fake'],
        },
        'user',
      ),
    )
    const lease = must(
      await protocol.service.acquire({ node_id: 'n1', capabilities: ['executor:fake'], wait_s: 0 }),
    ).lease
    if (!lease) throw new Error('没有租约')
    must(
      protocol.service.renew(lease.lease_id, {
        lease_token: lease.lease_token,
        blocked: { reason, message: '请决定' },
      }),
    )
    await reactor.idle()
    const item = store.listInboxItems({ task_id: task.id })[0]
    if (!item) throw new Error('没有条目')
    return { task, lease, item }
  }
  return { app, store, reactor, tasks, protocol, act, createBlocked, clock }
}

describe('收件箱操作与查询（3.2）', () => {
  test('approve 只提交回复；节点送达后恢复任务，由反应器关闭且保留渠道，重建后仍一致', async () => {
    const ctx = await setup()
    const { task, lease, item } = await ctx.createBlocked('awaiting_approval')
    expect((await ctx.act(item.short_id, { action: 'approve', via: 'telegram' })).status).toBe(200)
    await ctx.reactor.idle()
    expect(ctx.store.getTask(task.id)?.status).toBe('blocked')
    expect(ctx.store.getInboxItem(item.id)?.state).toBe('open')
    const reply = must(
      ctx.protocol.service.renew(lease.lease_id, { lease_token: lease.lease_token }),
    ).reply
    expect(reply).toMatchObject({ kind: 'approve', by: 'user' })
    if (!reply) throw new Error('没有回复')
    must(
      ctx.protocol.service.ackReply(lease.lease_id, {
        lease_token: lease.lease_token,
        reply_id: reply.reply_id,
      }),
    )
    await ctx.reactor.idle()
    expect(ctx.store.getTask(task.id)?.status).toBe('running')
    expect(ctx.store.getInboxItem(item.id)?.closed).toMatchObject({
      reason: 'task_running',
      via: 'telegram',
      cause_actor: 'user',
    })
    must(ctx.store.rebuild())
    expect(ctx.store.getInboxItem(item.id)?.closed).toMatchObject({
      via: 'telegram',
      cause_actor: 'user',
    })
  })

  test.each([
    ['deny', '不执行', 'deny', 'awaiting_approval'],
    ['reply', '用方案 A', 'text', 'question'],
  ] as const)(
    '%s 映射 task_reply 并保留文字；无租约时重新排队后关闭',
    async (action, text, kind, reason) => {
      const ctx = await setup()
      const { task, lease } = await ctx.createBlocked(reason)
      // 无头执行器结束本轮，回复应沿用现有的重新排队逻辑。
      must(
        ctx.protocol.service.complete(lease.lease_id, {
          lease_token: lease.lease_token,
          outcome: 'blocked',
          blocked_reason: reason,
          message: '等待用户',
        }),
      )
      await ctx.reactor.idle()
      // complete 产生了新一轮 blocked，旧条目已 superseded；操作当前这轮的条目。
      const current = ctx.store.listInboxItems({ task_id: task.id, state: 'open' })[0]
      if (!current) throw new Error('没有当前条目')
      expect((await ctx.act(current.id, { action, text, via: 'web' })).status).toBe(200)
      await ctx.reactor.idle()
      expect(ctx.store.getTask(task.id)?.status).toBe('queued')
      expect(ctx.store.taskReplies(task.id)[0]).toMatchObject({ kind, text, by: 'user' })
      expect(ctx.store.getInboxItem(current.id)?.closed).toMatchObject({
        reason: 'task_queued',
        via: 'web',
        cause_actor: 'user',
      })
    },
  )

  test('dismiss 关闭条目且不影响任务和回复；已关闭条目返回 item_closed', async () => {
    const ctx = await setup()
    const { task, item } = await ctx.createBlocked()
    const before = ctx.store.getTask(task.id)
    expect((await ctx.act(item.id, { action: 'dismiss' })).status).toBe(200)
    expect(ctx.store.getTask(task.id)).toEqual(before)
    expect(ctx.store.taskReplies(task.id)).toEqual([])
    expect(ctx.store.getInboxItem(item.id)?.closed).toMatchObject({
      reason: 'dismissed',
      via: 'cli',
      cause_actor: 'user',
    })
    const seq = ctx.store.seq()
    const again = await ctx.act(item.id, { action: 'reply', text: '继续' })
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ error: { code: 'item_closed' } })
    expect(ctx.store.seq()).toBe(seq)
  })

  test('AI approve、处理其他人的条目被拒绝；只允许 dismiss 自己 created_by 的条目', async () => {
    const ctx = await setup()
    const { task, item } = await ctx.createBlocked('awaiting_approval')
    const seq = ctx.store.seq()
    for (const action of ['approve', 'deny', 'reply', 'accept', 'reject', 'dismiss']) {
      const response = await ctx.act(item.id, { action, text: '继续' }, 'codex')
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ error: { code: 'user_only' } })
    }
    expect(ctx.store.seq()).toBe(seq)
    expect(ctx.store.getTask(task.id)?.status).toBe('blocked')
    must(
      ctx.store.append(
        {
          type: 'inbox.item_created',
          payload: {
            item_id: 'ask.own',
            source: 'supervisor',
            source_ref: 'own',
            level: 'decide',
            title: '自己发起的条目',
            body: '',
            actions: [],
          },
        },
        { actor: 'codex' },
      ),
    )
    const beforeOwn = ctx.store.seq()
    const ownApproval = await ctx.act('ask.own', { action: 'approve' }, 'codex')
    expect(ownApproval.status).toBe(403)
    expect(await ownApproval.json()).toMatchObject({ error: { code: 'user_only' } })
    expect(ctx.store.seq()).toBe(beforeOwn)
    expect((await ctx.act('ask.own', { action: 'dismiss', via: 'web' }, 'codex')).status).toBe(200)
    expect(ctx.store.getInboxItem('ask.own')?.closed).toMatchObject({
      cause_actor: 'codex',
      via: 'web',
    })
  })

  test('不可用操作、缺少回复、无效渠道、未知操作及条目均不写入账本', async () => {
    const ctx = await setup()
    const { item } = await ctx.createBlocked()
    const seq = ctx.store.seq()
    for (const [body, status, code] of [
      [{ action: 'approve' }, 409, 'action_not_available'],
      [{ action: 'accept' }, 409, 'action_not_available'],
      [{ action: 'reply' }, 400, 'invalid_arguments'],
      [{ action: 'dismiss', via: 'mcp' }, 400, 'invalid_arguments'],
      [{ action: 'delete' }, 400, 'invalid_arguments'],
    ] as const) {
      const response = await ctx.act(item.id, body)
      expect(response.status).toBe(status)
      expect(await response.json()).toMatchObject({ error: { code } })
    }
    expect((await ctx.act('blk.missing', { action: 'dismiss' })).status).toBe(404)
    expect(ctx.store.seq()).toBe(seq)
  })

  test('查询默认 open，按级别与时间排序，并支持状态、级别和 workspace 过滤，超过 200 条仍完整返回', async () => {
    const ctx = await setup()
    for (const [id, level, workspace] of [
      ['digest', 'digest', 'ws/a'],
      ['decide', 'decide', 'ws/a'],
      ['interrupt1', 'interrupt', 'ws/b'],
      ['interrupt2', 'interrupt', 'ws/a'],
    ] as const) {
      must(
        ctx.store.append(
          {
            type: 'inbox.item_created',
            workspace,
            payload: {
              item_id: `ask.${id}`,
              source: 'supervisor',
              source_ref: id,
              level,
              title: id,
              body: '',
              actions: [],
            },
          },
          { actor: 'user' },
        ),
      )
    }
    must(
      ctx.store.append(
        {
          type: 'inbox.item_closed',
          workspace: 'ws/a',
          payload: { item_id: 'ask.digest', reason: 'dismissed' },
        },
        { actor: 'user' },
      ),
    )
    const list = async (query = '') => {
      const response = await ctx.app.request(`/v1/inbox${query}`, { headers: authHeaders })
      expect(response.status).toBe(200)
      const body = (await response.json()) as { data: { items: InboxItemView[] } }
      return body.data.items
    }
    expect((await list()).map((i) => i.source_ref)).toEqual(['interrupt1', 'interrupt2', 'decide'])
    expect((await list('?level=interrupt&workspace=ws/a')).map((i) => i.source_ref)).toEqual([
      'interrupt2',
    ])
    expect((await list('?state=closed')).map((i) => i.source_ref)).toEqual(['digest'])
    expect((await ctx.app.request('/v1/inbox?state=all', { headers: authHeaders })).status).toBe(
      400,
    )
    for (let n = 0; n < 201; n++) {
      must(
        ctx.store.append(
          {
            type: 'inbox.item_created',
            payload: {
              item_id: `ask.extra${n}`,
              source: 'supervisor',
              source_ref: String(n),
              level: 'digest',
              title: '摘要',
              body: '',
              actions: [],
            },
          },
          { actor: 'user' },
        ),
      )
    }
    expect(await list()).toHaveLength(204)
  })

  test.each(['accept', 'reject'] as const)(
    '手机上 %s 提案：以 user 写日志、归档后由扫描器关闭并保留 telegram 来源',
    async (action) => {
      const home = await initTempHome('flow-inbox-proposal-act-')
      cleanups.push(() => rmSync(join(home, '..'), { recursive: true, force: true }))
      const ctx = await setup()
      const proposal = must(
        await createProposal(
          home,
          {
            target: 'notes/mobile',
            content: renderEntry(
              { type: 'note', title: '手机操作', summary: '测试', scope: 'work' },
              '提案正文',
            ),
            reason: '从手机确认',
          },
          { actor: 'codex' },
        ),
      )
      const scanner = createProposalWatcher({ ledger: ctx.store, home, clock: ctx.clock })
      cleanups.push(() => scanner.stop())
      await scanner.scan()
      const app = createHubApp({
        token: testToken,
        mount: [
          {
            path: '/',
            app: createInboxRoutes({
              ledger: ctx.store,
              tasks: ctx.tasks,
              home,
              scanProposals: scanner.scan,
            }),
          },
        ],
      })
      const response = await app.request(`/v1/inbox/prop.${proposal.id}/act`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          text: action === 'reject' ? '暂不采用' : undefined,
          via: 'telegram',
        }),
      })
      expect(response.status).toBe(200)
      const log = readFileSync(join(home, 'brain/log.md'), 'utf8')
      expect(log).toContain(action === 'accept' ? 'apply' : 'reject')
      expect(log).toContain('user')
      if (action === 'accept')
        expect(readFileSync(join(home, 'brain/notes/mobile.md'), 'utf8')).toContain('提案正文')
      expect(ctx.store.getInboxItem(`prop.${proposal.id}`)?.closed).toMatchObject({
        reason: action === 'accept' ? 'proposal_accepted' : 'proposal_rejected',
        cause_actor: 'user',
        via: 'telegram',
      })
      const archived = JSON.parse(
        readFileSync(
          join(
            home,
            'state/proposals',
            action === 'accept' ? 'accepted' : 'rejected',
            `${proposal.id}.json`,
          ),
          'utf8',
        ),
      )
      expect(archived).toMatchObject({ decided_by: 'user', via: 'telegram' })
      if (action === 'reject') expect(archived.reason).toBe('暂不采用')
    },
  )
})
