import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flowPaths, type InboxItemView, initFlowHome, ok, registerKnownSecrets } from '@flow/core'
import {
  ChannelError,
  type ChannelMessage,
  clipTailText,
  closedLabel,
  createHubSecrets,
  type EventInput,
  type LedgerStore,
  openLedger,
  type RunningHub,
  runHub,
  SecretRedactor,
} from '../src/index.ts'
import {
  closeItem,
  createItem,
  inboxRig,
  local,
  MemoryChannel,
  specOf,
} from './channel-fixtures.ts'
import { drafts, must, WS } from './ledger-helpers.ts'

/** 渠道接口与渠道管理器（add-m1-inbox 4.1；notify-channel spec 全部场景，用内存假渠道）。 */

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

async function rig(channels: MemoryChannel[], o: Parameters<typeof inboxRig>[0] = {}) {
  const r = await inboxRig({ start: local(26, 10), channels: channels.map((c) => specOf(c)), ...o })
  cleanups.push(r.cleanup)
  await r.settle()
  return r
}

const itemOf = (m: ChannelMessage | undefined) => {
  if (m?.kind !== 'item') throw new Error('不是单条消息')
  return m.item
}

/** 不像真实密钥的占位 token（运行时拼出，测试源码中没有密钥形态的字面量）。 */
const fakeToken = () => ['cfplaceholder', 'x'.repeat(24), 'end'].join('-')

function blockWithTail(ledger: LedgerStore, id: string, tail: string[]) {
  const d = drafts(id)
  must(ledger.append(d['task.created'] as EventInput, { actor: 'user' }))
  must(ledger.appendMany([d['task.started'], d['lease.granted']] as EventInput[], { actor: 'hub' }))
  return must(
    ledger.append(
      {
        task_id: id,
        workspace: WS,
        type: 'task.blocked',
        payload: { reason: 'question', message: '部署时报错了', tail, lease_held: true },
      },
      { actor: 'node:n1' },
    ),
  )
}

describe('渠道暂时不可用', () => {
  test('连续失败：记录警告、指数退避（最长 5 分钟），条目保留 pending，恢复后补推', async () => {
    const down = new MemoryChannel('flaky')
    down.down = true
    const other = new MemoryChannel('steady')
    const r = await rig([down, other])
    createItem(r.ledger, 'sup.1', 'interrupt')
    await r.settle()
    await r.inbox.pusher.tick()

    // 其他渠道照常推送
    expect(other.sentIds()).toEqual([['sup.1']])
    expect(down.sent).toHaveLength(0)
    const status = () => r.inbox.channels.status().find((s) => s.id === 'flaky')
    expect(status()).toMatchObject({ state: 'backoff', failures: 1 })
    expect(status()?.last_error).toContain('请求失败')
    expect(r.warns.some((w) => w.message.includes('渠道调用失败'))).toBe(true)
    // 条目仍保留在收件箱，该渠道上没有推送记录
    const item = r.ledger.getInboxItem('sup.1') as InboxItemView
    expect(item.state).toBe('open')
    expect(item.channels.map((c) => c.channel)).toEqual(['steady'])

    // 退避间隔：1s、2s、4s… 最长 5 分钟
    const delays: number[] = []
    for (let i = 0; i < 12; i++) {
      const before = status()?.next_retry_at as string
      delays.push(Date.parse(before) - r.clock.now())
      await r.clock.advance(Date.parse(before) - r.clock.now())
      await r.settle()
    }
    expect(delays.slice(0, 5)).toEqual([1000, 2000, 4000, 8000, 16000])
    expect(Math.max(...delays)).toBe(300_000)
    expect(delays.at(-1)).toBe(300_000)
    // 期间中枢其他功能正常：账本照常写入
    createItem(r.ledger, 'sup.2', 'interrupt')
    await r.settle()
    expect(other.sentIds()).toEqual([['sup.1'], ['sup.2']])

    // 恢复后补推全部 pending 条目
    down.down = false
    await r.clock.advance(Date.parse(status()?.next_retry_at as string) - r.clock.now())
    await r.settle()
    expect(down.sentIds()).toEqual([['sup.1'], ['sup.2']])
    expect(status()).toMatchObject({ state: 'running', failures: 0, last_error: null })
    expect(r.warns.some((w) => w.message.includes('渠道已恢复'))).toBe(true)
  })

  test('渠道调用挂起：超时按失败处理，不影响其他渠道', async () => {
    const stuck = new MemoryChannel('stuck')
    stuck.hang = true
    const other = new MemoryChannel('steady')
    const r = await rig([stuck, other])
    createItem(r.ledger, 'sup.h', 'interrupt')
    await r.settle()
    expect(other.sentIds()).toEqual([['sup.h']])
    await r.clock.advance(30_000)
    await r.settle()
    expect(r.inbox.channels.status().find((s) => s.id === 'stuck')?.state).toBe('backoff')
    stuck.hang = false
    await r.clock.advance(1000)
    await r.settle()
    expect(stuck.sentIds()).toEqual([['sup.h']])
  })

  test('start 失败也按退避重试；创建失败的渠道不启动，其他渠道照常', async () => {
    const late = new MemoryChannel('late')
    late.startFailures = 2
    const steady = new MemoryChannel('steady')
    const r = await rig([late, steady], {
      channels: [
        specOf(late),
        specOf(steady),
        {
          id: 'broken',
          create: () => {
            throw new Error('配置不对')
          },
        },
      ],
    })
    createItem(r.ledger, 'sup.s', 'interrupt')
    await r.settle()
    expect(steady.sentIds()).toEqual([['sup.s']])
    expect(r.inbox.channels.status().find((s) => s.id === 'broken')?.state).toBe('disabled')
    await r.clock.advance(1000 + 2000)
    await r.settle()
    expect(late.started).toBe(1)
    expect(late.sentIds()).toEqual([['sup.s']])
  })
})

describe('单条消息的失败不卡住渠道', () => {
  const statusOf = (r: Awaited<ReturnType<typeof rig>>, id = 'memory') =>
    r.inbox.channels.status().find((s) => s.id === id)

  test('update 遇到永久错误（要编辑的消息已不存在）：记为推送失败，后面的 Interrupt 照常推送', async () => {
    const ch = new MemoryChannel()
    const r = await rig([ch])
    createItem(r.ledger, 'sup.gone', 'interrupt')
    await r.settle()
    await r.inbox.pusher.tick()
    ch.failWith = (op) =>
      op === 'update' ? new ChannelError('message to edit not found', 'permanent') : undefined
    closeItem(r.ledger, 'sup.gone', { cause_actor: 'user' })
    createItem(r.ledger, 'sup.next', 'interrupt')
    await r.settle()
    await r.inbox.pusher.tick()
    expect(ch.sentIds()).toEqual([['sup.gone'], ['sup.next']])
    expect(ch.updateCalls).toBe(1)
    const failed = r.ledger.latestEvent(undefined, 'inbox.pushed')
    expect(
      r.ledger
        .eventsAfter(0)
        .filter((e) => e.type === 'inbox.pushed')
        .map((e) => e.payload),
    ).toContainEqual({
      channel: 'memory',
      ref: 'memory-1',
      op: 'failed',
      kind: 'item',
      item_ids: ['sup.gone'],
      reason: 'message to edit not found',
    })
    expect(failed).not.toBeNull()
    expect(r.ledger.getInboxItem('sup.gone')?.channels[0]?.failed?.reason).toBe(
      'message to edit not found',
    )
    expect(r.ledger.pendingChannelUpdates('memory')).toEqual([])
    expect(statusOf(r)).toMatchObject({ state: 'running', failures: 0, failed_items: 1 })
    // 不再重试
    await r.inbox.pusher.tick()
    expect(ch.updateCalls).toBe(1)
  })

  test('send 的消息级失败只跳过这一条；连续 5 次后放弃，投影视为已处理', async () => {
    const ch = new MemoryChannel()
    const r = await rig([ch])
    ch.failWith = (op, m) =>
      op === 'send' && MemoryChannel.ids(m).includes('sup.bad')
        ? new ChannelError('message is too long', 'message')
        : undefined
    createItem(r.ledger, 'sup.bad', 'interrupt')
    createItem(r.ledger, 'sup.ok', 'interrupt')
    await r.settle()
    await r.inbox.pusher.tick()
    expect(ch.sentIds()).toEqual([['sup.ok']])
    expect(statusOf(r)).toMatchObject({ state: 'running', failed_items: 0 })
    for (let i = 0; i < 4; i++) await r.inbox.pusher.tick()
    expect(ch.sendCalls).toBe(6)
    const item = r.ledger.getInboxItem('sup.bad') as InboxItemView
    expect(item.state).toBe('open')
    expect(item.pushed_at).toBeNull()
    expect(item.channels).toMatchObject([
      { channel: 'memory', ref: null, failed: { reason: '连续 5 次失败：message is too long' } },
    ])
    expect(statusOf(r)?.failed_items).toBe(1)
    await r.inbox.pusher.tick()
    expect(ch.sendCalls).toBe(6)
    // 重建后一致
    const before = r.ledger.snapshot({ includeSoft: false })
    must(r.ledger.rebuild())
    expect(r.ledger.snapshot({ includeSoft: false }).channel_messages).toEqual(
      before.channel_messages,
    )
  })

  test('未分类的错误按传输层错误处理：整个渠道退避', async () => {
    const ch = new MemoryChannel()
    const r = await rig([ch])
    ch.failWith = () => new Error('奇怪的错误')
    createItem(r.ledger, 'sup.u1', 'interrupt')
    createItem(r.ledger, 'sup.u2', 'interrupt')
    await r.settle()
    expect(ch.sendCalls).toBe(1)
    expect(statusOf(r)?.state).toBe('backoff')
  })
})

describe('超时不重复推送', () => {
  test('超时后 abort；原请求仍在进行时不重发，最终成功只记录一次', async () => {
    const ch = new MemoryChannel()
    ch.slow = true
    const r = await rig([ch])
    createItem(r.ledger, 'sup.slow', 'interrupt')
    await r.settle()
    expect(ch.sendCalls).toBe(1)
    await r.clock.advance(30_000)
    await r.settle()
    expect(ch.aborted).toBe(1)
    expect(r.inbox.channels.status()[0]?.state).toBe('backoff')
    // 退避结束：原请求还在进行，不再发起第二次
    await r.clock.advance(5_000)
    await r.settle()
    expect(ch.sendCalls).toBe(1)
    ch.slow = false
    ch.releaseSends()
    await r.settle()
    expect(ch.sentIds()).toEqual([['sup.slow']])
    const sends = r.ledger
      .eventsAfter(0)
      .filter((e) => e.type === 'inbox.pushed' && e.payload.op === 'send')
    expect(sends).toHaveLength(1)
    await r.clock.advance(10_000)
    await r.settle()
    expect(ch.sendCalls).toBe(1)
  })

  test('同一条消息超时 3 次后记为推送失败', async () => {
    const ch = new MemoryChannel()
    ch.hang = true
    const r = await rig([ch])
    createItem(r.ledger, 'sup.t', 'interrupt')
    await r.settle()
    for (let i = 0; i < 3; i++) {
      await r.clock.advance(30_000)
      await r.settle()
      const retry = r.inbox.channels.status()[0]?.next_retry_at
      if (retry) await r.clock.advance(Date.parse(retry) - r.clock.now())
      await r.settle()
    }
    expect(ch.sendCalls).toBe(3)
    expect(r.ledger.getInboxItem('sup.t')?.channels[0]?.failed?.reason).toContain('连续 3 次超时')
    ch.hang = false
    await r.clock.advance(60_000)
    await r.settle()
    expect(ch.sendCalls).toBe(3)
  })

  test('渠道返回无效的消息引用：按已发出记录（占位引用）并告警，不重发；关闭后不调用 update', async () => {
    const ch = new MemoryChannel()
    ch.badRef = true
    const r = await rig([ch])
    createItem(r.ledger, 'sup.ref', 'interrupt')
    await r.settle()
    await r.inbox.pusher.tick()
    await r.inbox.pusher.tick()
    expect(ch.sendCalls).toBe(1)
    expect(r.warns.some((w) => w.message.includes('消息引用无效'))).toBe(true)
    const ref = r.ledger.getInboxItem('sup.ref')?.channels[0]?.ref
    expect(ref?.startsWith('!invalid-ref:')).toBe(true)
    closeItem(r.ledger, 'sup.ref')
    await r.settle()
    await r.inbox.pusher.tick()
    expect(ch.updateCalls).toBe(0)
    expect(r.ledger.getInboxItem('sup.ref')?.channels[0]?.failed).not.toBeNull()
    expect(r.ledger.pendingChannelUpdates('memory')).toEqual([])
  })
})

describe('推送与已处理同步', () => {
  test('推送前确认条目仍 open：已关闭的条目不推送', async () => {
    const ch = new MemoryChannel()
    const r = await rig([ch])
    // 同一批写入里条目就被关闭（例如刚生成就被用户在终端处理）
    must(
      r.ledger.appendMany(
        [
          {
            type: 'inbox.item_created',
            payload: {
              item_id: 'sup.x',
              level: 'interrupt',
              source: 'supervisor',
              source_ref: 'x',
              title: '问',
            },
          },
          { type: 'inbox.item_closed', payload: { item_id: 'sup.x', reason: 'answered' } },
        ],
        { actor: 'hub' },
      ),
    )
    await r.settle()
    await r.inbox.pusher.tick()
    expect(ch.sent).toHaveLength(0)
  })

  test('条目关闭后消息改为"已处理（来自 CLI）"，按钮消失；同步只做一次，重启后不重复', async () => {
    const ch = new MemoryChannel()
    const r = await rig([ch])
    createItem(r.ledger, 'sup.c', 'interrupt', { actions: ['reply'] })
    await r.settle()
    await r.inbox.pusher.tick()
    expect(itemOf(ch.sent[0]?.message).actions).toEqual(['reply'])

    closeItem(r.ledger, 'sup.c', { cause_actor: 'user' })
    await r.settle()
    await r.inbox.pusher.tick()
    expect(ch.updates).toHaveLength(1)
    const updated = itemOf(ch.updates[0]?.message)
    expect(ch.updates[0]?.ref).toBe(ch.sent[0]?.ref as string)
    expect(updated.state).toBe('closed')
    expect(updated.actions).toEqual([])
    expect(updated.closed?.label).toBe('已处理（来自 CLI）')
    const ev = r.ledger.latestEvent(undefined, 'inbox.pushed')
    expect(ev?.payload).toMatchObject({ op: 'update', item_ids: ['sup.c'] })
    expect(r.ledger.getInboxItem('sup.c')?.channels[0]?.synced_at).not.toBeNull()

    await r.inbox.pusher.tick()
    expect(ch.updates).toHaveLength(1)
  })

  test('同步失败时保留，渠道恢复后补做', async () => {
    const ch = new MemoryChannel()
    const r = await rig([ch])
    createItem(r.ledger, 'sup.u', 'interrupt')
    await r.settle()
    await r.inbox.pusher.tick()
    ch.down = true
    closeItem(r.ledger, 'sup.u', { via: 'web' })
    await r.settle()
    expect(ch.updates).toHaveLength(0)
    expect(r.ledger.pendingChannelUpdates('memory')).toEqual([
      { ref: 'memory-1', item_ids: ['sup.u'] },
    ])
    ch.down = false
    await r.clock.advance(1000)
    await r.settle()
    expect(itemOf(ch.updates[0]?.message).closed?.label).toBe('已处理（来自 网页）')
    expect(r.ledger.pendingChannelUpdates('memory')).toEqual([])
  })

  test('关闭说明', () => {
    const base = {
      note: null,
      at: '2026-10-26T00:00:00.000Z',
      by: 'hub',
      cause_actor: null,
      via: null,
    }
    expect(closedLabel({ ...base, reason: 'task_running', via: 'telegram' })).toBe(
      '已处理（来自 Telegram）',
    )
    expect(closedLabel({ ...base, reason: 'task_running', cause_actor: 'user' })).toBe(
      '已处理（来自 CLI）',
    )
    expect(closedLabel({ ...base, reason: 'task_done' })).toBe('已处理（任务已完成）')
    expect(closedLabel({ ...base, reason: 'dismissed', by: 'user', via: 'web' })).toBe(
      '已忽略（来自 网页）',
    )
  })
})

describe('外发内容脱敏', () => {
  test('终端片段里有已知 token：推送的消息中该值被替换为脱敏标记', async () => {
    const ch = new MemoryChannel('telegram')
    const r = await rig([ch])
    const token = fakeToken()
    // 卡住事件入账时名单里还没有这个值（模拟密钥在事件入账之后才加入名单）：外发前仍要再脱敏一次。
    const blocked = blockWithTail(r.ledger, 't-tok', [
      '$ wrangler deploy',
      `使用的凭据 ${token} 已过期`,
      'Error: 403',
    ])
    expect(JSON.stringify(blocked.payload)).toContain(token)
    const redactor = new SecretRedactor()
    redactor.add('cloudflare/api-token', token)
    const unregister = registerKnownSecrets(redactor.redact)
    cleanups.push(unregister)

    await r.settle()
    await r.inbox.pusher.tick()
    const sent = JSON.stringify(ch.sent)
    expect(sent).not.toContain(token)
    const item = itemOf(ch.sent[0]?.message)
    expect(item.snippet).toContain('[secret:cloudflare/api-token]')
    expect(item.text).toBe('部署时报错了')
  })

  test('疑似密钥（正则兜底）也被替换；终端片段截断到末尾 1500 字符（可配置）', async () => {
    const ch = new MemoryChannel()
    const r = await rig([ch])
    const ghLike = `ghp_${'A1b2'.repeat(9)}`
    const filler = Array.from({ length: 60 }, (_, i) => `line ${i} ${'.'.repeat(40)}`)
    blockWithTail(r.ledger, 't-long', [...filler, `export GITHUB_TOKEN=${ghLike}`, '最后一行'])
    await r.settle()
    await r.inbox.pusher.tick()
    const item = itemOf(ch.sent[0]?.message)
    expect(JSON.stringify(ch.sent)).not.toContain(ghLike)
    expect(item.snippet).toContain('[REDACTED:')
    expect(item.snippet?.length).toBe(1500)
    expect(item.snippet?.startsWith('…')).toBe(true)
    expect(item.snippet?.endsWith('最后一行')).toBe(true)

    mkdirSync(join(r.home, 'config'), { recursive: true })
    writeFileSync(join(r.home, 'config', 'inbox.yaml'), 'snippet_max_chars: 0\n')
    await r.inbox.reloadConfig()
    blockWithTail(r.ledger, 't-none', ['$ ls'])
    await r.settle()
    await r.inbox.pusher.tick()
    expect(itemOf(ch.sent[1]?.message).snippet).toBeNull()
  })

  test('clipTailText', () => {
    expect(clipTailText('abcdef', 4)).toBe('…def')
    expect(clipTailText('abc', 4)).toBe('abc')
    expect(clipTailText('abc', 0)).toBe('')
  })
})

describe('入站操作', () => {
  test('按短 id 找到条目，调用收件箱操作并带上渠道的 via；错误不影响渠道', async () => {
    const calls: unknown[][] = []
    const ch = new MemoryChannel('telegram', 'telegram')
    let throwNext = false
    const r = await rig([ch], {
      act: async (...args) => {
        calls.push(args)
        if (throwNext) throw new Error('炸了')
        return ok({})
      },
    })
    createItem(r.ledger, 'sup.in', 'interrupt')
    await r.settle()
    const item = r.ledger.getInboxItem('sup.in') as InboxItemView
    const handler = ch.handler
    if (!handler) throw new Error('渠道未启动')

    expect(await handler({ item: item.short_id, action: 'reply', text: '用 main' })).toEqual(
      ok({ item_id: 'sup.in' }),
    )
    expect(calls).toEqual([['sup.in', 'reply', '用 main', 'telegram']])
    const missing = await handler({ item: 'zzzz', action: 'dismiss' })
    expect(!missing.ok && missing.error.code).toBe('not_found')
    throwNext = true
    const failed = await handler({ item: 'sup.in', action: 'dismiss' })
    expect(!failed.ok && failed.error.code).toBe('act_failed')
  })
})

describe('缺少密钥', () => {
  test('渠道依赖的密钥缺失时不启动，状态中列出缺少的路径；补上后 refresh 启动', async () => {
    const ch = new MemoryChannel('telegram')
    const values = new Map<string, string>()
    const secrets = createHubSecrets({
      home: join(tmpdir(), 'flow-sec-unused'),
      load: async () => ok(values),
    })
    const created: unknown[] = []
    const r = await rig([], {
      resolve: (v) => secrets.resolve(v),
      channels: [
        {
          id: 'telegram',
          config: { token: 'secret://telegram/bot-token' },
          create: (config) => {
            created.push(config)
            return ch
          },
        },
      ],
    })
    createItem(r.ledger, 'sup.k', 'interrupt')
    await r.settle()
    expect(r.inbox.channels.status()).toEqual([
      {
        id: 'telegram',
        state: 'disabled',
        missing_secrets: ['telegram/bot-token'],
        failures: 0,
        next_retry_at: null,
        last_error: null,
        failed_items: 0,
      },
    ])
    expect(created).toHaveLength(0)
    expect(ch.started).toBe(0)
    secrets.close()
  })
})

describe('runHub 端到端', () => {
  let hub: RunningHub | undefined
  afterEach(async () => {
    await hub?.stop()
    hub = undefined
  })

  async function home() {
    const h = join(mkdtempSync(join(tmpdir(), 'flow-channels-hub-')), 'home')
    cleanups.push(() => rmSync(join(h, '..'), { recursive: true, force: true }))
    must(await initFlowHome(h))
    mkdirSync(join(h, 'config', 'workspaces'), { recursive: true })
    writeFileSync(
      join(h, 'config', 'workspaces', 'demo.yaml'),
      'id: demo\nkind: product\nname: Demo\ndescription: 测试\nrepos: []\n',
    )
    // 真实时钟：关掉静默时段，测试不受运行时刻影响
    writeFileSync(join(h, 'config', 'inbox.yaml'), 'quiet_hours: false\n')
    return h
  }

  const quiet = { info() {}, warn() {}, error() {} }

  const until = async (cond: () => boolean) => {
    const deadline = Date.now() + 5000
    while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
    expect(cond()).toBe(true)
  }

  test('卡住的任务推送到渠道；在渠道里回复 → 以 user 身份 task_reply（via=telegram）→ 条目关闭、消息改为已处理', async () => {
    const h = await home()
    // 中枢启动前账本里已有一个卡住（未持有租约）的任务
    const ledger = await openLedger(flowPaths(h).ledgerDb)
    const d = drafts('t-e2e', { ws: 'ws/demo' })
    must(ledger.append(d['task.created'] as EventInput, { actor: 'user' }))
    must(
      ledger.appendMany(
        [
          d['task.started'],
          {
            task_id: 't-e2e',
            workspace: 'ws/demo',
            type: 'task.blocked',
            payload: { reason: 'question', message: '用哪个分支？', tail: ['$ git branch'] },
          },
        ] as EventInput[],
        { actor: 'node:n1' },
      ),
    )
    ledger.close()

    const ch = new MemoryChannel('telegram', 'telegram')
    hub = must(
      await runHub({
        home: h,
        port: 0,
        logger: quiet as never,
        inbox: { watch: false, channels: [specOf(ch)] },
        secrets: { load: async () => ok(new Map()), watch: false },
      }),
    )
    await until(() => ch.sent.length === 1)
    const pushed = itemOf(ch.sent[0]?.message)
    expect(pushed.actions).toEqual(['reply'])
    expect(pushed.snippet).toBe('$ git branch')

    const handler = ch.handler
    if (!handler) throw new Error('渠道未启动')
    const result = await handler({ item: pushed.short_id, action: 'reply', text: '用 main' })
    expect(result.ok).toBe(true)
    await until(() => ch.updates.length === 1)
    const done = itemOf(ch.updates[0]?.message)
    expect(done.state).toBe('closed')
    expect(done.closed?.label).toBe('已处理（来自 Telegram）')
    expect(done.actions).toEqual([])

    // 状态接口报告渠道
    const token = readFileSync(flowPaths(h).hubToken, 'utf8').trim()
    const status = (await (
      await fetch(`${hub.url}/v1/hub/status`, { headers: { Authorization: `Bearer ${token}` } })
    ).json()) as { data: { channels: { id: string; state: string }[] } }
    expect(status.data.channels).toEqual([
      expect.objectContaining({ id: 'telegram', state: 'running' }),
    ])

    await hub.stop()
    hub = undefined
    const after = await openLedger(flowPaths(h).ledgerDb)
    cleanups.push(() => after.close())
    expect(after.taskReplies('t-e2e')[0]).toMatchObject({
      kind: 'text',
      text: '用 main',
      by: 'user',
    })
    const item = after.getInboxItem(pushed.id) as InboxItemView
    expect(item.closed).toMatchObject({ via: 'telegram', cause_actor: 'user' })
    expect(item.channels[0]?.synced_at).not.toBeNull()
    expect(ch.stopped).toBe(1)
  })

  test('缺少密钥的渠道不启动，flow hub status 报告缺少的路径', async () => {
    const h = await home()
    const ch = new MemoryChannel('telegram')
    hub = must(
      await runHub({
        home: h,
        port: 0,
        logger: quiet as never,
        inbox: {
          watch: false,
          channels: [
            { id: 'telegram', config: { token: 'secret://telegram/bot-token' }, create: () => ch },
          ],
        },
        secrets: { load: async () => ok(new Map()), watch: false },
      }),
    )
    const token = readFileSync(flowPaths(h).hubToken, 'utf8').trim()
    const status = (await (
      await fetch(`${hub.url}/v1/hub/status`, { headers: { Authorization: `Bearer ${token}` } })
    ).json()) as { data: { channels: { id: string; state: string; missing_secrets: string[] }[] } }
    expect(status.data.channels).toEqual([
      expect.objectContaining({
        id: 'telegram',
        state: 'disabled',
        missing_secrets: ['telegram/bot-token'],
      }),
    ])
    expect(ch.started).toBe(0)
  })
})
