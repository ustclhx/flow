import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_INBOX_CADENCE, type InboxItemView, parseInboxConfig } from '@flow/core'
import {
  createScheduler,
  type EventInput,
  isQuiet,
  type LedgerStore,
  lastTimePoint,
  openLedger,
  planPushes,
  quietEnd,
  startInbox,
} from '../src/index.ts'
import { drafts, must, WS } from './ledger-helpers.ts'
import { FakeClock } from './server-fixtures.ts'

/**
 * 推送节奏（add-m1-inbox 3.3；inbox spec "推送节奏"）：注入时钟，时间按系统本地时区。
 * 渠道侧的推送（4.1）接上之后再验证消息内容。
 */

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

const local = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m).getTime()

async function rig(start: number) {
  const dir = mkdtempSync(join(tmpdir(), 'flow-inbox-cadence-'))
  const home = join(dir, 'home')
  const clock = new FakeClock(start)
  const ledger = await openLedger(join(dir, 'flow.db'), { now: clock.now })
  const scheduler = await createScheduler({ ledger, clock, home })
  const flushes: number[] = []
  const inbox = await startInbox({
    ledger,
    home,
    clock,
    watch: false,
    scheduler,
    flush: async () => {
      flushes.push(clock.now())
    },
  })
  cleanups.push(async () => {
    await inbox.stop()
    scheduler.stop()
    ledger.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await inbox.idle()
      await clock.advance(0)
    }
  }
  await settle()
  return { home, clock, ledger, inbox, flushes, settle }
}

function createItem(
  ledger: LedgerStore,
  id: string,
  level: 'interrupt' | 'decide' | 'digest',
  source: 'supervisor' | 'policy' = 'supervisor',
) {
  must(
    ledger.append(
      {
        type: 'inbox.item_created',
        payload: { item_id: id, level, source, source_ref: id, title: `条目 ${id}` },
      },
      { actor: 'hub' },
    ),
  )
}

/** 建任务、开始执行、卡住；反应器据此开出 Interrupt 条目。 */
function blockTask(ledger: LedgerStore, id: string) {
  const d = drafts(id)
  must(ledger.append(d['task.created'] as EventInput, { actor: 'user' }))
  must(ledger.appendMany([d['task.started'], d['lease.granted']] as EventInput[], { actor: 'hub' }))
  return must(
    ledger.append(
      {
        task_id: id,
        workspace: WS,
        type: 'task.blocked',
        payload: { reason: 'question', message: '用哪个分支？', lease_held: true },
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

describe('定时与顺延', () => {
  test('夜间卡住：条目立即生成，deferred_until 写到 08:00；到点唤醒推送', async () => {
    const r = await rig(local(27, 2))
    const blocked = blockTask(r.ledger, 't-night')
    await r.settle()
    const id = `blk.${blocked.seq}`
    const item = r.ledger.getInboxItem(id) as InboxItemView
    expect(item.state).toBe('open')
    expect(item.deferred_until).toBe(new Date(local(27, 8)).toISOString())
    expect(r.ledger.latestEvent(undefined, 'inbox.item_updated')?.payload).toEqual({
      item_id: id,
      deferred_until: item.deferred_until,
    })
    // 此时该条目还不到推送时间
    expect(planPushes([item], 'any', r.clock.now(), { ...DEFAULT_INBOX_CADENCE })).toEqual([])
    r.flushes.length = 0
    await r.clock.advance(local(27, 8) - r.clock.now())
    await r.settle()
    expect(r.flushes).toContain(local(27, 8))
    const due = r.ledger.getInboxItem(id) as InboxItemView
    expect(planPushes([due], 'any', r.clock.now(), { ...DEFAULT_INBOX_CADENCE })).toHaveLength(1)
  })

  test('Decide 时间点（09:00、18:00）唤醒推送', async () => {
    const r = await rig(local(26, 10))
    r.flushes.length = 0
    await r.clock.advance(local(27, 9) - r.clock.now())
    await r.settle()
    expect(r.flushes).toContain(local(26, 18))
    expect(r.flushes).toContain(local(27, 9))
  })
})

describe('每日摘要', () => {
  test('08:30 生成：昨天完成与失败的任务、auto-report 记录、待处理 Decide 数、过时知识数', async () => {
    const r = await rig(local(25, 15))
    const done = drafts('t-done')
    must(r.ledger.append(done['task.created'] as EventInput, { actor: 'user' }))
    must(
      r.ledger.appendMany([done['task.started'], done['lease.granted']] as EventInput[], {
        actor: 'hub',
      }),
    )
    must(r.ledger.append(done['task.done'] as EventInput, { actor: 'node:n1' }))
    createItem(r.ledger, 'pol.1', 'digest', 'policy')
    createItem(r.ledger, 'sup.d1', 'decide')
    await r.settle()
    await r.clock.advance(local(26, 8, 30) - r.clock.now())
    await r.settle()
    const digest = r.ledger.getInboxItem('dig.2026-10-26') as InboxItemView
    expect(digest.level).toBe('digest')
    expect(digest.body).toContain('昨天（2026-10-25）完成 1 个任务，失败 0 个。')
    expect(digest.body).toContain('策略自动放行记录 1 条。')
    expect(digest.body).toContain('待处理的 Decide 条目 1 个。')
    expect(digest.body).toContain('可能过时的知识条目 0 个。')
    expect(r.ledger.getInboxItem('pol.1')?.closed?.reason).toBe('digested')
    await r.clock.advance(local(27, 8, 30) - r.clock.now())
    await r.settle()
    expect(r.ledger.getInboxItem('dig.2026-10-26')?.closed?.reason).toBe('superseded')
    await r.inbox.pusher.fireDigest()
    expect(r.ledger.listInboxItems({ source: 'digest', limit: 100 })).toHaveLength(2)
  })
})

describe('推送记录', () => {
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
