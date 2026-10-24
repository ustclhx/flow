import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  type ChannelsConfig,
  defaultTelegramConfig,
  fail,
  type InboxItemAction,
  ok,
} from '@flow/core'
import {
  ChannelError,
  type ChannelMessage,
  channelErrorKind,
  createTelegramLinks,
  type InboundAction,
  type InboundResult,
  type LedgerStore,
  loadTelegramState,
  TelegramChannel,
  type TelegramDeps,
  type TelegramStatusSnapshot,
} from '../src/index.ts'
import { createItem } from './channel-fixtures.ts'
import { must, tempLedger } from './ledger-helpers.ts'
import {
  BOT_ID,
  FakeTelegram,
  STRANGER_ID,
  startForwardProxy,
  USER_ID,
} from './telegram-fixtures.ts'

/**
 * Telegram 插件（add-m1-inbox 5.1、5.2）：直接驱动插件，账本是临时 SQLite，Telegram 是假的 HTTP 服务。
 * 覆盖 telegram-channel 的白名单、长轮询进度、交互与命令；与中枢的端到端见 telegram-hub.test.ts。
 */

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

const until = async (cond: () => boolean, what = '条件') => {
  const deadline = Date.now() + 5000
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  if (!cond()) throw new Error(`等待超时：${what}`)
}

const snapshot: TelegramStatusSnapshot = {
  version: '0.0.0-test',
  uptime_s: 7200,
  channels: [
    {
      id: 'telegram',
      state: 'running',
      missing_secrets: [],
      failures: 0,
      next_retry_at: null,
      last_error: null,
      failed_items: 0,
      ignored_inbound: 0,
    },
  ],
  nodes: { total: 2, online: 1 },
  tasks: { running: 3, blocked: 1, queued: 0 },
  open_items: 4,
  auto_decisions_24h: 5,
}

interface RigOptions {
  bound?: boolean
  fake?: FakeTelegram
  statePath?: string
  ledger?: LedgerStore
  act?: (req: InboundAction) => InboundResult
  now?: () => number
  sleep?: TelegramDeps['sleep']
  token?: string
  /** 不注入 fetch：插件按代理配置自己构造（测试代理）。 */
  realFetch?: boolean
  env?: Record<string, string | undefined>
  proxy?: string
}

async function rig(o: RigOptions = {}) {
  const fake = o.fake ?? (await new FakeTelegram().start())
  if (!o.fake) cleanups.push(() => fake.close())
  let ledger = o.ledger
  let dir = ''
  if (!ledger) {
    const t = await tempLedger()
    cleanups.push(t.cleanup)
    ledger = t.store
    dir = t.dir
  }
  const binding = o.bound === false ? {} : { chat_id: USER_ID, user_id: USER_ID }
  let config: ChannelsConfig = { telegram: { ...defaultTelegramConfig(), ...binding } }
  const links = createTelegramLinks()
  const actions: InboundAction[] = []
  const captures: string[] = []
  const asks: [string, string][] = []
  const logs: { message: string; details?: unknown }[] = []
  let bound = 0
  const deps: TelegramDeps = {
    ledger,
    links,
    logger: {
      info: (message, details) => logs.push({ message, details }),
      warn: (message, details) => logs.push({ message, details }),
    },
    statePath: o.statePath ?? join(dir, 'telegram.json'),
    loadConfig: async () => ok(config),
    saveBinding: async (b) => {
      config = { telegram: { ...defaultTelegramConfig(), ...config.telegram, ...b } }
      return ok(undefined)
    },
    onBound: () => {
      bound += 1
    },
    status: () => snapshot,
    capture: async (text) => {
      captures.push(text)
      return ok({ file: 'raw/inbox/2026-10-26T100000-abc123.md' })
    },
    ask: async (ws, text) => {
      if (ws !== 'ws/demo') return fail('failure', 'workspace_not_found', `workspace ${ws} 不存在`)
      asks.push([ws, text])
      return ok({ seq: 1 })
    },
    apiBase: fake.url,
    ...(o.realFetch ? {} : { fetch: (url: string, init?: RequestInit) => fetch(url, init) }),
    env: o.env ?? {},
    pollTimeoutS: 1,
    ...(o.now ? { now: o.now } : {}),
    ...(o.sleep ? { sleep: o.sleep } : {}),
  }
  const plugin = new TelegramChannel(
    {
      ...defaultTelegramConfig(),
      bot_token: o.token ?? fake.token,
      ...binding,
      ...(o.proxy ? { proxy: o.proxy } : {}),
    },
    deps,
  )
  const act = o.act ?? ((req: InboundAction) => ok({ item_id: req.item }))
  await plugin.start(async (req) => {
    actions.push(req)
    return act(req)
  })
  cleanups.push(() => plugin.stop())
  /** 等插件处理完这条更新（它随后会用更大的 offset 再次轮询）。 */
  const processed = (updateId: number) =>
    until(() => fake.offsets.some((x) => x > updateId), `处理更新 ${updateId}`)
  return {
    fake,
    ledger,
    plugin,
    links,
    actions,
    captures,
    asks,
    logs,
    deps,
    processed,
    config: () => config,
    bound: () => bound,
  }
}

const itemMessage = (ledger: LedgerStore, id: string): ChannelMessage => {
  const view = ledger.getInboxItem(id)
  if (!view) throw new Error('条目不存在')
  return {
    kind: 'item',
    item: {
      id: view.id,
      short_id: view.short_id,
      level: view.level,
      source: view.source,
      workspace: view.workspace,
      task_id: view.task_id,
      title: view.title,
      text: view.body,
      snippet: null,
      actions: [...view.actions],
      state: view.state,
      closed: null,
    },
  }
}

/** 推送一个条目并按管理器的方式记下消息引用（inbox.pushed）。 */
async function pushItem(
  r: Awaited<ReturnType<typeof rig>>,
  id: string,
  actions: InboxItemAction[] = ['approve', 'deny'],
) {
  createItem(r.ledger, id, 'interrupt', { actions })
  const ref = await r.plugin.send(itemMessage(r.ledger, id), {
    signal: new AbortController().signal,
  })
  must(
    r.ledger.append(
      { type: 'inbox.pushed', payload: { channel: 'telegram', ref, item_ids: [id] } },
      { actor: 'hub' },
    ),
  )
  const messageId = Number(ref.split(':')[1])
  return { ref, messageId, view: r.ledger.getInboxItem(id) }
}

describe('chat 白名单（telegram-channel "绑定用户本人"）', () => {
  test('陌生人给 bot 发 /inbox：不回复，记一次被忽略的访问', async () => {
    const r = await rig()
    const u = r.fake.say('/inbox', { chat: STRANGER_ID })
    await r.processed(u)
    expect(r.fake.to(STRANGER_ID)).toEqual([])
    expect(r.fake.sent).toEqual([])
    expect(r.plugin.health()).toEqual({ disabled: null, ignored: 1 })
    expect(r.logs).toContainEqual(
      expect.objectContaining({
        message: '已忽略 Telegram 访问',
        details: expect.objectContaining({ chat_id: STRANGER_ID }),
      }),
    )
  })

  test('群聊（即使来自绑定的用户）、from.id 不符、bot 账号：一律忽略', async () => {
    const r = await rig()
    const ids = [
      r.fake.say('/inbox', { chat: -100123, from: USER_ID, type: 'group' }),
      r.fake.say('/status', { chat: -100124, from: USER_ID, type: 'supergroup' }),
      r.fake.say('/capture 偷偷记一条', { chat: USER_ID, from: STRANGER_ID }),
      r.fake.say('/inbox', { chat: USER_ID, from: USER_ID, isBot: true }),
      r.fake.say('/inbox', { chat: USER_ID, type: 'channel' }),
    ]
    await r.processed(ids.at(-1) ?? 0)
    expect(r.fake.sent).toEqual([])
    expect(r.captures).toEqual([])
    expect(r.plugin.health().ignored).toBe(5)
  })

  test('陌生 chat 的按钮与回复：不交给收件箱、不应答', async () => {
    const r = await rig()
    const { messageId, view } = await pushItem(r, 'sup.1')
    const ids = [
      r.fake.press(messageId, `i:${view?.short_id}:approve`, { chat: STRANGER_ID }),
      r.fake.press(messageId, `i:${view?.short_id}:approve`, { chat: USER_ID, from: STRANGER_ID }),
      r.fake.say('用方案 A', { chat: STRANGER_ID, replyTo: messageId }),
    ]
    await r.processed(ids.at(-1) ?? 0)
    expect(r.actions).toEqual([])
    expect(r.fake.answers).toEqual([])
    expect(r.fake.sent).toHaveLength(1)
    expect(r.plugin.health().ignored).toBe(3)
  })

  test('未绑定时：任何 chat 都不处理；推送报"尚未绑定"（transport，条目保持 pending）', async () => {
    const r = await rig({ bound: false })
    const u = r.fake.say('/inbox')
    await r.processed(u)
    expect(r.fake.sent).toEqual([])
    createItem(r.ledger, 'sup.1', 'interrupt')
    const err = await r.plugin
      .send(itemMessage(r.ledger, 'sup.1'), { signal: new AbortController().signal })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ChannelError)
    expect(channelErrorKind(err)).toBe('transport')
    expect((err as Error).message).toContain('flow telegram link')
  })
})

describe('绑定（/link 与 /start）', () => {
  test('错误的码：未绑定的 chat 收不到任何回复；正确的码绑定该私聊并回复；同一个码不能再用', async () => {
    const r = await rig({ bound: false })
    const wrong = r.fake.say('/link aaaaaaaaaaaaaaaa')
    await r.processed(wrong)
    expect(r.fake.sent).toEqual([])
    expect(r.config().telegram?.chat_id).toBeUndefined()

    const { code } = r.links.issue()
    // 群聊里发正确的码也不行（只接受私聊），而且不消耗这个码
    const group = r.fake.say(`/link ${code}`, { chat: -1005, from: USER_ID, type: 'group' })
    await r.processed(group)
    expect(r.config().telegram?.chat_id).toBeUndefined()

    const good = r.fake.say(`/link ${code}`)
    await r.processed(good)
    expect(r.config().telegram).toMatchObject({ chat_id: USER_ID, user_id: USER_ID })
    expect(r.fake.to(USER_ID)[0]?.text).toContain('已绑定')
    expect(r.bound()).toBe(1)

    // 已绑定后，陌生人拿同一个码也绑不走
    const reuse = r.fake.say(`/link ${code}`, { chat: STRANGER_ID })
    await r.processed(reuse)
    expect(r.config().telegram).toMatchObject({ chat_id: USER_ID })
    expect(r.fake.to(STRANGER_ID)).toEqual([])
    // 绑定的用户发错误的码：告诉他无效
    const again = r.fake.say(`/link ${code}`)
    await r.processed(again)
    expect(r.fake.to(USER_ID).at(-1)?.text).toContain('绑定码无效或已过期')
  })

  test('t.me 深链接的 /start <码> 同样可以绑定；绑定写入失败时不绑定', async () => {
    const r = await rig({ bound: false })
    r.deps.saveBinding = async () => fail('failure', 'config_commit_failed', '写入失败')
    const first = r.links.issue().code
    await r.processed(r.fake.say(`/start ${first}`))
    expect(r.fake.to(USER_ID).at(-1)?.text).toContain('绑定没有完成')
    // 绑定没有生效：之后的命令仍被忽略
    await r.processed(r.fake.say('/inbox'))
    expect(r.fake.to(USER_ID)).toHaveLength(1)
  })
})

describe('长轮询进度（telegram-channel "长轮询收取"）', () => {
  test('处理完一条更新就写 offset；重启后从下一条继续，不重复处理', async () => {
    const fake = await new FakeTelegram().start()
    cleanups.push(() => fake.close())
    const t = await tempLedger()
    cleanups.push(t.cleanup)
    const statePath = join(t.dir, 'state', 'telegram.json')
    const first = await rig({ fake, ledger: t.store, statePath })
    const a = fake.say('/capture 第一条')
    const b = fake.say('/capture 第二条')
    await first.processed(b)
    expect(first.captures).toEqual(['第一条', '第二条'])
    await first.plugin.stop()
    expect(await loadTelegramState(statePath)).toEqual({ offset: b + 1, bot_id: BOT_ID })
    expect(a).toBe(100)

    fake.offsets = []
    const c = fake.say('/capture 第三条')
    const second = await rig({ fake, ledger: t.store, statePath })
    await second.processed(c)
    // 重启后第一次轮询就带上保存的 offset，已处理的更新不会再来一次
    expect(fake.offsets[0]).toBe(b + 1)
    expect(second.captures).toEqual(['第三条'])
  })

  test('换了 bot（token 的 bot id 不同）时从头开始', async () => {
    const fake = await new FakeTelegram(['777', 'other_fake_bot_token_value'].join(':')).start()
    cleanups.push(() => fake.close())
    const t = await tempLedger()
    cleanups.push(t.cleanup)
    const statePath = join(t.dir, 'telegram.json')
    const { saveTelegramState } = await import('../src/index.ts')
    await saveTelegramState(statePath, { offset: 999, bot_id: BOT_ID })
    await rig({ fake, ledger: t.store, statePath })
    await until(() => fake.offsets.length > 0)
    expect(fake.offsets[0]).toBe(0)
  })
})

describe('条目消息与交互（telegram-channel "条目消息与交互"）', () => {
  test('点击按钮：执行对应操作并应答；按钮必须属于这条消息', async () => {
    const r = await rig()
    const { messageId, view } = await pushItem(r, 'sup.1')
    const sent = r.fake.sent[0]
    expect(sent?.parse_mode).toBe('HTML')
    expect(sent?.reply_markup?.inline_keyboard[0]?.map((b) => b.callback_data)).toEqual([
      `i:${view?.short_id}:approve`,
      `i:${view?.short_id}:deny`,
      `i:${view?.short_id}:dismiss`,
    ])
    await r.processed(r.fake.press(messageId, `i:${view?.short_id}:approve`))
    expect(r.actions).toEqual([{ item: 'sup.1', action: 'approve' }])
    expect(r.fake.answers.at(-1)?.text).toBe('已批准')

    // 另一个条目的短 id 放在这条消息的按钮里（伪造）：拒绝
    createItem(r.ledger, 'sup.2', 'interrupt', { actions: ['approve'] })
    const other = r.ledger.getInboxItem('sup.2')
    await r.processed(r.fake.press(messageId, `i:${other?.short_id}:approve`))
    await r.processed(r.fake.press(messageId, 'garbage'))
    expect(r.actions).toHaveLength(1)
    expect(r.fake.answers.slice(-2).map((a) => a.text)).toEqual(['按钮已失效', '按钮已失效'])
  })

  test('操作失败时应答失败原因；条目已关闭时提示已处理', async () => {
    const r = await rig({
      act: (req) =>
        req.action === 'approve'
          ? fail('failure', 'item_closed', '收件箱条目已关闭')
          : fail('failure', 'action_not_available', '条目不支持该操作'),
    })
    const { messageId, view } = await pushItem(r, 'sup.1')
    await r.processed(r.fake.press(messageId, `i:${view?.short_id}:approve`))
    await r.processed(r.fake.press(messageId, `i:${view?.short_id}:deny`))
    expect(r.fake.answers.map((a) => a.text)).toEqual([
      '这个条目已经处理过了',
      '没有完成：条目不支持该操作',
    ])
  })

  test('直接回复条目消息 → 该条目的回复操作，回复"已回复"', async () => {
    const r = await rig()
    const { messageId } = await pushItem(r, 'sup.q', ['reply'])
    await r.processed(r.fake.say('用方案 A', { replyTo: messageId }))
    expect(r.actions).toEqual([{ item: 'sup.q', action: 'reply', text: '用方案 A' }])
    const ack = r.fake.to(USER_ID).at(-1)
    expect(ack?.text).toBe('已回复')
    expect(ack?.reply_to).toBeDefined()
    // 回复一条不对应条目的消息
    await r.processed(r.fake.say('随便说说', { replyTo: 12345 }))
    expect(r.fake.to(USER_ID).at(-1)?.text).toContain('没有对应的条目')
    expect(r.actions).toHaveLength(1)
  })

  test('回复 Decide 合并消息：以 #短 id 开头指明条目', async () => {
    const r = await rig()
    createItem(r.ledger, 'sup.a', 'decide', { actions: ['reply'] })
    createItem(r.ledger, 'sup.b', 'decide', { actions: ['reply'] })
    const a = r.ledger.getInboxItem('sup.a')
    const b = r.ledger.getInboxItem('sup.b')
    if (!a || !b) throw new Error('条目不存在')
    const batch: ChannelMessage = {
      kind: 'batch',
      items: [a, b].map((v) => {
        const m = itemMessage(r.ledger, v.id)
        if (m.kind !== 'item') throw new Error('x')
        return m.item
      }),
    }
    const ref = await r.plugin.send(batch, { signal: new AbortController().signal })
    must(
      r.ledger.append(
        {
          type: 'inbox.pushed',
          payload: { channel: 'telegram', ref, kind: 'batch', item_ids: ['sup.a', 'sup.b'] },
        },
        { actor: 'hub' },
      ),
    )
    const messageId = Number(ref.split(':')[1])
    expect(r.fake.sent[0]?.text).toContain(`#${a.short_id}`)
    expect(r.fake.sent[0]?.text).toContain(`#${b.short_id}`)
    await r.processed(r.fake.say('没指明', { replyTo: messageId }))
    expect(r.actions).toEqual([])
    expect(r.fake.to(USER_ID).at(-1)?.text).toContain('以 #短 id 开头')
    await r.processed(r.fake.say(`#${b.short_id} 选第二个`, { replyTo: messageId }))
    expect(r.actions).toEqual([{ item: 'sup.b', action: 'reply', text: '选第二个' }])
  })

  test('update：改为处理结果并去掉按钮；内容没有变化当成功；消息已不存在为 permanent', async () => {
    const r = await rig()
    const { ref } = await pushItem(r, 'sup.1')
    const base = itemMessage(r.ledger, 'sup.1')
    if (base.kind !== 'item') throw new Error('x')
    const closed: ChannelMessage = {
      kind: 'item',
      item: {
        ...base.item,
        state: 'closed',
        actions: [],
        closed: { reason: 'acted', label: '已处理（来自 Telegram）' },
      },
    }
    const signal = new AbortController().signal
    await r.plugin.update(ref, closed, { signal })
    const edited = r.fake.messages.get(ref)
    expect(edited?.text).toContain('已处理（来自 Telegram）')
    expect(edited?.reply_markup?.inline_keyboard).toEqual([])
    await r.plugin.update(ref, closed, { signal })
    expect(r.fake.edits).toHaveLength(1)
    const gone = await r.plugin.update(`${USER_ID}:99999`, closed, { signal }).catch((e) => e)
    expect(channelErrorKind(gone)).toBe('permanent')
    expect(channelErrorKind(await r.plugin.update('bad', closed, { signal }).catch((e) => e))).toBe(
      'permanent',
    )
  })
})

describe('命令（telegram-channel "命令"）', () => {
  test('/inbox、/status、/capture、/ask、未知命令与普通文字', async () => {
    const r = await rig()
    createItem(r.ledger, 'sup.1', 'interrupt')
    const inbox = r.fake.say('/inbox')
    const status = r.fake.say('/status@flow_test_bot')
    const capture = r.fake.say('/capture 东方站可以加日语')
    const emptyCapture = r.fake.say('/capture')
    const ask = r.fake.say('/ask demo 看看昨天的部署')
    const badAsk = r.fake.say('/ask ws/nope 内容')
    const usage = r.fake.say('/ask demo')
    const unknown = r.fake.say('/whatever')
    const text = r.fake.say('你好')
    await r.processed(text)
    const replies = r.fake.to(USER_ID).map((m) => m.text)
    expect(replies).toHaveLength(9)
    expect(replies[0]).toContain('未关闭的条目（1 条）')
    expect(replies[0]).toContain(`#${r.ledger.getInboxItem('sup.1')?.short_id} [紧急]`)
    expect(replies[1]).toContain('过去 24 小时自动放行：5 次')
    expect(replies[1]).toContain('任务：运行中 3，卡住 1，排队 0')
    expect(replies[1]).toContain('节点：1 个在线 / 共 2 个')
    expect(replies[1]).toContain('telegram 正常')
    expect(replies[2]).toBe('已记下：raw/inbox/2026-10-26T100000-abc123.md')
    expect(r.captures).toEqual(['东方站可以加日语'])
    expect(replies[3]).toContain('用法：/capture')
    expect(replies[4]).toBe('已记录，supervisor 尚未启用')
    expect(r.asks).toEqual([['ws/demo', '看看昨天的部署']])
    expect(replies[5]).toContain('workspace ws/nope 不存在')
    expect(replies[6]).toContain('用法：/ask')
    expect(replies[7]).toContain('/capture &lt;内容&gt;')
    expect(replies[8]).toContain('/inbox')
    expect([inbox, status, capture, emptyCapture, ask, badAsk, usage, unknown]).toHaveLength(8)
  })

  test('/inbox 的条目标题含 HTML：转义后发送', async () => {
    const r = await rig()
    must(
      r.ledger.append(
        {
          type: 'inbox.item_created',
          payload: {
            item_id: 'sup.h',
            level: 'decide',
            source: 'supervisor',
            source_ref: 'h',
            title: '<b>重要</b> & 紧急',
            actions: ['reply'],
          },
        },
        { actor: 'hub' },
      ),
    )
    await r.processed(r.fake.say('/inbox'))
    const text = r.fake.to(USER_ID)[0]?.text ?? ''
    expect(text).toContain('&lt;b&gt;重要&lt;/b&gt; &amp; 紧急')
    expect(text).not.toContain('<b>重要')
  })
})

describe('限流与 token 失效', () => {
  test('429：在 retry_after 之前不再请求，之后恢复', async () => {
    let now = 1_000_000
    const r = await rig({ now: () => now })
    createItem(r.ledger, 'sup.1', 'interrupt')
    const message = itemMessage(r.ledger, 'sup.1')
    const signal = new AbortController().signal
    r.fake.failNext('sendMessage', 429, { parameters: { retry_after: 30 } })
    const first = await r.plugin.send(message, { signal }).catch((e) => e)
    expect(channelErrorKind(first)).toBe('transport')
    const calls = r.fake.calls.filter((c) => c.method === 'sendMessage').length
    const second = await r.plugin.send(message, { signal }).catch((e) => e)
    expect((second as Error).message).toContain('限流中')
    expect(r.fake.calls.filter((c) => c.method === 'sendMessage').length).toBe(calls)
    now += 30_000
    expect(await r.plugin.send(message, { signal })).toMatch(new RegExp(`^${USER_ID}:\\d+$`))
  })

  test('长轮询遇到 429：等待 retry_after 再轮询', async () => {
    const sleeps: number[] = []
    const fake = await new FakeTelegram().start()
    cleanups.push(() => fake.close())
    fake.failNext('getUpdates', 429, { parameters: { retry_after: 3 } })
    await rig({
      fake,
      sleep: async (ms) => {
        sleeps.push(ms)
        await new Promise((r) => setTimeout(r, 5))
      },
    })
    await until(() => fake.offsets.length >= 1)
    expect(sleeps.some((ms) => ms >= 2900)).toBe(true)
  })

  test('401（token 错误）：渠道停用，不再轮询；发送直接失败', async () => {
    const fake = await new FakeTelegram().start()
    cleanups.push(() => fake.close())
    const r = await rig({ fake, token: ['1', 'definitely_not_the_token'].join(':') })
    expect(r.plugin.health().disabled).toContain('401')
    expect(fake.calls.map((c) => c.method)).toEqual(['getMe'])
    createItem(r.ledger, 'sup.1', 'interrupt')
    const err = await r.plugin
      .send(itemMessage(r.ledger, 'sup.1'), { signal: new AbortController().signal })
      .catch((e) => e)
    expect(channelErrorKind(err)).toBe('transport')
    expect(fake.calls.map((c) => c.method)).toEqual(['getMe'])
  })

  test('轮询中途 token 被吊销（401）：停用并记录', async () => {
    const fake = await new FakeTelegram().start()
    cleanups.push(() => fake.close())
    const r = await rig({ fake })
    await until(() => fake.offsets.length >= 1)
    fake.failNext('getUpdates', 401, { description: 'Unauthorized' })
    await until(() => r.plugin.health().disabled !== null, '停用')
    expect(r.logs.some((l) => l.message.includes('渠道已停用'))).toBe(true)
  })
})

describe('代理（design D4）', () => {
  test('config 的 telegram.proxy：所有 Bot API 请求经过代理', async () => {
    const proxy = await startForwardProxy()
    cleanups.push(proxy.close)
    const r = await rig({ realFetch: true, proxy: proxy.url })
    await until(() => r.fake.offsets.length > 0, '经代理轮询')
    expect(proxy.seen.some((x) => x.includes('/getMe'))).toBe(true)
    expect(proxy.seen.some((x) => x.includes('/getUpdates'))).toBe(true)
    expect(r.logs).toContainEqual(
      expect.objectContaining({ message: 'Telegram 经代理访问', details: { proxy: proxy.url } }),
    )
  })

  test('没有配置时使用 HTTPS_PROXY；日志中的代理地址去掉了用户名密码', async () => {
    const proxy = await startForwardProxy()
    cleanups.push(proxy.close)
    const withAuth = proxy.url.replace('http://', 'http://alice:pa55word@')
    const r = await rig({ realFetch: true, env: { HTTPS_PROXY: withAuth } })
    await until(() => proxy.seen.some((x) => x.includes('/getUpdates')), '经环境变量代理轮询')
    expect(JSON.stringify(r.logs)).not.toContain('pa55word')
  })
})
