import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  execCommand,
  flowPaths,
  HubClient,
  initFlowHome,
  initSecrets,
  ok,
  redactSecrets,
  registerKnownSecrets,
  sanitizeMessage,
  sanitizeTail,
  setSecret,
} from '@flow/core'
import {
  createHubSecrets,
  type HubLogger,
  openLedger,
  type RunningHub,
  redactDeep,
  redactingLogger,
  resolveSecretRefs,
  runHub,
  SecretRedactor,
} from '../src/index.ts'

// 测试里不写像真密钥的字面量：运行时拼接出形似 Telegram bot token 的值。
const fakeBotToken = () => `${'7'.repeat(10)}:${['AAH', 'not', 'real', 'x'.repeat(24)].join('')}`
const LABEL = '[secret:telegram/bot-token]'

const roots: string[] = []
let hub: RunningHub | undefined
afterEach(async () => {
  await hub?.stop()
  hub = undefined
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

async function setupHome(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'flow-hub-secrets-'))
  roots.push(root)
  const home = join(root, 'home')
  const init = await initFlowHome(home)
  if (!init.ok) throw new Error(init.error.message)
  mkdirSync(join(home, 'config', 'workspaces'), { recursive: true })
  writeFileSync(
    join(home, 'config', 'workspaces', 'demo.yaml'),
    'id: demo\nkind: product\nname: Demo\ndescription: 测试\nrepos: []\n',
  )
  return home
}

/** 只需要文件存在：真正的解密由注入的 load 完成。 */
const fakeEncrypted = (home: string) =>
  writeFileSync(join(flowPaths(home).config, 'secrets.sops.yaml'), 'sops: {}\n')
const channels = (home: string) =>
  writeFileSync(
    join(flowPaths(home).config, 'channels.yaml'),
    'telegram:\n  enabled: true\n  bot_token: secret://telegram/bot-token\n',
  )

describe('脱敏名单', () => {
  test('值替换为 [secret:<路径>]；短于 8 的值不入名单；长值优先', () => {
    const r = new SecretRedactor()
    r.add('short', 'abc1234')
    r.add('outer', 'prefix-inner-value-suffix')
    r.add('inner', 'inner-value')
    expect(r.size).toBe(2)
    expect(r.redact('abc1234 x prefix-inner-value-suffix y inner-value')).toBe(
      'abc1234 x [secret:outer] y [secret:inner]',
    )
  })

  test('多行值整体与逐行都入名单；轮换后旧值仍被替换', () => {
    const r = new SecretRedactor()
    const line1 = `line-one-${'a'.repeat(10)}`
    const line2 = `line-two-${'b'.repeat(10)}`
    r.add('pem', `${line1}\n${line2}`)
    expect(r.redact(`x ${line1}\n${line2} y`)).toBe('x [secret:pem] y')
    expect(r.redact(`只有第二行 ${line2}`)).toBe('只有第二行 [secret:pem]')
    r.addAll(new Map([['pem', `new-value-${'c'.repeat(10)}`]]))
    expect(r.redact(line1)).toBe('[secret:pem]')
  })

  test('redactDeep 只改字符串值，不改键；registerKnownSecrets 让正则兜底之前先套名单', () => {
    const value = fakeBotToken()
    const r = new SecretRedactor()
    r.add('telegram/bot-token', value)
    expect(redactDeep({ [value]: [value, 1, { t: `a ${value}` }] }, r.redact)).toEqual({
      [value]: [LABEL, 1, { t: `a ${LABEL}` }],
    })
    // 未注册时，形如 `TOKEN=<值>` 的行被正则按 assignment 规则替换，丢失路径信息。
    const line = `TELEGRAM_BOT_TOKEN=${value}`
    expect(redactSecrets(line)).toBe('TELEGRAM_BOT_TOKEN=[REDACTED:assignment]')
    const unregister = registerKnownSecrets(r.redact)
    try {
      expect(redactSecrets(line)).toBe(`TELEGRAM_BOT_TOKEN=${LABEL}`)
      // 截断之前就替换：密钥恰好跨过 2000 字符的截断点时也不留下前缀。
      const long = `${'x'.repeat(1990)}${value}`
      expect(sanitizeMessage(long)).not.toContain(value.slice(0, 10))
      expect(sanitizeTail([long])[0]).not.toContain(value.slice(0, 10))
    } finally {
      unregister()
    }
    expect(redactSecrets(value)).toBe(value)
  })

  test('日志：消息、details 与 Error 都经过替换', () => {
    const value = fakeBotToken()
    const r = new SecretRedactor()
    r.add('telegram/bot-token', value)
    const lines: unknown[][] = []
    const sink: HubLogger = {
      info: (...a) => lines.push(a),
      warn: (...a) => lines.push(a),
    }
    const log = redactingLogger(sink, r.redact)
    log.info(`启动 ${value}`)
    log.warn('失败', { detail: value })
    log.warn('异常', new Error(`bad ${value}`))
    expect(JSON.stringify(lines)).not.toContain(value)
    expect(lines[0]).toEqual([`启动 ${LABEL}`])
  })
})

describe('secret:// 解析', () => {
  test('整串引用被替换，缺失的保留原样并报告', () => {
    const r = resolveSecretRefs(
      { a: 'secret://x/y', b: ['secret://missing/z', 'text secret://x/y'], n: 1 },
      new Map([['x/y', 'value-xy']]),
    )
    expect(r).toEqual({
      value: { a: 'value-xy', b: ['secret://missing/z', 'text secret://x/y'], n: 1 },
      missing: ['missing/z'],
    })
  })

  test('token 未配置：依赖它的功能拿到 missing，状态报告缺少的路径', async () => {
    const home = await setupHome()
    fakeEncrypted(home)
    channels(home)
    const secrets = createHubSecrets({
      home,
      load: async () => ok(new Map([['other/key', 'other-value-1234']])),
    })
    const status = await secrets.reload()
    expect(status).toEqual({
      loaded: 1,
      missing: [{ path: 'telegram/bot-token', file: 'channels.yaml' }],
      error: null,
    })
    const telegram = secrets.resolve({ bot_token: 'secret://telegram/bot-token' })
    expect(telegram.missing).toEqual(['telegram/bot-token'])
    secrets.close()
  })

  test('未初始化密钥但有引用：error=secrets_not_initialized；解密失败保留上次结果', async () => {
    const home = await setupHome()
    channels(home)
    let calls = 0
    const value = fakeBotToken()
    const secrets = createHubSecrets({
      home,
      load: async () => {
        calls++
        return calls === 1
          ? ok(new Map([['telegram/bot-token', value]]))
          : { ok: false, error: { kind: 'failure', code: 'sops_missing', message: 'x' } }
      },
    })
    expect((await secrets.reload()).error).toBe('secrets_not_initialized')
    expect(calls).toBe(0)
    fakeEncrypted(home)
    expect(await secrets.reload()).toEqual({ loaded: 1, missing: [], error: null })
    expect(secrets.resolve('secret://telegram/bot-token').value).toBe(value)
    const failed = await secrets.reload()
    expect(failed).toEqual({ loaded: 1, missing: [], error: 'sops_missing' })
    expect(secrets.redactor.redact(value)).toBe(LABEL)
    secrets.close()
  })

  test('配置变化时重新解析', async () => {
    const home = await setupHome()
    fakeEncrypted(home)
    const changes: unknown[] = []
    const secrets = createHubSecrets({
      home,
      load: async () => ok(new Map()),
      debounceMs: 20,
      onChange: (s) => changes.push(s.missing),
    })
    await secrets.reload()
    const stop = secrets.watch()
    // 刚建立的监听可能错过紧随其后的写入（macOS FSEvents 的延迟）。
    await Bun.sleep(200)
    channels(home)
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && JSON.stringify(changes.at(-1)) === '[]') await Bun.sleep(25)
    stop()
    secrets.close()
    expect(changes.at(-1)).toEqual([{ path: 'telegram/bot-token', file: 'channels.yaml' }])
  })
})

describe('中枢集成', () => {
  test('flow hub status 报告缺少的密钥路径，其余功能照常', async () => {
    const home = await setupHome()
    fakeEncrypted(home)
    channels(home)
    const started = await runHub({
      home,
      port: 0,
      logger: { info() {}, warn() {} },
      secrets: { load: async () => ok(new Map()), watch: false },
    })
    if (!started.ok) throw new Error(started.error.message)
    hub = started.data
    writeFileSync(join(home, 'config', 'hub.yaml'), `port: ${hub.port}\n`)
    const status = await new HubClient({ home, actor: 'user' }).status()
    expect(status).toMatchObject({
      ok: true,
      data: {
        secrets: {
          loaded: 0,
          missing: [{ path: 'telegram/bot-token', file: 'channels.yaml' }],
          error: null,
        },
      },
    })
    const tasks = await new HubClient({ home, actor: 'user' }).listTasks()
    expect(tasks.ok).toBe(true)
  })

  test('worker 把 token 打印到终端：账本中的卡住输出与活动片段都替换为 [secret:telegram/bot-token]', async () => {
    const home = await setupHome()
    fakeEncrypted(home)
    channels(home)
    const value = fakeBotToken()
    const logged: unknown[][] = []
    const started = await runHub({
      home,
      port: 0,
      logger: { info: (...a) => logged.push(a), warn: (...a) => logged.push(a) },
      secrets: { load: async () => ok(new Map([['telegram/bot-token', value]])), watch: false },
    })
    if (!started.ok) throw new Error(started.error.message)
    hub = started.data
    const token = readFileSync(flowPaths(home).hubToken, 'utf8').trim()
    const call = async (path: string, body?: unknown, actor = 'node:n1') => {
      const res = await fetch(`${hub?.url}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Flow-Actor': actor,
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      return (await res.json()) as { ok: boolean; data: Record<string, never> }
    }
    const created = await call(
      '/v1/tasks',
      { goal: `目标里也有 ${value}`, workspace: 'ws/demo', role: 'dev', executor: 'fake' },
      'user',
    )
    expect(created.ok).toBe(true)
    await call('/v1/nodes', {
      node_id: 'n1',
      hostname: 'h',
      version: '0',
      capabilities: ['executor:fake'],
    })
    const lease = (await call('/v1/leases', {
      node_id: 'n1',
      capabilities: ['executor:fake'],
      wait_s: 0,
    })) as unknown as { data: { lease: { lease_id: string; lease_token: string } } }
    const { lease_id, lease_token } = lease.data.lease
    const ts = new Date().toISOString()
    const renewed = await call(`/v1/leases/${lease_id}/renew`, {
      lease_token,
      activity: [{ ts, kind: 'output', text: `bot token: ${value}` }],
    })
    expect(renewed.ok).toBe(true)
    const done = await call(`/v1/leases/${lease_id}/complete`, {
      lease_token,
      outcome: 'blocked',
      blocked_reason: 'question',
      message: `卡住了 ${value}`,
      tail: ['启动中', value, `TELEGRAM_BOT_TOKEN=${value}`],
    })
    expect(done.ok).toBe(true)
    await hub.stop()
    hub = undefined

    const ledger = await openLedger(flowPaths(home).ledgerDb)
    try {
      const events = ledger.eventsAfter(0)
      const all = JSON.stringify(events)
      expect(all).not.toContain(value)
      const blocked = events.find((e) => e.type === 'task.blocked')
      expect(blocked?.payload).toMatchObject({
        message: `卡住了 ${LABEL}`,
        tail: ['启动中', LABEL, `TELEGRAM_BOT_TOKEN=${LABEL}`],
      })
      const task = events.find((e) => e.type === 'task.created')
      expect(JSON.stringify(task?.payload)).toContain(LABEL)
      const activity = ledger.taskActivity(task?.task_id as string)
      expect(activity.map((a) => a.text)).toEqual([`bot token: ${LABEL}`])
    } finally {
      ledger.close()
    }
    expect(JSON.stringify(logged)).not.toContain(value)
  })
})

// 真实 sops：本机未安装时跳过，CI（已安装 sops/age）中必须运行。
const hasSops = (await execCommand('sops', ['--version'])).code === 0
if (process.env.FLOW_REQUIRE_SOPS_TESTS === '1' && !hasSops)
  throw new Error('CI 必须安装 sops 并运行真实密钥测试')

describe('真实 sops + age', () => {
  test.skipIf(!hasSops)(
    '中枢用 sops 解密、解析引用并报告缺失',
    async () => {
      const home = await setupHome()
      const ageKeyFile = join(dirname(home), 'age', 'keys.txt')
      const opts = { ageKeyFile }
      expect((await initSecrets(home, opts)).ok).toBe(true)
      const value = fakeBotToken()
      expect((await setSecret(home, 'telegram/bot-token', value, opts)).ok).toBe(true)
      writeFileSync(
        join(flowPaths(home).config, 'channels.yaml'),
        'telegram:\n  bot_token: secret://telegram/bot-token\nother: secret://not/set\n',
      )
      const { loadSecrets } = await import('@flow/core')
      const secrets = createHubSecrets({ home, load: (h) => loadSecrets(h, opts) })
      expect(await secrets.reload()).toEqual({
        loaded: 1,
        missing: [{ path: 'not/set', file: 'channels.yaml' }],
        error: null,
      })
      expect(secrets.resolve({ t: 'secret://telegram/bot-token' }).value).toEqual({ t: value })
      expect(secrets.redactor.redact(`x${value}x`)).toBe(`x${LABEL}x`)
      secrets.close()
    },
    60_000,
  )
})
