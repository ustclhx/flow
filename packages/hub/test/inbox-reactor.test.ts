import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type BlockedReason,
  INBOX_TITLE_MAX,
  type InboxConfig,
  type LedgerEvent,
  parseInboxConfig,
} from '@flow/core'
import {
  createInboxReactor,
  type EventInput,
  type InboxReactor,
  type LedgerStore,
  startInbox,
} from '../src/index.ts'
import { drafts, must, tempLedger } from './ledger-helpers.ts'

/**
 * 收件箱反应器（add-m1-inbox 3.1）：inbox spec "条目来源""默认分级""自动关闭"，
 * 以及幂等、续跑、投影重建一致。
 */

const WS = 'ws/product-res'
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

async function setup(config: Pick<InboxConfig, 'levels'> = { levels: [] }) {
  const l = await tempLedger()
  const cursorPath = join(l.dir, 'state', 'inbox-reactor.json')
  const reactors: InboxReactor[] = []
  const newReactor = () => {
    const r = createInboxReactor({ ledger: l.store, config: () => config, cursorPath })
    r.start()
    reactors.push(r)
    return r
  }
  const reactor = newReactor()
  cleanups.push(() => {
    for (const r of reactors) r.stop()
    l.cleanup()
  })
  return { ...l, cursorPath, reactor, newReactor }
}

/** 开始第 attempt 次执行（started + lease.granted 同事务）。 */
function start(store: LedgerStore, id: string, attempt: number, ws = WS) {
  const d = drafts(id, { ws, attempt })
  must(store.appendMany([d['task.started'], d['lease.granted']] as EventInput[], { actor: 'hub' }))
}

/** 建任务并开始执行。 */
function running(store: LedgerStore, id: string, ws = WS) {
  must(store.append(drafts(id, { ws })['task.created'], { actor: 'user' }))
  start(store, id, 1, ws)
}

function block(
  store: LedgerStore,
  id: string,
  reason: BlockedReason,
  o: { ws?: string; held?: boolean; prior?: BlockedReason } = {},
) {
  return must(
    store.append(
      {
        task_id: id,
        workspace: o.ws ?? WS,
        type: 'task.blocked',
        payload: {
          reason,
          message: '用哪个分支？',
          tail: ['$ git status', '问'],
          lease_held: o.held ?? true,
          ...(o.prior ? { prior_reason: o.prior } : {}),
        },
      },
      { actor: 'node:n1' },
    ),
  )
}

const inboxEvents = (store: LedgerStore) =>
  store.eventsAfter(0, {}, 10_000).filter((e) => e.type.startsWith('inbox.'))

describe('条目来源', () => {
  test('ws/product-res 的任务 blocked(question)：新增一个 Interrupt 条目，关联任务，操作为回复', async () => {
    const { store, reactor } = await setup()
    running(store, 't1')
    const blocked = block(store, 't1', 'question')
    await reactor.idle()
    const items = store.listInboxItems({ state: 'open' })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: `blk.${blocked.seq}`,
      level: 'interrupt',
      source: 'task',
      source_ref: 't1',
      reason: 'question',
      workspace: WS,
      task_id: 't1',
      actions: ['reply'],
      state: 'open',
      created_by: 'hub',
      closed: null,
    })
    expect(items[0]?.title).toContain(WS)
    expect(items[0]?.body).toContain('用哪个分支？')
    expect(items[0]?.body).toContain('$ git status')
    // 短 id 是创建事件 seq 的 base36
    const created = inboxEvents(store)[0] as LedgerEvent
    expect(items[0]?.short_id).toBe(created.seq.toString(36))
  })

  test('awaiting_approval：操作为批准、驳回、回复；节点掉线前在等授权时同样可批准', async () => {
    const { store, reactor } = await setup()
    running(store, 't1')
    block(store, 't1', 'awaiting_approval')
    await reactor.idle()
    expect(store.listInboxItems({ state: 'open' })[0]?.actions).toEqual([
      'approve',
      'deny',
      'reply',
    ])
    // 卡住期间租约过期 → blocked(node_lost, prior_reason=awaiting_approval)：旧条目被取代
    const lease = store.activeLease('t1')
    if (!lease) throw new Error('应有活动租约')
    const r = must(
      store.appendMany(
        [
          {
            task_id: 't1',
            workspace: WS,
            type: 'task.lease_expired',
            payload: {
              lease_id: lease.lease_id,
              node_id: 'n1',
              expired_at: '2026-10-24T01:00:00.000Z',
              attempt: 1,
            },
          },
          {
            task_id: 't1',
            workspace: WS,
            type: 'task.blocked',
            payload: {
              reason: 'node_lost',
              message: '节点掉线',
              prior_reason: 'awaiting_approval',
            },
          },
        ],
        { actor: 'hub' },
      ),
    )
    await reactor.idle()
    const open = store.listInboxItems({ state: 'open' })
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({
      id: `blk.${r[1]?.seq}`,
      reason: 'node_lost',
      level: 'interrupt',
      actions: ['approve', 'deny', 'reply'],
    })
    const closed = store.listInboxItems({ state: 'closed' })
    expect(closed).toHaveLength(1)
    expect(closed[0]?.closed?.reason).toBe('superseded')
  })

  test('policy.decided 的 auto-report 生成 Digest 条目，其他档位不生成；任务结束不关闭它', async () => {
    const { store, reactor } = await setup()
    running(store, 't1')
    const decided = (level: 'auto-report' | 'auto', command: string) =>
      must(
        store.append(
          {
            task_id: 't1',
            workspace: WS,
            type: 'policy.decided',
            payload: {
              task_id: 't1',
              request: { tool: 'Bash', actions: ['tool:Bash', 'git.push'], command },
              level,
              matched_rules: [],
              actions: [{ action: 'git.push', level, matched_rules: [], guarded: false }],
            },
          },
          { actor: 'policy' },
        ),
      )
    const reported = decided('auto-report', 'git push origin feat')
    decided('auto', 'git push origin main')
    await reactor.idle()
    const items = store.listInboxItems()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: `pol.${reported.seq}`,
      level: 'digest',
      source: 'policy',
      workspace: WS,
      task_id: 't1',
      actions: [],
    })
    expect(items[0]?.title).toContain('git.push')
    expect(items[0]?.body).toContain('git push origin feat')
    must(store.append(drafts('t1', { ws: WS })['task.done'], { actor: 'node:n1' }))
    await reactor.idle()
    expect(store.getInboxItem(`pol.${reported.seq}`)?.state).toBe('open')
  })

  test('卡住后立刻恢复（同一批写入）不开条目；旧账本上已结束的卡住不补开', async () => {
    const { store, reactor } = await setup()
    running(store, 't1')
    must(
      store.appendMany(
        [
          {
            task_id: 't1',
            workspace: WS,
            type: 'task.blocked',
            payload: { reason: 'question', message: '?', lease_held: true },
          },
          { task_id: 't1', workspace: WS, type: 'task.unblocked', payload: {} },
        ],
        { actor: 'node:n1' },
      ),
    )
    await reactor.idle()
    expect(inboxEvents(store)).toEqual([])
  })
})

describe('默认分级', () => {
  const cases: [BlockedReason, string][] = [
    ['awaiting_approval', 'interrupt'],
    ['question', 'interrupt'],
    ['crashed', 'interrupt'],
    ['node_lost', 'interrupt'],
    ['no_progress', 'decide'],
    ['other', 'decide'],
  ]
  test('按卡住原因取默认级别', async () => {
    const { store, reactor } = await setup()
    cases.forEach(([reason], i) => {
      running(store, `t${i}`)
      block(store, `t${i}`, reason)
    })
    await reactor.idle()
    const byTask = new Map(store.listInboxItems().map((it) => [it.task_id, it.level]))
    cases.forEach(([, level], i) => {
      expect(byTask.get(`t${i}`)).toBe(level as never)
    })
  })

  test('inbox.yaml 把 no_progress 设为 Digest：之后的 no_progress 只进摘要；写错的规则不影响其他规则', async () => {
    const parsed = must(
      parseInboxConfig({
        levels: [
          { reason: 'no_progres', level: 'interrupt' },
          { reason: 'no_progress', level: 'Digest' },
          { source: 'task', workspace: 'ws/other', reason: 'question', level: 'decide' },
        ],
      }),
    )
    expect(parsed.errors.map((e) => e.rule_index)).toEqual([0])
    const { store, reactor } = await setup(parsed)
    running(store, 'a')
    block(store, 'a', 'no_progress')
    running(store, 'b', 'ws/other')
    block(store, 'b', 'question', { ws: 'ws/other' })
    running(store, 'c')
    block(store, 'c', 'question')
    await reactor.idle()
    const byTask = new Map(store.listInboxItems().map((it) => [it.task_id, it.level]))
    expect(byTask.get('a')).toBe('digest')
    expect(byTask.get('b')).toBe('decide')
    expect(byTask.get('c')).toBe('interrupt')
  })

  test('startInbox 读取 config/inbox.yaml 并热加载', async () => {
    const l = await tempLedger()
    const home = join(l.dir, 'home')
    mkdirSync(join(home, 'config'), { recursive: true })
    writeFileSync(
      join(home, 'config', 'inbox.yaml'),
      'levels:\n  - reason: no_progress\n    level: digest\n  - reason: 42\n    level: decide\n',
    )
    const warnings: unknown[] = []
    const clock = { now: Date.now, setTimeout: () => () => {} }
    const inbox = await startInbox({
      ledger: l.store,
      home,
      clock,
      watch: false,
      logger: { warn: (_m, d) => warnings.push(d) },
    })
    cleanups.push(() => {
      inbox.stop()
      l.cleanup()
    })
    expect(inbox.config().levels).toHaveLength(1)
    expect(warnings).toHaveLength(1)
    running(l.store, 't1')
    block(l.store, 't1', 'no_progress')
    await inbox.idle()
    expect(l.store.listInboxItems()[0]?.level).toBe('digest')

    writeFileSync(join(home, 'config', 'inbox.yaml'), 'levels: []\n')
    await inbox.reloadConfig()
    running(l.store, 't2')
    block(l.store, 't2', 'no_progress')
    await inbox.idle()
    expect(l.store.listInboxItems({ task_id: 't2' })[0]?.level).toBe('decide')
    // 之前的条目级别不变
    expect(l.store.listInboxItems({ task_id: 't1' })[0]?.level).toBe('digest')
  })
})

describe('自动关闭', () => {
  test('用户答复送达、任务回到 running：条目关闭，原因 task_running，答复者为 user', async () => {
    const { store, reactor } = await setup()
    running(store, 't1')
    block(store, 't1', 'question')
    await reactor.idle()
    must(
      store.append(
        {
          task_id: 't1',
          workspace: WS,
          type: 'task.replied',
          payload: { reply_id: 'r-1', kind: 'text', text: '用 main 分支' },
        },
        { actor: 'user' },
      ),
    )
    await reactor.idle()
    expect(store.listInboxItems({ state: 'open' })).toHaveLength(1)
    const unblocked = must(
      store.append(
        { task_id: 't1', workspace: WS, type: 'task.unblocked', payload: { reply_id: 'r-1' } },
        { actor: 'node:n1' },
      ),
    )
    await reactor.idle()
    expect(store.listInboxItems({ state: 'open' })).toEqual([])
    const [item] = store.listInboxItems({ state: 'closed' })
    expect(item?.closed).toMatchObject({
      reason: 'task_running',
      by: 'hub',
      cause_actor: 'user',
      via: null,
    })
    const closedEvent = inboxEvents(store).at(-1)
    expect(closedEvent).toMatchObject({
      type: 'inbox.item_closed',
      task_id: 't1',
      payload: { cause_seq: unblocked.seq },
    })
  })

  test('带回复重新排队、人工重新排队、失败、取消：各自注明原因', async () => {
    const { store, reactor } = await setup()
    const ids = ['q', 'm', 'f', 'c'] as const
    for (const id of ids) {
      running(store, id)
      block(store, id, 'question', { held: false })
    }
    await reactor.idle()
    expect(store.listInboxItems({ state: 'open' })).toHaveLength(4)
    must(
      store.appendMany(
        [
          {
            task_id: 'q',
            workspace: WS,
            type: 'task.replied',
            payload: { reply_id: 'r-q', kind: 'text', text: '好' },
          },
          {
            task_id: 'q',
            workspace: WS,
            type: 'task.requeued_with_reply',
            payload: { reply_id: 'r-q' },
          },
        ],
        { actor: 'user' },
      ),
    )
    must(store.append(drafts('m', { ws: WS })['task.requeued:manual'], { actor: 'agent:claude' }))
    must(store.append(drafts('f', { ws: WS })['task.failed'], { actor: 'user' }))
    must(store.append(drafts('c', { ws: WS })['task.cancelled'], { actor: 'user' }))
    await reactor.idle()
    const reasons = new Map(
      store.listInboxItems({ state: 'closed' }).map((it) => [it.task_id, it.closed]),
    )
    expect(reasons.get('q')).toMatchObject({ reason: 'task_queued', cause_actor: 'user' })
    expect(reasons.get('m')).toMatchObject({ reason: 'task_queued', cause_actor: 'agent:claude' })
    expect(reasons.get('f')?.reason).toBe('task_failed')
    expect(reasons.get('c')?.reason).toBe('task_cancelled')
  })

  test('恢复后再次卡住开新条目，进入终态后关闭', async () => {
    const { store, reactor } = await setup()
    running(store, 't1')
    block(store, 't1', 'crashed')
    must(store.append(drafts('t1', { ws: WS })['task.unblocked'], { actor: 'node:n1' }))
    block(store, 't1', 'other')
    await reactor.idle()
    expect(store.listInboxItems({ state: 'open' })).toHaveLength(1)
    must(store.append(drafts('t1', { ws: WS })['task.failed'], { actor: 'user' }))
    await reactor.idle()
    expect(store.listInboxItems({ state: 'open' })).toEqual([])
  })
})

describe('幂等、续跑与重建', () => {
  test('重放源事件不重复开条目、不误关后来的条目；重建投影后条目一致', async () => {
    const { store, reactor } = await setup()
    running(store, 't1')
    const first = block(store, 't1', 'question')
    must(store.append(drafts('t1', { ws: WS })['task.unblocked'], { actor: 'node:n1' }))
    const unblock = store.eventsAfter(0, { task_id: 't1' }, 1000).at(-1) as LedgerEvent
    const second = block(store, 't1', 'question')
    await reactor.idle()
    const before = store.snapshot({ includeSoft: false }).inbox_items
    const seq = store.seq()
    // 直接重放旧事件：已存在的条目不重复创建，旧的 unblocked 不关闭后来开的条目
    const fresh = createInboxReactor({ ledger: store })
    for (const e of [first, unblock, second]) fresh.handle(e)
    await fresh.idle()
    expect(store.seq()).toBe(seq)
    expect(store.listInboxItems({ state: 'open' }).map((i) => i.id)).toEqual([`blk.${second.seq}`])

    must(store.rebuild())
    expect(store.snapshot({ includeSoft: false }).inbox_items).toEqual(before)
    // 重建只写 hub.rebuilt，反应器不因此写任何东西
    await reactor.idle()
    expect(store.seq()).toBe(seq + 1)
  })

  test('中枢重启：从上次处理的位置续跑，停机期间的卡住与恢复都被处理；没有游标文件时从账本推导', async () => {
    const { store, reactor, newReactor, cursorPath } = await setup()
    running(store, 't1')
    running(store, 't2')
    block(store, 't1', 'question')
    await reactor.idle()
    reactor.stop()
    expect(existsSync(cursorPath)).toBe(true)

    // 停机期间：t1 恢复，t2 卡住
    must(store.append(drafts('t1', { ws: WS })['task.unblocked'], { actor: 'node:n1' }))
    block(store, 't2', 'awaiting_approval')
    const r2 = newReactor()
    await r2.idle()
    expect(store.listInboxItems({ state: 'open' }).map((i) => i.task_id)).toEqual(['t2'])
    expect(store.listInboxItems({ task_id: 't1' })[0]?.closed?.reason).toBe('task_running')
    r2.stop()

    const count = inboxEvents(store).length
    rmSync(cursorPath)
    expect(store.inboxCursor()).toBeGreaterThan(0)
    const r3 = newReactor()
    await r3.idle()
    expect(inboxEvents(store)).toHaveLength(count)
  })

  test('性质：随机事件序列 + 中途重启与重建，卡住的任务恰有一个未关闭条目，其余没有', async () => {
    const seen = { open: 0, closed: 0, superseded: 0 }
    for (let seed = 1; seed <= 30; seed++) {
      let a = seed
      const rnd = () => {
        a = (a * 1103515245 + 12345) % 2147483648
        return a / 2147483648
      }
      const { store, newReactor } = await setup()
      let reactor = newReactor()
      const reasons: BlockedReason[] = ['question', 'awaiting_approval', 'no_progress', 'crashed']
      const tasks: string[] = []
      let attempt = new Map<string, number>()
      for (let step = 0; step < 40; step++) {
        const roll = rnd()
        if (tasks.length === 0 || roll < 0.15) {
          const id = `t${tasks.length}`
          running(store, id)
          attempt.set(id, 1)
          tasks.push(id)
          continue
        }
        if (roll < 0.2) {
          await reactor.idle()
          reactor.stop()
          reactor = newReactor()
          continue
        }
        if (roll < 0.25) {
          must(store.rebuild())
          continue
        }
        const id = tasks[Math.floor(rnd() * tasks.length)] as string
        const status = store.getTask(id)?.status
        const n = attempt.get(id) ?? 1
        const d = drafts(id, { ws: WS, attempt: n })
        if (status === 'running') {
          const pick = rnd()
          if (pick < 0.6) block(store, id, reasons[Math.floor(rnd() * reasons.length)] as never)
          else if (pick < 0.8) must(store.append(d['task.done'], { actor: 'node:n1' }))
          else must(store.append(d['task.cancelled'], { actor: 'user' }))
        } else if (status === 'blocked') {
          const pick = rnd()
          if (pick < 0.4 && store.activeLease(id)) {
            must(store.append(d['task.unblocked'], { actor: 'node:n1' }))
          } else if (pick < 0.6) {
            block(store, id, 'crashed', { held: false })
          } else if (pick < 0.8) {
            must(store.append(d['task.requeued:manual'], { actor: 'user' }))
          } else must(store.append(d['task.failed'], { actor: 'user' }))
        } else if (status === 'queued') {
          attempt.set(id, n + 1)
          start(store, id, n + 1)
        }
        if (rnd() < 0.3) await reactor.idle()
      }
      await reactor.idle()
      for (const id of tasks) {
        const open = store.listInboxItems({ task_id: id, state: 'open' })
        const task = store.getTask(id)
        if (task?.status === 'blocked') {
          const lastBlocked = store
            .taskEvents(id)
            .filter((e) => e.type === 'task.blocked')
            .at(-1)
          expect(open.map((i) => i.id)).toEqual([`blk.${lastBlocked?.seq}`])
        } else expect(open).toEqual([])
      }
      for (const it of store.listInboxItems({ limit: 10_000 })) {
        if (it.state === 'open') seen.open++
        else seen.closed++
        if (it.closed?.reason === 'superseded') seen.superseded++
      }
      const snap = store.snapshot({ includeSoft: false }).inbox_items
      const seq = store.seq()
      must(store.rebuild())
      expect(store.snapshot({ includeSoft: false }).inbox_items).toEqual(snap)
      const again = newReactor()
      await again.idle()
      expect(store.seq()).toBe(seq + 1)
      attempt = new Map()
    }
    expect(seen.open).toBeGreaterThan(5)
    expect(seen.closed).toBeGreaterThan(20)
    expect(seen.superseded).toBeGreaterThan(0)
  }, 60_000)
})

describe('账本层的约束与脱敏', () => {
  test('重复创建、关闭不存在或已关闭的条目被拒绝；标题超长被截断，疑似密钥被脱敏', async () => {
    const { store } = await setup()
    const fakeToken = ['gh', 'p_', 'Z'.repeat(36)].join('')
    const created = must(
      store.append(
        {
          type: 'inbox.item_created',
          payload: {
            item_id: 'prop.x',
            level: 'decide',
            source: 'proposal',
            source_ref: 'x',
            title: '长'.repeat(300),
            body: `日志里有 ${fakeToken}`,
          },
        },
        { actor: 'hub' },
      ),
    )
    expect(created.type).toBe('inbox.item_created')
    const item = store.getInboxItem('prop.x')
    expect(item?.title.length).toBe(INBOX_TITLE_MAX)
    expect(item?.body).not.toContain(fakeToken)
    expect(item?.body).toContain('[REDACTED:github-token]')
    const dup = store.append(
      {
        type: 'inbox.item_created',
        payload: {
          item_id: 'prop.x',
          level: 'decide',
          source: 'proposal',
          source_ref: 'x',
          title: 't',
        },
      },
      { actor: 'hub' },
    )
    expect(dup.ok ? null : dup.error.code).toBe('duplicate_item')
    const missing = store.append(
      { type: 'inbox.item_closed', payload: { item_id: 'prop.y', reason: 'dismissed' } },
      { actor: 'user' },
    )
    expect(missing.ok ? null : missing.error.code).toBe('not_found')
    must(
      store.append(
        {
          type: 'inbox.item_closed',
          payload: { item_id: 'prop.x', reason: 'dismissed', via: 'web' },
        },
        { actor: 'user' },
      ),
    )
    const again = store.append(
      { type: 'inbox.item_closed', payload: { item_id: 'prop.x', reason: 'dismissed' } },
      { actor: 'user' },
    )
    expect(again.ok ? null : again.error.code).toBe('item_closed')
    expect(store.getInboxItem('prop.x')?.closed).toMatchObject({ by: 'user', via: 'web' })
    const update = store.append(
      { type: 'inbox.item_updated', payload: { item_id: 'prop.x', level: 'digest' } },
      { actor: 'hub' },
    )
    expect(update.ok ? null : update.error.code).toBe('item_closed')
  })

  test('inbox.item_updated 改级别与顺延时间，重建后一致', async () => {
    const { store } = await setup()
    must(
      store.append(
        {
          type: 'inbox.item_created',
          payload: {
            item_id: 'prop.z',
            level: 'interrupt',
            source: 'proposal',
            source_ref: 'z',
            title: 't',
          },
        },
        { actor: 'hub' },
      ),
    )
    must(
      store.append(
        {
          type: 'inbox.item_updated',
          payload: {
            item_id: 'prop.z',
            level: 'decide',
            deferred_until: '2026-10-25T00:00:00.000Z',
          },
        },
        { actor: 'hub' },
      ),
    )
    expect(store.getInboxItem('prop.z')).toMatchObject({
      level: 'decide',
      deferred_until: '2026-10-25T00:00:00.000Z',
    })
    const snap = store.snapshot({ includeSoft: false }).inbox_items
    must(store.rebuild())
    expect(store.snapshot({ includeSoft: false }).inbox_items).toEqual(snap)
  })
})
