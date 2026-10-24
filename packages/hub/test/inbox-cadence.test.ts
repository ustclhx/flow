import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_INBOX_CADENCE, type InboxItemView, parseInboxConfig } from '@flow/core'
import {
  type EventInput,
  isQuiet,
  type LedgerStore,
  lastTimePoint,
  planPushes,
  quietEnd,
} from '../src/index.ts'
import { createItem, inboxRig, local, MemoryChannel, specOf } from './channel-fixtures.ts'
import { drafts, must, WS } from './ledger-helpers.ts'

/**
 * 推送节奏（add-m1-inbox 3.3；inbox spec "推送节奏"）：注入时钟，时间按系统本地时区。
 */

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

async function rig(start: number, channels = [new MemoryChannel()]) {
  const r = await inboxRig({ start, channels: channels.map((c) => specOf(c)) })
  cleanups.push(r.cleanup)
  await r.settle()
  return { ...r, channel: channels[0] as MemoryChannel, channels }
}

/** 建任务、开始执行、卡住；反应器据此开出 Interrupt 条目。 */
function blockTask(
  ledger: LedgerStore,
  id: string,
  reason: 'question' | 'no_progress' = 'question',
) {
  const d = drafts(id)
  must(ledger.append(d['task.created'] as EventInput, { actor: 'user' }))
  must(ledger.appendMany([d['task.started'], d['lease.granted']] as EventInput[], { actor: 'hub' }))
  return must(
    ledger.append(
      {
        task_id: id,
        workspace: WS,
        type: 'task.blocked',
        payload: { reason, message: '用哪个分支？', tail: ['$ git status'], lease_held: true },
      },
      { actor: 'node:n1' },
    ),
  )
}

describe('纯函数', () => {
  const quiet = DEFAULT_INBOX_CADENCE.quiet
  test('静默时段跨越午夜：23:00–08:00', () => {
    expect(isQuiet(local(26, 22, 59), quiet)).toBe(false)
    expect(isQuiet(local(26, 23, 0), quiet)).toBe(true)
    expect(isQuiet(local(27, 2, 0), quiet)).toBe(true)
    expect(isQuiet(local(27, 8, 0), quiet)).toBe(false)
    expect(quietEnd(local(26, 23, 30), quiet)).toBe(local(27, 8))
    expect(quietEnd(local(27, 2, 0), quiet)).toBe(local(27, 8))
    expect(quietEnd(local(27, 9, 0), quiet)).toBeNull()
    expect(isQuiet(local(27, 2, 0), null)).toBe(false)
    // 不跨午夜的时段
    const nap = { start: '12:00', end: '13:30' }
    expect(isQuiet(local(26, 12, 10), nap)).toBe(true)
    expect(isQuiet(local(26, 13, 30), nap)).toBe(false)
  })

  test('最近一个 Decide 时间点：今天或昨天', () => {
    const times = ['09:00', '18:00']
    expect(lastTimePoint(local(26, 10), times)).toBe(local(26, 9))
    expect(lastTimePoint(local(26, 18), times)).toBe(local(26, 18))
    expect(lastTimePoint(local(26, 8), times)).toBe(local(25, 18))
    expect(lastTimePoint(local(26, 8), [])).toBeNull()
  })

  test('planPushes：已推送到该渠道的不再推送，Digest 级条目不单独推送', () => {
    const item = (over: Partial<InboxItemView>): InboxItemView => ({
      id: 'sup.1',
      short_id: '1',
      level: 'interrupt',
      source: 'supervisor',
      source_ref: 'x',
      reason: null,
      workspace: null,
      task_id: null,
      title: 't',
      body: '',
      actions: [],
      state: 'open',
      created_at: new Date(local(26, 10)).toISOString(),
      created_by: 'hub',
      updated_at: new Date(local(26, 10)).toISOString(),
      deferred_until: null,
      pushed_at: null,
      channels: [],
      closed: null,
      ...over,
    })
    const pushed = item({
      id: 'sup.2',
      short_id: '2',
      channels: [
        {
          channel: 'a',
          ref: 'r',
          kind: 'item',
          sent_at: '2026-10-26T02:00:00.000Z',
          synced_at: null,
          failed: null,
        },
      ],
    })
    const digest = item({ id: 'pol.3', short_id: '3', level: 'digest', source: 'policy' })
    const plan = planPushes([item({}), pushed, digest], 'a', local(26, 10, 5), {
      ...DEFAULT_INBOX_CADENCE,
    })
    expect(plan.map((p) => p.items.map((i) => i.id))).toEqual([['sup.1']])
    // 另一个渠道还没推送过 sup.2
    expect(planPushes([pushed], 'b', local(26, 10, 5), { ...DEFAULT_INBOX_CADENCE })).toHaveLength(
      1,
    )
  })
})

describe('配置', () => {
  test('节奏字段：默认值、覆盖、写错时取默认值并报告', () => {
    const empty = parseInboxConfig({})
    if (!empty.ok) throw new Error('parse')
    expect(empty.data.cadence).toEqual({ ...DEFAULT_INBOX_CADENCE })

    const custom = parseInboxConfig({
      quiet_hours: { start: '22:30', end: '07:00' },
      decide: { times: ['18:00', '12:00'], threshold: 3 },
      digest: { time: '07:45' },
      snippet_max_chars: 300,
    })
    if (!custom.ok) throw new Error('parse')
    expect(custom.data.errors).toEqual([])
    expect(custom.data.cadence).toEqual({
      quiet: { start: '22:30', end: '07:00' },
      decide_times: ['12:00', '18:00'],
      decide_threshold: 3,
      digest_time: '07:45',
      snippet_max_chars: 300,
    })

    const off = parseInboxConfig({ quiet_hours: false })
    if (!off.ok) throw new Error('parse')
    expect(off.data.cadence?.quiet).toBeNull()

    const bad = parseInboxConfig({
      levels: [{ reason: 'no_progress', level: 'digest' }],
      quiet_hours: { start: '25:00', end: '08:00' },
      decide: { threshold: 0 },
    })
    if (!bad.ok) throw new Error('parse')
    expect(bad.data.levels).toHaveLength(1)
    expect(bad.data.cadence?.quiet).toEqual(DEFAULT_INBOX_CADENCE.quiet)
    expect(bad.data.cadence?.decide_threshold).toBe(5)
    expect(bad.data.errors.map((e) => e.field)).toEqual(['quiet_hours.start', 'decide.threshold'])
  })
})

describe('Interrupt', () => {
  test('白天生成的 Interrupt 立即推送，推送记录投影到 pushed_at 与 channels', async () => {
    const r = await rig(local(26, 10))
    const blocked = blockTask(r.ledger, 't-day')
    await r.settle()
    await r.inbox.pusher.tick()
    const id = `blk.${blocked.seq}`
    expect(r.channel.sentIds()).toEqual([[id]])
    const item = r.ledger.getInboxItem(id) as InboxItemView
    expect(item.deferred_until).toBeNull()
    expect(item.pushed_at).not.toBeNull()
    expect(item.channels).toEqual([
      {
        channel: 'memory',
        ref: 'memory-1',
        kind: 'item',
        sent_at: item.pushed_at as string,
        synced_at: null,
        failed: null,
      },
    ])
    const pushed = r.ledger.latestEvent(undefined, 'inbox.pushed')
    expect(pushed?.payload).toEqual({
      channel: 'memory',
      ref: 'memory-1',
      op: 'send',
      kind: 'item',
      item_ids: [id],
    })
  })

  test('夜间卡住：条目立即生成，推送顺延到 08:00（inbox.item_updated 写 deferred_until）', async () => {
    const r = await rig(local(27, 2))
    const blocked = blockTask(r.ledger, 't-night')
    await r.settle()
    await r.inbox.pusher.tick()
    const id = `blk.${blocked.seq}`
    const item = r.ledger.getInboxItem(id) as InboxItemView
    expect(item.state).toBe('open')
    expect(item.deferred_until).toBe(new Date(local(27, 8)).toISOString())
    const updated = r.ledger.latestEvent(undefined, 'inbox.item_updated')
    expect(updated?.payload).toEqual({ item_id: id, deferred_until: item.deferred_until })
    expect(r.channel.sent).toHaveLength(0)

    await r.clock.advance(local(27, 7, 59) - r.clock.now())
    await r.settle()
    expect(r.channel.sent).toHaveLength(0)

    await r.clock.advance(60_000)
    await r.settle()
    expect(r.channel.sentIds()).toEqual([[id]])
  })
})

describe('Decide', () => {
  test('按时间点合并成一条消息推送', async () => {
    const r = await rig(local(26, 10))
    for (const id of ['sup.a', 'sup.b', 'sup.c']) createItem(r.ledger, id, 'decide')
    await r.settle()
    await r.inbox.pusher.tick()
    expect(r.channel.sent).toHaveLength(0)

    await r.clock.advance(local(26, 18) - r.clock.now())
    await r.settle()
    expect(r.channel.sentIds()).toEqual([['sup.a', 'sup.b', 'sup.c']])
    expect(r.channel.sent[0]?.message.kind).toBe('batch')
    const pushed = r.ledger.latestEvent(undefined, 'inbox.pushed')
    expect(pushed?.payload).toMatchObject({ kind: 'batch', item_ids: ['sup.a', 'sup.b', 'sup.c'] })

    // 之后新生成的 Decide 等下一个时间点
    createItem(r.ledger, 'sup.d', 'decide')
    await r.settle()
    await r.inbox.pusher.tick()
    expect(r.channel.sent).toHaveLength(1)
    await r.clock.advance(local(27, 9) - r.clock.now())
    await r.settle()
    // 08:30 的每日摘要也会推送；这里只看 Decide 合并消息
    expect(r.channel.sentIds().filter((ids) => !ids[0]?.startsWith('dig.'))).toEqual([
      ['sup.a', 'sup.b', 'sup.c'],
      ['sup.d'],
    ])
  })

  test('未推送的 Decide 达到阈值（5）时提前推送；静默时段内不提前', async () => {
    const r = await rig(local(26, 10))
    for (let i = 1; i <= 4; i++) createItem(r.ledger, `sup.${i}`, 'decide')
    await r.settle()
    await r.inbox.pusher.tick()
    expect(r.channel.sent).toHaveLength(0)
    createItem(r.ledger, 'sup.5', 'decide')
    await r.settle()
    await r.inbox.pusher.tick()
    expect(r.channel.sentIds()).toEqual([['sup.1', 'sup.2', 'sup.3', 'sup.4', 'sup.5']])

    // 夜里攒够 5 条：等到静默时段结束
    await r.clock.advance(local(26, 23, 30) - r.clock.now())
    for (let i = 6; i <= 10; i++) createItem(r.ledger, `sup.${i}`, 'decide')
    await r.settle()
    await r.inbox.pusher.tick()
    expect(r.channel.sent).toHaveLength(1)
    await r.clock.advance(local(27, 8) - r.clock.now())
    await r.settle()
    expect(r.channel.sentIds()[1]).toEqual(['sup.6', 'sup.7', 'sup.8', 'sup.9', 'sup.10'])
  })
})

describe('每日摘要', () => {
  test('08:30 生成并推送：昨天完成与失败的任务、auto-report 记录、待处理 Decide 数、过时知识数', async () => {
    const r = await rig(local(25, 15))
    // 昨天（25 日）完成一个、失败一个
    const done = drafts('t-done')
    must(r.ledger.append(done['task.created'] as EventInput, { actor: 'user' }))
    must(
      r.ledger.appendMany([done['task.started'], done['lease.granted']] as EventInput[], {
        actor: 'hub',
      }),
    )
    must(r.ledger.append(done['task.done'] as EventInput, { actor: 'node:n1' }))
    const failed = drafts('t-failed')
    must(r.ledger.append(failed['task.created'] as EventInput, { actor: 'user' }))
    must(
      r.ledger.appendMany([failed['task.started'], failed['lease.granted']] as EventInput[], {
        actor: 'hub',
      }),
    )
    must(r.ledger.append(failed['task.failed'] as EventInput, { actor: 'node:n1' }))
    createItem(r.ledger, 'pol.1', 'digest', { source: 'policy' })
    createItem(r.ledger, 'sup.d1', 'decide')
    await r.settle()

    await r.clock.advance(local(26, 8, 30) - r.clock.now())
    await r.settle()
    const digest = r.ledger.getInboxItem('dig.2026-10-26') as InboxItemView
    expect(digest).not.toBeNull()
    expect(digest.level).toBe('digest')
    expect(digest.source).toBe('digest')
    expect(digest.body).toContain('昨天（2026-10-25）完成 1 个任务，失败 1 个。')
    expect(digest.body).toContain('(t-done)'.replace('(', '（').replace(')', '）'))
    expect(digest.body).toContain('策略自动放行记录 1 条。')
    expect(digest.body).toContain('待处理的 Decide 条目 1 个。')
    expect(digest.body).toContain('可能过时的知识条目 0 个。')
    // 策略记录写进摘要后关闭
    expect(r.ledger.getInboxItem('pol.1')?.closed?.reason).toBe('digested')
    // 摘要单独推送；Decide 在 18:00 前的时间点之前生成，也随之合并推送（09:00 之前不推）
    expect(r.channel.sentIds()).toContainEqual(['dig.2026-10-26'])
    expect(r.channel.sentIds()).toContainEqual(['sup.d1'])

    // 第二天的摘要取代前一份
    await r.clock.advance(local(27, 8, 30) - r.clock.now())
    await r.settle()
    expect(r.ledger.getInboxItem('dig.2026-10-26')?.closed?.reason).toBe('superseded')
    expect(r.ledger.getInboxItem('dig.2026-10-27')?.state).toBe('open')
    // 已推送的旧摘要消息改为"已被新的条目取代"
    const upd = r.channel.updates.find(
      (u) => u.message.kind === 'item' && u.message.item.id === 'dig.2026-10-26',
    )
    expect(upd?.message.kind === 'item' && upd.message.item.closed?.label).toBe('已被新的条目取代')

    // 重复触发不会生成第二份
    await r.inbox.pusher.fireDigest()
    expect(r.ledger.listInboxItems({ source: 'digest', limit: 100 })).toHaveLength(2)
  })

  test('用户把 no_progress 调为 Digest：不单独推送，只出现在每日摘要中', async () => {
    const r = await rig(local(26, 10))
    mkdirSync(join(r.home, 'config'), { recursive: true })
    writeFileSync(
      join(r.home, 'config', 'inbox.yaml'),
      'levels:\n  - reason: no_progress\n    level: digest\n',
    )
    await r.inbox.reloadConfig()
    const blocked = blockTask(r.ledger, 't-slow', 'no_progress')
    await r.settle()
    await r.inbox.pusher.tick()
    const id = `blk.${blocked.seq}`
    expect(r.ledger.getInboxItem(id)?.level).toBe('digest')
    expect(r.channel.sent).toHaveLength(0)

    await r.clock.advance(local(27, 8, 30) - r.clock.now())
    await r.settle()
    const digest = r.ledger.getInboxItem('dig.2026-10-27') as InboxItemView
    expect(digest.body).toContain('只进摘要的卡住任务 1 个')
    expect(r.channel.sentIds()).toEqual([['dig.2026-10-27']])
    // 卡住的任务条目仍保持打开，直到任务恢复
    expect(r.ledger.getInboxItem(id)?.state).toBe('open')
  })

  test('中枢停机期间错过了摘要时间：重启后补发一份', async () => {
    const r = await rig(local(26, 7))
    createItem(r.ledger, 'sup.x', 'decide')
    await r.settle()
    await r.inbox.stop()
    r.scheduler.stop()
    // 中枢停到 10:00 才重启：用同一个账本重新起一套
    r.clock.time = local(26, 10)
    const { createScheduler, startInbox } = await import('../src/index.ts')
    const scheduler = await createScheduler({ ledger: r.ledger, clock: r.clock, home: r.home })
    const channel = new MemoryChannel()
    const inbox = await startInbox({
      ledger: r.ledger,
      home: r.home,
      clock: r.clock,
      watch: false,
      scheduler,
      channels: [specOf(channel)],
    })
    cleanups.unshift(async () => {
      await inbox.stop()
      scheduler.stop()
    })
    await r.clock.advance(0)
    await inbox.pusher.tick()
    expect(r.ledger.getInboxItem('dig.2026-10-26')?.state).toBe('open')
    expect(channel.sentIds()).toContainEqual(['dig.2026-10-26'])
  })
})

describe('静默时段覆盖所有推送', () => {
  test('渠道在凌晨恢复：Decide 合并消息与 Interrupt 都等到 08:00', async () => {
    const r = await rig(local(26, 17))
    r.channel.down = true
    for (const id of ['sup.n1', 'sup.n2']) createItem(r.ledger, id, 'decide')
    createItem(r.ledger, 'sup.i1', 'interrupt')
    await r.settle()
    // 18:00 到点时渠道不可用
    await r.clock.advance(local(26, 18) - r.clock.now())
    await r.settle()
    expect(r.channel.sent).toHaveLength(0)
    // 23:30 渠道恢复、凌晨 2 点仍在退避重试：静默时段内什么都不推
    await r.clock.advance(local(26, 23, 30) - r.clock.now())
    r.channel.down = false
    await r.clock.advance(local(27, 2) - r.clock.now())
    await r.settle()
    expect(r.channel.sent).toHaveLength(0)
    await r.clock.advance(local(27, 8) - r.clock.now())
    await r.settle()
    expect(r.channel.sentIds()).toEqual([['sup.i1'], ['sup.n1', 'sup.n2']])
  })

  test('静默时段内的阈值与时间点都不推送', () => {
    const c = { ...DEFAULT_INBOX_CADENCE, decide_times: ['01:00'], decide_threshold: 1 }
    const decide = {
      id: 'sup.q',
      short_id: '1',
      level: 'decide' as const,
      source: 'supervisor' as const,
      source_ref: 'q',
      reason: null,
      workspace: null,
      task_id: null,
      title: 't',
      body: '',
      actions: [],
      state: 'open' as const,
      created_at: new Date(local(26, 20)).toISOString(),
      created_by: 'hub',
      updated_at: new Date(local(26, 20)).toISOString(),
      deferred_until: null,
      pushed_at: null,
      channels: [],
      closed: null,
    }
    expect(planPushes([decide], 'a', local(27, 1, 30), c)).toEqual([])
    expect(planPushes([decide], 'a', local(27, 8), c)).toHaveLength(1)
  })
})

describe('补发摘要按计划日期', () => {
  test('D 日 08:30 前停机、D+1 00:30 重启：生成 dig.D 并顺延到 08:00 推送；D+1 08:30 生成 dig.D+1', async () => {
    const r = await rig(local(26, 8))
    // 停机前最后一条事件在 08:29
    r.clock.time = local(26, 8, 29)
    createItem(r.ledger, 'sup.last', 'digest')
    await r.settle()
    await r.inbox.stop()
    r.scheduler.stop()

    r.clock.time = local(27, 0, 30)
    const { createScheduler, startInbox } = await import('../src/index.ts')
    const scheduler = await createScheduler({ ledger: r.ledger, clock: r.clock, home: r.home })
    const channel = new MemoryChannel()
    const inbox = await startInbox({
      ledger: r.ledger,
      home: r.home,
      clock: r.clock,
      watch: false,
      scheduler,
      channels: [specOf(channel)],
    })
    cleanups.unshift(async () => {
      await inbox.stop()
      scheduler.stop()
    })
    await r.clock.advance(0)
    await inbox.pusher.tick()
    const digest = r.ledger.getInboxItem('dig.2026-10-26') as InboxItemView
    expect(digest).not.toBeNull()
    // 覆盖范围是 D 的"昨天"（25 日），不是重启当天
    expect(digest.body).toContain('昨天（2026-10-25）')
    expect(r.ledger.getInboxItem('dig.2026-10-27')).toBeNull()
    expect(digest.deferred_until).toBe(new Date(local(27, 8)).toISOString())
    expect(channel.sent).toHaveLength(0)

    await r.clock.advance(local(27, 8) - r.clock.now())
    await r.settle()
    expect(channel.sentIds()).toEqual([['dig.2026-10-26']])

    await r.clock.advance(local(27, 8, 30) - r.clock.now())
    await r.settle()
    expect(r.ledger.getInboxItem('dig.2026-10-27')?.body).toContain('昨天（2026-10-26）')
    expect(r.ledger.getInboxItem('dig.2026-10-26')?.closed?.reason).toBe('superseded')
    expect(channel.sentIds()).toEqual([['dig.2026-10-26'], ['dig.2026-10-27']])
  })
})

describe('可重建', () => {
  test('推送与同步记录在投影重建后一致', async () => {
    const r = await rig(local(26, 10))
    createItem(r.ledger, 'sup.r', 'interrupt')
    for (let i = 1; i <= 5; i++) createItem(r.ledger, `sup.b${i}`, 'decide')
    await r.settle()
    await r.inbox.pusher.tick()
    must(
      r.ledger.append(
        { type: 'inbox.item_closed', payload: { item_id: 'sup.b2', reason: 'answered' } },
        { actor: 'hub' },
      ),
    )
    await r.settle()
    await r.inbox.pusher.tick()
    expect(r.channel.updates).toHaveLength(1)
    const before = r.ledger.snapshot({ includeSoft: false })
    expect(before.channel_messages).toHaveLength(6)
    must(r.ledger.rebuild())
    const after = r.ledger.snapshot({ includeSoft: false })
    expect(after.inbox_items).toEqual(before.inbox_items)
    expect(after.channel_messages).toEqual(before.channel_messages)
    expect(r.ledger.getInboxItem('sup.b2')?.channels[0]?.synced_at).not.toBeNull()
    expect(r.ledger.channelMessageItems('memory', 'memory-2')).toEqual([
      'sup.b1',
      'sup.b2',
      'sup.b3',
      'sup.b4',
      'sup.b5',
    ])
  })
})

describe('推送记录（直接写事件）', () => {
  test('inbox.pushed 投影到 pushed_at、channels 与 channel_messages，重建后一致', async () => {
    const r = await rig(local(26, 10))
    for (const id of ['sup.a', 'sup.b']) createItem(r.ledger, id, 'decide')
    must(
      r.ledger.append(
        {
          type: 'inbox.pushed',
          payload: { channel: 'telegram', ref: '1:2', kind: 'batch', item_ids: ['sup.a', 'sup.b'] },
        },
        { actor: 'hub' },
      ),
    )
    must(
      r.ledger.append(
        { type: 'inbox.item_closed', payload: { item_id: 'sup.a', reason: 'answered' } },
        { actor: 'hub' },
      ),
    )
    expect(r.ledger.pendingChannelUpdates('telegram')).toEqual([
      { ref: '1:2', item_ids: ['sup.a'] },
    ])
    must(
      r.ledger.append(
        {
          type: 'inbox.pushed',
          payload: {
            channel: 'telegram',
            ref: '1:2',
            op: 'update',
            kind: 'batch',
            item_ids: ['sup.a'],
          },
        },
        { actor: 'hub' },
      ),
    )
    expect(r.ledger.pendingChannelUpdates('telegram')).toEqual([])
    const a = r.ledger.getInboxItem('sup.a') as InboxItemView
    expect(a.pushed_at).not.toBeNull()
    expect(a.channels).toMatchObject([{ channel: 'telegram', ref: '1:2', kind: 'batch' }])
    expect(a.channels[0]?.synced_at).not.toBeNull()
    expect(r.ledger.channelMessageItems('telegram', '1:2')).toEqual(['sup.a', 'sup.b'])
    expect(r.ledger.getInboxItemByShortId(a.short_id)?.id).toBe('sup.a')
    // 不在该消息里的条目不能记为同步
    const bad = r.ledger.append(
      {
        type: 'inbox.pushed',
        payload: { channel: 'telegram', ref: '9:9', op: 'update', item_ids: ['sup.b'] },
      },
      { actor: 'hub' },
    )
    expect(bad.ok).toBe(false)
    const before = r.ledger.snapshot({ includeSoft: false })
    must(r.ledger.rebuild())
    const after = r.ledger.snapshot({ includeSoft: false })
    expect(after.inbox_items).toEqual(before.inbox_items)
    expect(after.channel_messages).toEqual(before.channel_messages)
  })
})
