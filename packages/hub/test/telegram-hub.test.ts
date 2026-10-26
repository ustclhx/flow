import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  flowPaths,
  type HubStatusData,
  initFlowHome,
  ok,
  type ShowTaskData,
  type TelegramLinkCodeData,
  type TelegramUnlinkData,
} from '@flow/core'
import { type EventInput, openLedger, type RunningHub, runHub } from '../src/index.ts'
import { drafts, must } from './ledger-helpers.ts'
import { FakeTelegram, fakeBotToken, STRANGER_ID, USER_ID } from './telegram-fixtures.ts'

/**
 * Telegram 渠道与中枢的端到端（add-m1-inbox 5.1、5.2；telegram-channel spec 全部场景）：
 * 真实的 runHub（随机端口、临时 FLOW_HOME），Telegram 是假的 HTTP 服务，bot token 是可识别的假值；
 * 每个场景结束后全文扫描日志、账本、状态文件与 config 仓库历史，确认 token 没有出现在任何地方。
 */

const cleanups: (() => Promise<void> | void)[] = []
let hub: RunningHub | undefined
afterEach(async () => {
  await hub?.stop()
  hub = undefined
  for (const c of cleanups.splice(0).reverse()) await c()
})

const until = async (cond: () => boolean, what = '条件', ms = 8000) => {
  const deadline = Date.now() + ms
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
  if (!cond()) throw new Error(`等待超时：${what}`)
}

const WS = 'ws/demo'

async function makeHome(o: { bound?: boolean; channels?: string } = {}) {
  const h = join(mkdtempSync(join(tmpdir(), 'flow-telegram-hub-')), 'home')
  cleanups.push(() => rmSync(join(h, '..'), { recursive: true, force: true }))
  must(await initFlowHome(h))
  mkdirSync(join(h, 'config', 'workspaces'), { recursive: true })
  // supervisor 唤醒需要登记仓库作为工作目录（/ask 会真正创建唤醒任务）。
  const repo = join(h, '..', 'repo')
  mkdirSync(repo, { recursive: true })
  writeFileSync(
    join(h, 'config', 'workspaces', 'demo.yaml'),
    `id: demo\nkind: product\nname: Demo\ndescription: 测试\nrepos: [${JSON.stringify(repo)}]\n`,
  )
  writeFileSync(join(h, 'config', 'inbox.yaml'), 'quiet_hours: false\n')
  // 密钥由测试注入（secrets.load）；存在加密文件时中枢才会调用它。
  writeFileSync(join(h, 'config', 'secrets.sops.yaml'), 'sops: placeholder\n')
  const channels =
    o.channels ??
    (o.bound ? `telegram:\n  chat_id: ${USER_ID}\n  user_id: ${USER_ID}\n` : undefined)
  if (channels !== undefined) writeFileSync(flowPaths(h).channelsConfig, channels)
  return h
}

/** 测试里读取的响应体（几种接口的字段合在一起，按需取用）。 */
interface ApiBody {
  ok: boolean
  data: HubStatusData & TelegramLinkCodeData & ShowTaskData & TelegramUnlinkData
  error: { code: string; message: string }
}

interface LogLine {
  level: string
  message: string
  details?: unknown
}

async function startHub(
  h: string,
  fake: FakeTelegram,
  o: { token?: string | null; logs?: LogLine[] } = {},
) {
  const logs = o.logs ?? []
  const record = (level: string) => (message: string, details?: unknown) =>
    logs.push({ level, message, ...(details === undefined ? {} : { details }) })
  const token = o.token === undefined ? fake.token : o.token
  hub = must(
    await runHub({
      home: h,
      port: 0,
      logger: { info: record('info'), warn: record('warn') },
      inbox: { watch: false, telegram: { apiBase: fake.url, pollTimeoutS: 1, env: {} } },
      secrets: {
        load: async () => ok(new Map(token === null ? [] : [['telegram/bot-token', token]])),
        watch: false,
      },
    }),
  )
  const userToken = readFileSync(flowPaths(h).hubToken, 'utf8').trim()
  const running = hub
  const api = async (path: string, init: RequestInit & { actor?: string } = {}) => {
    const res = await fetch(`${running.url}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${userToken}`,
        'Content-Type': 'application/json',
        ...(init.actor ? { 'X-Flow-Actor': init.actor } : {}),
      },
    })
    return { status: res.status, body: (await res.json()) as ApiBody }
  }
  return { logs, api }
}

/** 全文扫描：token 不出现在日志、账本、state/、config 仓库（含历史）与状态接口中。 */
async function expectNoToken(h: string, token: string, extra: unknown[]) {
  const secretPart = token.split(':')[1] ?? token
  const texts: string[] = extra.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (name === '.git') continue
      if (statSync(p).isDirectory()) walk(p)
      else texts.push(readFileSync(p).toString('latin1'))
    }
  }
  // 账本先关掉中枢再读（WAL 合并进主文件）
  await hub?.stop()
  hub = undefined
  const ledger = await openLedger(flowPaths(h).ledgerDb)
  texts.push(JSON.stringify(ledger.eventsAfter(0, {}, 100_000)))
  ledger.close()
  walk(flowPaths(h).state)
  walk(flowPaths(h).config)
  walk(flowPaths(h).raw)
  texts.push(execFileSync('git', ['log', '-p', '--all'], { cwd: flowPaths(h).config }).toString())
  texts.push(execFileSync('git', ['log', '-p', '--all'], { cwd: flowPaths(h).raw }).toString())
  for (const t of texts) {
    expect(t.includes(token)).toBe(false)
    expect(t.includes(secretPart)).toBe(false)
  }
}

describe('绑定与白名单（telegram-channel "绑定用户本人"）', () => {
  test('flow telegram link 的绑定码 → /link → chat 写入 config/channels.yaml 并提交；陌生人被忽略；pending 条目随即补推', async () => {
    const fake = await new FakeTelegram().start()
    cleanups.push(() => fake.close())
    const h = await makeHome()
    // 中枢启动前已有一个卡住的任务：未绑定时推不出去，保持 pending
    const ledger = await openLedger(flowPaths(h).ledgerDb)
    const d = drafts('t-wait', { ws: WS })
    must(ledger.append(d['task.created'] as EventInput, { actor: 'user' }))
    must(
      ledger.appendMany(
        [
          d['task.started'],
          {
            task_id: 't-wait',
            workspace: WS,
            type: 'task.blocked',
            payload: { reason: 'question', message: '用哪个分支？' },
          },
        ] as EventInput[],
        { actor: 'node:n1' },
      ),
    )
    ledger.close()
    const { logs, api } = await startHub(h, fake)
    await until(() => fake.offsets.length > 0, '开始长轮询')

    // 陌生人（未绑定）给 bot 发 /inbox：不回复，日志记一次被忽略的访问
    const stranger = fake.say('/inbox', { chat: STRANGER_ID })
    await until(() => fake.offsets.some((x) => x > stranger), '处理陌生人消息')
    expect(fake.to(STRANGER_ID)).toEqual([])
    expect(logs.some((l) => l.message === '已忽略 Telegram 访问')).toBe(true)

    // AI 不能申请绑定码
    const ai = await api('/v1/telegram/link-code', { method: 'POST', body: '{}', actor: 'claude' })
    expect(ai.status).toBe(403)
    expect(ai.body.error.code).toBe('user_only')
    const issued = await api('/v1/telegram/link-code', { method: 'POST', body: '{}' })
    expect(issued.status).toBe(201)
    const code = issued.body.data.code as string
    expect(code).toMatch(/^[a-z2-9]{16}$/)
    expect(issued.body.data.command).toBe(`/link ${code}`)
    expect(issued.body.data.link_url).toBe(`https://t.me/flow_test_bot?start=${code}`)

    fake.say(`/link ${code}`)
    await until(() => fake.to(USER_ID).some((m) => m.text.includes('已绑定')), '绑定回复')
    const yaml = readFileSync(flowPaths(h).channelsConfig, 'utf8')
    expect(yaml).toContain(`chat_id: ${USER_ID}`)
    expect(yaml).toContain(`user_id: ${USER_ID}`)
    const log = execFileSync('git', ['log', '-1', '--format=%an|%s'], {
      cwd: flowPaths(h).config,
    }).toString()
    expect(log.trim()).toBe('Flow (user)|channels: 绑定 Telegram chat')
    // 绑定后立即补推 pending 的条目
    await until(() => fake.to(USER_ID).some((m) => m.text.includes('用哪个分支')), '补推条目')

    // 同一个码不能再用：陌生人拿去也绑不走
    const reuse = fake.say(`/link ${code}`, { chat: STRANGER_ID })
    await until(() => fake.offsets.some((x) => x > reuse), '处理重复使用')
    expect(fake.to(STRANGER_ID)).toEqual([])
    expect(readFileSync(flowPaths(h).channelsConfig, 'utf8')).toContain(`chat_id: ${USER_ID}`)

    const status = await api('/v1/hub/status')
    expect(status.body.data.channels).toEqual([
      expect.objectContaining({ id: 'telegram', state: 'running', ignored_inbound: 2 }),
    ])
    await expectNoToken(h, fake.token, [logs, status.body, fake.sent, issued.body])
  })
})

describe('交互与命令（telegram-channel "条目消息与交互"、"命令"）', () => {
  async function seeded() {
    const fake = await new FakeTelegram().start()
    cleanups.push(() => fake.close())
    const h = await makeHome({ bound: true })
    const ledger = await openLedger(flowPaths(h).ledgerDb)
    for (const [id, reason, message] of [
      ['t-appr', 'awaiting_approval', '要执行 git push origin main'],
      ['t-q', 'question', '用方案 A 还是 B？'],
    ] as const) {
      const d = drafts(id, { ws: WS })
      must(ledger.append(d['task.created'] as EventInput, { actor: 'user' }))
      must(
        ledger.appendMany(
          [
            d['task.started'],
            {
              task_id: id,
              workspace: WS,
              type: 'task.blocked',
              payload: { reason, message, tail: ['$ 最后一行 <tag> & more'] },
            },
          ] as EventInput[],
          { actor: 'node:n1' },
        ),
      )
    }
    must(
      ledger.append(
        {
          task_id: 't-appr',
          workspace: WS,
          type: 'policy.decided',
          payload: {
            task_id: 't-appr',
            request: { tool: 'Bash', actions: ['git.push'], command: 'git push' },
            level: 'auto',
            matched_rules: [],
            actions: [{ action: 'git.push', level: 'auto', matched_rules: [], guarded: false }],
          },
        },
        { actor: 'node:n1' },
      ),
    )
    // HTML 注入：标题里有 <b> 与 &
    must(
      ledger.append(
        {
          type: 'inbox.item_created',
          payload: {
            item_id: 'sup.html',
            level: 'interrupt',
            source: 'supervisor',
            source_ref: 'html',
            title: '<b>伪造的粗体</b> & <i>斜体</i>',
            body: 'a < b && c > d',
            actions: ['reply'],
          },
        },
        { actor: 'hub' },
      ),
    )
    ledger.close()
    const started = await startHub(h, fake)
    await until(() => fake.to(USER_ID).length >= 3, '推送三个条目')
    const find = (s: string) => {
      const m = fake.to(USER_ID).find((x) => x.text.includes(s))
      if (!m) throw new Error(`没有包含 ${s} 的消息`)
      return m
    }
    return { fake, h, ...started, find }
  }

  test('按钮批准 → 任务收到批准 → 消息改为已处理；直接回复 → 任务收到回复 → "已回复"；HTML 被转义', async () => {
    const { fake, h, logs, api, find } = await seeded()

    const approval = find('git push origin main')
    expect(approval.parse_mode).toBe('HTML')
    expect(approval.text).toContain('<code>ws/demo</code>')
    expect(approval.text).toContain('&lt;tag&gt; &amp; more')
    const buttons = approval.reply_markup?.inline_keyboard.flat() ?? []
    expect(buttons.map((b) => b.text)).toEqual(['批准', '驳回', '忽略'])
    for (const b of buttons) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64)

    const injected = find('伪造的粗体')
    expect(injected.text).toContain('&lt;b&gt;伪造的粗体&lt;/b&gt; &amp; &lt;i&gt;斜体&lt;/i&gt;')
    expect(injected.text).toContain('a &lt; b &amp;&amp; c &gt; d')
    expect(injected.text).not.toContain('<b>伪造')

    // 点击"批准"
    const approve = buttons.find((b) => b.text === '批准')
    fake.press(approval.message_id, approve?.callback_data ?? '')
    await until(() => fake.answers.some((a) => a.text === '已批准'), '按钮应答')
    const shown = await api('/v1/tasks/t-appr')
    expect(shown.body.data.replies).toEqual([
      expect.objectContaining({ kind: 'approve', by: 'user' }),
    ])
    await until(
      () => (fake.messages.get(`${USER_ID}:${approval.message_id}`)?.text ?? '').includes('已处理'),
      '消息改为已处理',
    )
    const edited = fake.messages.get(`${USER_ID}:${approval.message_id}`)
    expect(edited?.text).toContain('已处理（来自 Telegram）')
    expect(edited?.reply_markup?.inline_keyboard).toEqual([])

    // 直接回复卡住的 Codex
    const question = find('用方案 A 还是 B')
    expect(question.text).toContain('直接回复这条消息即可答复')
    fake.say('用方案 A', { replyTo: question.message_id })
    await until(() => fake.to(USER_ID).some((m) => m.text === '已回复'), '"已回复"')
    const q = await api('/v1/tasks/t-q')
    expect(q.body.data.replies).toEqual([
      expect.objectContaining({ kind: 'text', text: '用方案 A', by: 'user' }),
    ])
    await until(
      () => (fake.messages.get(`${USER_ID}:${question.message_id}`)?.text ?? '').includes('已处理'),
      '回复后消息改为已处理',
    )
    await expectNoToken(h, fake.token, [logs, fake.sent])
  })

  test('/capture 写入 raw/inbox（来源 telegram）；/inbox、/status（含 24 小时自动放行次数）；/ask 写入 user.instruction 并唤醒 supervisor', async () => {
    const { fake, h, logs } = await seeded()
    fake.say('/capture 东方站可以加日语')
    await until(() => fake.to(USER_ID).some((m) => m.text.startsWith('已记下')), '随手记确认')
    const files = readdirSync(join(flowPaths(h).raw, 'inbox'))
    expect(files).toHaveLength(1)
    const capture = readFileSync(join(flowPaths(h).raw, 'inbox', files[0] ?? ''), 'utf8')
    expect(capture).toContain('source: telegram')
    expect(capture).toContain('actor: user')
    expect(capture).toContain('东方站可以加日语')

    fake.say('/inbox')
    await until(() => fake.to(USER_ID).some((m) => m.text.startsWith('未关闭的条目')), '/inbox')
    expect(fake.to(USER_ID).find((m) => m.text.startsWith('未关闭的条目'))?.text).toContain(
      '&lt;b&gt;伪造的粗体',
    )
    fake.say('/status')
    await until(() => fake.to(USER_ID).some((m) => m.text.startsWith('中枢：运行中')), '/status')
    const status = fake.to(USER_ID).find((m) => m.text.startsWith('中枢：运行中'))?.text ?? ''
    expect(status).toContain('过去 24 小时自动放行：1 次')
    expect(status).toContain('卡住 2')
    expect(status).toContain('telegram 正常')

    fake.say('/ask demo 看看昨天的部署')
    await until(
      () => fake.to(USER_ID).some((m) => m.text.startsWith('已唤醒 supervisor，任务 t-')),
      '/ask',
    )
    const askReply = fake.to(USER_ID).find((m) => m.text.startsWith('已唤醒 supervisor'))?.text
    const wakeId = askReply?.slice('已唤醒 supervisor，任务 '.length)
    await hub?.stop()
    hub = undefined
    const ledger = await openLedger(flowPaths(h).ledgerDb)
    const all = ledger.eventsAfter(0, {}, 10_000)
    const asks = all.filter((e) => e.type === 'user.instruction')
    const wakes = all.filter((e) => e.type === 'supervisor.wake_started')
    ledger.close()
    expect(wakes).toEqual([
      expect.objectContaining({
        task_id: wakeId,
        actor: 'hub',
        payload: expect.objectContaining({ origin: 'instruction', events: [asks[0]?.seq] }),
      }),
    ])
    expect(asks).toEqual([
      expect.objectContaining({
        workspace: WS,
        actor: 'user',
        payload: { text: '看看昨天的部署', via: 'telegram' },
      }),
    ])
    await expectNoToken(h, fake.token, [logs, fake.sent])
  })

  test('中枢重启：已处理的更新不再处理一次（offset 持久化在 state/telegram.json）', async () => {
    const { fake, h } = await seeded()
    const u = fake.say('/capture 只记一次')
    await until(() => fake.to(USER_ID).some((m) => m.text.startsWith('已记下')), '随手记确认')
    await until(() => fake.offsets.some((x) => x > u), '确认已处理')
    await hub?.stop()
    hub = undefined
    const saved = JSON.parse(readFileSync(flowPaths(h).telegramState, 'utf8'))
    expect(saved.offset).toBe(u + 1)

    fake.offsets = []
    const next = fake.say('/capture 第二条')
    await startHub(h, fake)
    await until(() => fake.offsets.some((x) => x > next), '重启后处理新的更新')
    expect(fake.offsets[0]).toBe(u + 1)
    await until(() => readdirSync(join(flowPaths(h).raw, 'inbox')).length === 2, '第二条随手记')
    const texts = readdirSync(join(flowPaths(h).raw, 'inbox')).map((f) =>
      readFileSync(join(flowPaths(h).raw, 'inbox', f), 'utf8'),
    )
    expect(texts.filter((t) => t.includes('只记一次'))).toHaveLength(1)
  })
})

describe('改绑与解除绑定（PR #34 审查）', () => {
  const OTHER_ID = 7002

  /** 中枢停止后账本里的改绑 / 解绑事件（只含 chat 摘要）。 */
  async function channelEvents(h: string) {
    await hub?.stop()
    hub = undefined
    const ledger = await openLedger(flowPaths(h).ledgerDb)
    const events = ledger
      .eventsAfter(0, {}, 10_000)
      .filter((e) => e.type === 'channel.rebound' || e.type === 'channel.unlinked')
    ledger.close()
    expect(JSON.stringify(events)).not.toContain(String(USER_ID))
    expect(JSON.stringify(events)).not.toContain(String(OTHER_ID))
    return events.map((e) => [e.type, e.actor])
  }

  // 改绑与解绑各自一个场景：每个场景只做一次经 gitleaks 钩子的 config 提交（CI 上整条子进程链
  // 曾逼近 bun 的 5 秒单测时限，unlink 的提交还在运行时被判超时）。
  test('已绑定时不加 --rebind 拒绝发码；改绑先通知原 chat，记 channel.rebound，状态显示改绑时间', async () => {
    const fake = await new FakeTelegram().start()
    cleanups.push(() => fake.close())
    const h = await makeHome({ bound: true })
    const { logs, api } = await startHub(h, fake)
    await until(() => fake.offsets.length > 0, '开始长轮询')

    const plain = await api('/v1/telegram/link-code', { method: 'POST', body: '{}' })
    expect(plain.body.error.code).toBe('already_bound')
    expect(plain.body.error.message).toContain('--rebind')
    // user token 降级声明的 AI 身份：改绑码与解除绑定都被拒绝
    for (const path of ['/v1/telegram/link-code', '/v1/telegram/unlink']) {
      const ai = await api(path, {
        method: 'POST',
        body: JSON.stringify(path.endsWith('link-code') ? { rebind: true } : {}),
        actor: 'claude',
      })
      expect(ai.status).toBe(403)
      expect(ai.body.error.code).toBe('user_only')
    }

    const issued = await api('/v1/telegram/link-code', {
      method: 'POST',
      body: JSON.stringify({ rebind: true }),
    })
    expect(issued.status).toBe(201)
    fake.say(`/link ${issued.body.data.code}`, { chat: OTHER_ID })
    await until(() => fake.to(OTHER_ID).some((m) => m.text.includes('已绑定')), '改绑完成')
    const notice = fake.sent.findIndex((m) => m.chat_id === USER_ID && m.text.includes('已改绑'))
    const done = fake.sent.findIndex((m) => m.chat_id === OTHER_ID)
    expect(notice).toBeGreaterThanOrEqual(0)
    expect(notice).toBeLessThan(done)
    expect(fake.sent[notice]?.text).toContain('flow telegram unlink')
    expect(readFileSync(flowPaths(h).channelsConfig, 'utf8')).toContain(`chat_id: ${OTHER_ID}`)
    const status = await api('/v1/hub/status')
    expect(status.body.data.channels[0]?.last_rebound_at).not.toBeNull()
    // 原 chat 之后被忽略。
    const before = fake.to(USER_ID).length
    const u = fake.say('/inbox')
    await until(() => fake.offsets.some((x) => x > u), '处理原 chat 的消息')
    expect(fake.to(USER_ID)).toHaveLength(before)

    expect(await channelEvents(h)).toEqual([['channel.rebound', 'user']])
    await expectNoToken(h, fake.token, [logs, fake.sent])
  })

  test('unlink：立即生效并提交，之后原 chat 被忽略；重复 unlink 返回 false；记 channel.unlinked', async () => {
    const fake = await new FakeTelegram().start()
    cleanups.push(() => fake.close())
    const h = await makeHome({ bound: true })
    const { logs, api } = await startHub(h, fake)
    await until(() => fake.offsets.length > 0, '开始长轮询')

    const unlinked = await api('/v1/telegram/unlink', { method: 'POST', body: '{}' })
    expect(unlinked.body.data.unlinked).toBe(true)
    const yaml = readFileSync(flowPaths(h).channelsConfig, 'utf8')
    expect(yaml).not.toContain('chat_id')
    expect(
      execFileSync('git', ['log', '-1', '--format=%s'], { cwd: flowPaths(h).config })
        .toString()
        .trim(),
    ).toBe('channels: 解除 Telegram 绑定')
    const before = fake.to(USER_ID).length
    const u = fake.say('/inbox')
    await until(() => fake.offsets.some((x) => x > u), '处理解绑后的消息')
    expect(fake.to(USER_ID)).toHaveLength(before)
    const again = await api('/v1/telegram/unlink', { method: 'POST', body: '{}' })
    expect(again.body.data.unlinked).toBe(false)

    expect(await channelEvents(h)).toEqual([['channel.unlinked', 'user']])
    await expectNoToken(h, fake.token, [logs, fake.sent])
  })

  test('/capture 里粘贴的疑似密钥：写入 raw 前已脱敏', async () => {
    const fake = await new FakeTelegram().start()
    cleanups.push(() => fake.close())
    const h = await makeHome({ bound: true })
    await startHub(h, fake)
    const leaked = ['ghp', '_', 'Z9y8X7w6'.repeat(5)].join('')
    fake.say(`/capture 新 token ${leaked}`)
    await until(() => fake.to(USER_ID).some((m) => m.text.startsWith('已记下')), '随手记确认')
    const files = readdirSync(join(flowPaths(h).raw, 'inbox'))
    const text = readFileSync(join(flowPaths(h).raw, 'inbox', files[0] ?? ''), 'utf8')
    expect(text).toContain('新 token')
    expect(text).not.toContain(leaked)
  })
})

describe('渠道状态', () => {
  test('401（token 错误）：渠道 disabled，状态报告原因（不含 token），申请绑定码返回 channel_unavailable', async () => {
    const fake = await new FakeTelegram().start()
    cleanups.push(() => fake.close())
    const h = await makeHome({ bound: true })
    const wrong = ['31337', ['FLOWFAKE', 'WRONG', 'z'.repeat(10)].join('_')].join(':')
    const { logs, api } = await startHub(h, fake, { token: wrong })
    await until(() => logs.some((l) => l.message.includes('渠道已停用')), '停用')
    const status = await api('/v1/hub/status')
    const tg = status.body.data.channels[0]
    expect(tg).toMatchObject({ id: 'telegram', state: 'disabled' })
    // 不再永久停用：30 分钟后重试 getMe
    expect(tg?.next_retry_at).not.toBeNull()
    expect(tg?.last_error).toContain('401')
    const link = await api('/v1/telegram/link-code', { method: 'POST', body: '{}' })
    expect(link.body.error.code).toBe('channel_unavailable')
    expect(fake.calls.map((c) => c.method)).toEqual(['getMe'])
    await expectNoToken(h, wrong, [logs, status.body, link.body])
  })

  test('token 未配置：Telegram 不启动，状态报告缺少的密钥路径，绑定码不可申请', async () => {
    const fake = await new FakeTelegram().start()
    cleanups.push(() => fake.close())
    const h = await makeHome({
      channels: 'telegram:\n  bot_token: secret://telegram/bot-token\n',
    })
    const { api } = await startHub(h, fake, { token: null })
    const status = await api('/v1/hub/status')
    expect(status.body.data.channels).toEqual([
      expect.objectContaining({
        id: 'telegram',
        state: 'disabled',
        missing_secrets: ['telegram/bot-token'],
      }),
    ])
    expect(status.body.data.secrets.missing).toEqual([
      { path: 'telegram/bot-token', file: 'channels.yaml' },
    ])
    const link = await api('/v1/telegram/link-code', { method: 'POST', body: '{}' })
    expect(link.body.error.code).toBe('channel_unavailable')
    expect(link.body.error.message).toContain('flow secrets set telegram/bot-token')
    expect(fake.calls).toEqual([])
  })

  test('telegram.enabled: false：不注册渠道；配置写错：渠道创建失败并报告，中枢照常', async () => {
    const fake = await new FakeTelegram().start()
    cleanups.push(() => fake.close())
    const off = await makeHome({ channels: 'telegram:\n  enabled: false\n' })
    const a = await startHub(off, fake)
    expect((await a.api('/v1/hub/status')).body.data.channels).toEqual([])
    await hub?.stop()
    hub = undefined

    const bad = await makeHome({ channels: `telegram:\n  bot_token: ${fakeBotToken()}\n` })
    const b = await startHub(bad, fake)
    const s = (await b.api('/v1/hub/status')).body.data.channels[0]
    expect(s).toMatchObject({ id: 'telegram', state: 'disabled' })
    expect(s?.last_error).toContain('secret://')
    expect(fake.calls).toEqual([])
  })
})
