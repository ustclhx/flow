import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyTelegramBinding, ok, parseChannelsConfig } from '@flow/core'
import {
  CALLBACK_DATA_MAX,
  ChannelError,
  type ChannelMessage,
  callbackData,
  channelErrorKind,
  createTelegramApi,
  createTelegramLinks,
  escapeHtml,
  LINK_ATTEMPT_LIMIT,
  LINK_ATTEMPT_WINDOW_MS,
  LINK_BLOCK_MS,
  LINK_CODE_TTL_MS,
  loadTelegramState,
  type OutboundItem,
  parseCallbackData,
  proxiedFetch,
  renderTelegramMessage,
  saveTelegramState,
  TELEGRAM_TEXT_MAX,
  TelegramApiError,
  visibleLength,
} from '../src/index.ts'
import { FakeTelegram, fakeBotToken } from './telegram-fixtures.ts'

/** Telegram 渠道的纯函数与 API 客户端（add-m1-inbox 5.1、5.2；假的 Telegram 服务）。 */

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

const id = (s: string) => s

function item(over: Partial<OutboundItem> = {}): OutboundItem {
  return {
    id: 'blk.42',
    short_id: '16',
    level: 'interrupt',
    source: 'task',
    workspace: 'ws/demo',
    task_id: 't-1',
    title: '需要授权',
    text: '要执行 git push',
    snippet: null,
    actions: ['approve', 'deny'],
    state: 'open',
    closed: null,
    ...over,
  }
}

describe('消息渲染', () => {
  test('HTML 注入：标题、正文、片段里的 <b> 与 & 都被转义', () => {
    const r = renderTelegramMessage(
      {
        kind: 'item',
        item: item({
          title: '<b>粗体</b> & <a href="x">链接</a>',
          text: '1 < 2 && 3 > 2',
          snippet: '<script>alert(1)</script>',
        }),
      },
      id,
    )
    expect(r.text).toContain(
      '&lt;b&gt;粗体&lt;/b&gt; &amp; &lt;a href=&quot;x&quot;&gt;链接&lt;/a&gt;',
    )
    expect(r.text).toContain('1 &lt; 2 &amp;&amp; 3 &gt; 2')
    expect(r.text).toContain('<pre>&lt;script&gt;alert(1)&lt;/script&gt;</pre>')
    expect(r.text).not.toContain('<script>')
    expect(r.text).not.toContain('<b>粗体')
    // 允许的标签只有渲染器自己加的
    const tags = new Set([...r.text.matchAll(/<\/?([a-z]+)/g)].map((m) => m[1]))
    expect([...tags].every((t) => ['b', 'i', 'code', 'pre'].includes(t ?? ''))).toBe(true)
  })

  test('内联按钮按可用操作生成，callback_data 为 i:<短 id>:<操作> 且不超过 64 字节', () => {
    const approval = renderTelegramMessage({ kind: 'item', item: item() }, id)
    expect(approval.reply_markup.inline_keyboard).toEqual([
      [
        { text: '批准', callback_data: 'i:16:approve' },
        { text: '驳回', callback_data: 'i:16:deny' },
        { text: '忽略', callback_data: 'i:16:dismiss' },
      ],
    ])
    const proposal = renderTelegramMessage(
      { kind: 'item', item: item({ source: 'proposal', actions: ['accept', 'reject'] }) },
      id,
    )
    expect(proposal.reply_markup.inline_keyboard[0]?.map((b) => b.text)).toEqual([
      '接受',
      '拒绝',
      '忽略',
    ])
    // 只能文字答复的条目：没有答复按钮，提示直接回复
    const question = renderTelegramMessage({ kind: 'item', item: item({ actions: ['reply'] }) }, id)
    expect(question.reply_markup.inline_keyboard).toEqual([
      [{ text: '忽略', callback_data: 'i:16:dismiss' }],
    ])
    expect(question.text).toContain('直接回复这条消息即可答复')
    // 短 id 最长 11 位（base36 的安全整数）时也不超过 64 字节
    const longest = Number.MAX_SAFE_INTEGER.toString(36)
    for (const a of ['approve', 'deny', 'accept', 'reject', 'dismiss'] as const) {
      const data = callbackData(longest, a)
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(CALLBACK_DATA_MAX)
      expect(parseCallbackData(data)).toEqual({ short_id: longest, action: a })
    }
    expect(parseCallbackData('i:16:reply')).toBeNull()
    expect(parseCallbackData('i:16:approve:x')).toBeNull()
    expect(parseCallbackData(`i:16:${'a'.repeat(80)}`)).toBeNull()
    expect(parseCallbackData(undefined)).toBeNull()
  })

  test('已关闭的条目：显示处理结果，没有按钮', () => {
    const r = renderTelegramMessage(
      {
        kind: 'item',
        item: item({
          state: 'closed',
          actions: [],
          closed: { reason: 'acted', label: '已处理（来自 Telegram）' },
        }),
      },
      id,
    )
    expect(r.text).toContain('✅ <b>已处理（来自 Telegram）</b>')
    expect(r.reply_markup.inline_keyboard).toEqual([])
  })

  test('长度：正文与片段很长时消息可见文字不超过 4096', () => {
    const long = 'x'.repeat(20_000)
    const single = renderTelegramMessage(
      { kind: 'item', item: item({ title: long, text: long, snippet: long }) },
      id,
    )
    expect(visibleLength(single.text)).toBeLessThanOrEqual(TELEGRAM_TEXT_MAX)
    const many = Array.from({ length: 120 }, (_, i) =>
      item({ id: `sup.${i}`, short_id: i.toString(36), title: `${'&'.repeat(150)}`, text: long }),
    )
    const batch = renderTelegramMessage({ kind: 'batch', items: many }, id)
    expect(visibleLength(batch.text)).toBeLessThanOrEqual(TELEGRAM_TEXT_MAX)
    // 按钮总数不超过 Telegram 的上限
    expect(batch.reply_markup.inline_keyboard.flat().length).toBeLessThanOrEqual(100)
  })

  test('Decide 合并消息：每条带短 id，按钮带短 id，可回复的条目有说明', () => {
    const msg: ChannelMessage = {
      kind: 'batch',
      items: [
        item({ id: 'prop.a', short_id: 'a1', level: 'decide', actions: ['accept', 'reject'] }),
        item({ id: 'sup.b', short_id: 'b2', level: 'decide', actions: ['reply'] }),
        item({
          id: 'sup.c',
          short_id: 'c3',
          level: 'decide',
          state: 'closed',
          actions: [],
          closed: { reason: 'dismissed', label: '已忽略（来自 CLI）' },
        }),
      ],
    }
    const r = renderTelegramMessage(msg, id)
    expect(r.text).toContain('<code>#a1</code>')
    expect(r.text).toContain('<code>#b2</code>')
    expect(r.text).toContain('回复本消息并以 #b2 开头即可答复这一条')
    expect(r.text).toContain('✅ 已忽略（来自 CLI）')
    expect(r.reply_markup.inline_keyboard).toEqual([
      [
        { text: '#a1 接受', callback_data: 'i:a1:accept' },
        { text: '#a1 拒绝', callback_data: 'i:a1:reject' },
        { text: '#a1 忽略', callback_data: 'i:a1:dismiss' },
      ],
      [{ text: '#b2 忽略', callback_data: 'i:b2:dismiss' }],
    ])
  })

  test('外发文字再经过脱敏', () => {
    const r = renderTelegramMessage(
      { kind: 'item', item: item({ title: '含 SECRETVALUE 的标题', text: 'SECRETVALUE' }) },
      (s) => s.split('SECRETVALUE').join('[REDACTED]'),
    )
    expect(r.text).not.toContain('SECRETVALUE')
    expect(r.text).toContain('[REDACTED]')
  })

  test('escapeHtml', () => {
    expect(escapeHtml(`<a href="x">&</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;')
  })
})

describe('Bot API 客户端的错误分类', () => {
  async function apiRig() {
    const fake = await new FakeTelegram().start()
    cleanups.push(() => fake.close())
    return {
      fake,
      api: createTelegramApi({
        token: fake.token,
        apiBase: fake.url,
        fetch: (u, i) => fetch(u, i),
      }),
    }
  }

  const caught = async (p: Promise<unknown>) => {
    try {
      await p
    } catch (err) {
      return err
    }
    throw new Error('应当抛错')
  }

  test('429：transport，带 retry_after', async () => {
    const { fake, api } = await apiRig()
    fake.failNext('sendMessage', 429, { parameters: { retry_after: 7 } })
    const err = await caught(api.call('sendMessage', { chat_id: 1, text: 'x' }))
    expect(err).toBeInstanceOf(TelegramApiError)
    expect(channelErrorKind(err)).toBe('transport')
    expect((err as TelegramApiError).retryAfterMs).toBe(7000)
  })

  test('5xx 与 403：transport；401：transport 且 unauthorized', async () => {
    const { fake, api } = await apiRig()
    fake.failNext('sendMessage', 502)
    expect(channelErrorKind(await caught(api.call('sendMessage', {})))).toBe('transport')
    fake.failNext('sendMessage', 403, { description: 'Forbidden: bot was blocked by the user' })
    expect(channelErrorKind(await caught(api.call('sendMessage', {})))).toBe('transport')
    const bad = createTelegramApi({
      token: '1:wrong',
      apiBase: fake.url,
      fetch: (u, i) => fetch(u, i),
    })
    const err = (await caught(bad.call('getMe', {}))) as TelegramApiError
    expect(err.unauthorized).toBe(true)
    expect(err.kind).toBe('transport')
  })

  test('编辑：message is not modified 当成功；message to edit not found 为 permanent；其他 400 为 message', async () => {
    const { fake, api } = await apiRig()
    const sent = await api.call<{ message_id: number }>('sendMessage', { chat_id: 5, text: '一' })
    expect(
      await api.call('editMessageText', { chat_id: 5, message_id: sent.message_id, text: '一' }),
    ).toBe(true)
    const missing = await caught(
      api.call('editMessageText', { chat_id: 5, message_id: 1, text: 'x' }),
    )
    expect(channelErrorKind(missing)).toBe('permanent')
    fake.failNext('sendMessage', 400, { description: "Bad Request: can't parse entities" })
    expect(channelErrorKind(await caught(api.call('sendMessage', {})))).toBe('message')
    // 非编辑方法的 not modified 不当成功
    fake.failNext('sendMessage', 400, { description: 'Bad Request: message is not modified' })
    expect(channelErrorKind(await caught(api.call('sendMessage', {})))).toBe('message')
  })

  test('网络错误与非 JSON 响应：transport；错误信息中没有 token，也不带 cause', async () => {
    const token = fakeBotToken()
    const api = createTelegramApi({
      token,
      apiBase: 'http://127.0.0.1:9',
      fetch: async (url) => {
        throw new Error(`Unable to connect. url=${url} token=${token}`)
      },
    })
    const err = (await caught(api.call('getMe', {}))) as ChannelError
    expect(err.kind).toBe('transport')
    expect(err.message).not.toContain(token)
    expect(err.message).not.toContain(token.split(':')[1] ?? '')
    expect(err.cause).toBeUndefined()
    expect(err.message).toContain('bot<token>')
    const html = createTelegramApi({
      token,
      fetch: async () => new Response('<html>502</html>', { status: 502 }),
    })
    const e2 = (await caught(html.call('getMe', {}))) as ChannelError
    expect(e2.kind).toBe('transport')
    expect(api.scrub(`see https://x/bot${token}/getMe`)).toBe('see https://x/bot<token>/getMe')
  })

  test('超时：transport', async () => {
    const api = createTelegramApi({
      token: fakeBotToken(),
      fetch: (_u, init) =>
        new Promise((_, reject) =>
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('x', 'AbortError')),
          ),
        ),
    })
    const err = (await caught(api.call('getMe', {}, { timeoutMs: 20 }))) as ChannelError
    expect(err.kind).toBe('transport')
    expect(err.message).toContain('超时')
  })
})

describe('绑定码', () => {
  const ME = 7001
  test('随机 ≥64 位、10 分钟过期、一次性、错误的码被拒绝', () => {
    let now = 1_000_000
    const links = createTelegramLinks({ now: () => now })
    const a = links.issue()
    expect(a.code).toMatch(/^[a-z2-9]{16}$/)
    // 31 个字符 × 16 位 ≈ 79 位
    expect(16 * Math.log2(31)).toBeGreaterThan(64)
    expect(links.issue().code).not.toBe(a.code)
    expect(links.redeem('x'.repeat(16), ME)).toBe('invalid')
    expect(links.redeem(a.code.toUpperCase(), ME)).toBe('ok')
    // 一次性
    expect(links.redeem(a.code, ME)).toBe('invalid')
    // 过期
    const b = links.issue()
    now += LINK_CODE_TTL_MS
    expect(links.redeem(b.code, ME)).toBe('invalid')
    expect(new Date(b.expires_at).getTime()).toBe(now)
  })

  test('按 chat 限流：一个 chat 刷错误码只会让它自己被忽略，不影响别人、不清掉已发的码', () => {
    let now = 1_000_000
    const links = createTelegramLinks({ now: () => now })
    const code = links.issue().code
    const ATTACKER = 9009
    for (let i = 0; i < LINK_ATTEMPT_LIMIT; i++) {
      expect(links.redeem('x'.repeat(16), ATTACKER)).toBe('invalid')
    }
    // 攻击者被暂时忽略：即使拿到了正确的码也不校验
    expect(links.redeem(code, ATTACKER)).toBe('limited')
    // 用户本人照常绑定
    expect(links.redeem(code, ME)).toBe('ok')
    // 忽略期过后恢复
    now += LINK_BLOCK_MS
    expect(links.redeem('x'.repeat(16), ATTACKER)).toBe('invalid')
  })

  test('窗口外的错误尝试不累计；格式不合法的码不计数', () => {
    let now = 1_000_000
    const links = createTelegramLinks({ now: () => now })
    const CHAT = 4242
    for (let i = 0; i < 100; i++) expect(links.redeem(`/start-${i}`, CHAT)).toBe('malformed')
    for (let i = 0; i < LINK_ATTEMPT_LIMIT - 1; i++) links.redeem('x'.repeat(16), CHAT)
    now += LINK_ATTEMPT_WINDOW_MS
    for (let i = 0; i < LINK_ATTEMPT_LIMIT - 1; i++) links.redeem('x'.repeat(16), CHAT)
    const code = links.issue().code
    expect(links.redeem(code, CHAT)).toBe('ok')
  })
})

describe('Node 的进程级代理', () => {
  test('没有显式配置 telegram.proxy（只有 HTTPS_PROXY）时不启用全局代理，返回提示', async () => {
    const r = await proxiedFetch('http://127.0.0.1:9', { runtime: 'node', global: false })
    expect(r.note).toContain('telegram.proxy')
    expect(typeof r.fetch).toBe('function')
    expect((await proxiedFetch(null, { runtime: 'node' })).note).toBeNull()
  })
})

describe('config/channels.yaml 与进度文件', () => {
  test('绑定写入保留其他字段与注释；bot_token 只接受 secret:// 引用', () => {
    const text = '# 我的渠道\ntelegram:\n  proxy: http://127.0.0.1:7890 # 本机代理\n'
    const r = applyTelegramBinding(text, { chat_id: 7001, user_id: 7001 })
    if (!r.ok) throw new Error(r.error.message)
    expect(r.data).toContain('# 我的渠道')
    expect(r.data).toContain('# 本机代理')
    expect(r.data).toContain('chat_id: 7001')
    expect(r.data).toContain('user_id: 7001')
    expect(applyTelegramBinding(null, { chat_id: 1, user_id: 1 }).ok).toBe(true)
    expect(applyTelegramBinding('- a\n', { chat_id: 1, user_id: 1 }).ok).toBe(false)
    expect(parseChannelsConfig({ telegram: { bot_token: fakeBotToken() } }).ok).toBe(false)
    const d = parseChannelsConfig({ telegram: {} })
    expect(d).toEqual(ok({ telegram: { enabled: true, bot_token: 'secret://telegram/bot-token' } }))
    expect(parseChannelsConfig({ telegram: { chat: 1 } }).ok).toBe(false)
  })

  test('offset 原子写入、0600；损坏时从头开始', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-tg-state-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'state', 'telegram.json')
    expect(await loadTelegramState(path)).toEqual({ offset: 0, bot_id: null })
    await saveTelegramState(path, { offset: 101, bot_id: 42 })
    expect(await loadTelegramState(path)).toEqual({ offset: 101, bot_id: 42 })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readFileSync(path, 'utf8')).toBe('{"offset":101,"bot_id":42}\n')
    writeFileSync(path, '{坏了')
    expect(await loadTelegramState(path)).toEqual({ offset: 0, bot_id: null })
  })
})

test('ChannelError 分类辅助', () => {
  expect(channelErrorKind(new ChannelError('x', 'permanent'))).toBe('permanent')
})
