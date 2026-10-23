import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  flowPaths,
  hubStatusData,
  initFlowHome,
  type LedgerEvent,
  loadSchedulesConfig,
} from '@flow/core'
import { stringify } from 'yaml'
import { createScheduler, type HubClock, openLedger, runHub } from '../src/index.ts'
import { must } from './ledger-helpers.ts'
import { sseReader } from './server-fixtures.ts'

/** 正常运行时逐个触发定时器；睡眠时只推进墙钟，恢复回调可按任意顺序执行。 */
class Clock implements HubClock {
  time = Date.parse('2026-10-24T08:59:00Z')
  mono = 0
  timers = new Map<number, { at: number; callback: () => void | Promise<void> }>()
  nextId = 0
  now = () => this.time
  monotonic = () => this.mono
  setTimeout(callback: () => void | Promise<void>, delay: number) {
    const id = ++this.nextId
    this.timers.set(id, { at: this.time + delay, callback })
    return () => {
      this.timers.delete(id)
    }
  }
  async advance(ms: number) {
    const until = this.time + ms
    for (;;) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0]
      if (!next || next[1].at > until) break
      this.mono += next[1].at - this.time
      this.time = next[1].at
      this.timers.delete(next[0])
      await next[1].callback()
    }
    this.mono += until - this.time
    this.time = until
  }
  async wake(ms: number, latestFirst = false) {
    this.time += ms
    const due = [...this.timers]
      .filter(([, timer]) => timer.at <= this.time)
      .sort((a, b) => (latestFirst ? b[1].at - a[1].at : a[1].at - b[1].at))
    for (const [id, timer] of due) {
      if (!this.timers.delete(id)) continue
      await timer.callback()
    }
  }
}
const quiet = { info() {}, warn() {} }
const rule = (over: Record<string, unknown> = {}) => ({
  id: 'hourly',
  cron: '0 * * * *',
  timezone: 'UTC',
  workspace: 'ws/global',
  payload: { report: '巡检' },
  ...over,
})
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})
async function fixture(rules: unknown = [rule()]) {
  const home = await mkdtemp(join(tmpdir(), 'flow-scheduler-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  must(await initFlowHome(home))
  const config = flowPaths(home).schedulesConfig
  await writeFile(config, stringify(rules))
  const clock = new Clock()
  const ledger = await openLedger(flowPaths(home).ledgerDb, { now: clock.now })
  cleanups.push(() => ledger.close())
  const fires = () => ledger.eventsAfter(0).filter((event) => event.type === 'schedule.fired')
  const start = async () => {
    const scheduler = await createScheduler({ ledger, clock, home, logger: quiet })
    cleanups.push(() => scheduler.stop())
    return scheduler
  }
  return { home, config, clock, ledger, fires, start }
}

test('一条 cron 写错：合法规则照常触发，错误带规则 id、字段和原因', async () => {
  const f = await fixture([rule({ id: 'bad', cron: '61 * * * *' }), rule()])
  const scheduler = await f.start()
  expect(scheduler.errors()).toMatchObject([
    { rule_id: 'bad', field: 'cron', code: 'invalid_field' },
  ])
  expect(scheduler.errors()[0]?.message.length).toBeGreaterThan(0)
  expect(f.fires()).toHaveLength(0)
  await f.clock.advance(60_000)
  expect(f.fires()).toMatchObject([
    {
      workspace: 'ws/global',
      actor: 'hub',
      payload: {
        rule_id: 'hourly',
        planned_at: '2026-10-24T09:00:00.000Z',
        payload: { report: '巡检' },
        missed: false,
      },
    },
  ])
})

test('09:00 触发后 09:00:30 重启不重复；投影重建后仍能查询去重记录', async () => {
  const f = await fixture()
  const scheduler = await f.start()
  await f.clock.advance(60_000)
  scheduler.stop()
  await f.clock.advance(30_000)
  must(f.ledger.rebuild())
  expect(f.ledger.hasScheduleFire('hourly', '2026-10-24T09:00:00.000Z')).toBe(true)
  const restarted = await f.start()
  restarted.resume()
  expect(f.fires()).toHaveLength(1)
  await f.clock.advance(59 * 60_000 + 30_000)
  expect(f.fires().map((event) => event.payload.missed)).toEqual([false, false])
})

test('停机八小时：启动只补发最近一次，后续准点触发', async () => {
  const f = await fixture()
  const scheduler = await f.start()
  await f.clock.advance(60_000)
  scheduler.stop()
  await f.clock.advance(8 * 3600_000 + 30_000)
  const restarted = await f.start()
  restarted.resume()
  expect(f.fires().map((event) => event.payload)).toMatchObject([
    { planned_at: '2026-10-24T09:00:00.000Z', missed: false },
    { planned_at: '2026-10-24T17:00:00.000Z', missed: true },
  ])
})

test.each([false, true])('睡眠八小时只补发一次；唤醒通知先执行=%s', async (notifyFirst) => {
  const f = await fixture()
  const scheduler = await f.start()
  await f.clock.advance(60_000)
  if (notifyFirst) {
    f.clock.time += 8 * 3600_000
    scheduler.resume()
  } else {
    await f.clock.wake(8 * 3600_000)
    scheduler.resume()
  }
  scheduler.resume()
  expect(f.fires().map((event) => event.payload)).toMatchObject([
    { planned_at: '2026-10-24T09:00:00.000Z', missed: false },
    { planned_at: '2026-10-24T17:00:00.000Z', missed: true },
  ])
  expect(f.clock.timers.size).toBe(1)
})

test('时区：上海和洛杉矶的每日 09:00 对应正确的 UTC 计划时间', async () => {
  const f = await fixture([
    rule({ id: 'shanghai', cron: '0 9 * * *', timezone: 'Asia/Shanghai' }),
    rule({ id: 'los-angeles', cron: '0 9 * * *', timezone: 'America/Los_Angeles' }),
  ])
  f.clock.time = Date.parse('2026-10-24T00:00:00Z')
  await f.start()
  await f.clock.advance(16 * 3600_000)
  expect(f.fires().map((event) => event.payload)).toMatchObject([
    { rule_id: 'shanghai', planned_at: '2026-10-24T01:00:00.000Z', missed: false },
    { rule_id: 'los-angeles', planned_at: '2026-10-24T16:00:00.000Z', missed: false },
  ])
})

test('省略 timezone 使用本机时区，省略 payload 写入空对象', async () => {
  const f = await fixture([rule({ cron: '0 9 * * *', timezone: undefined, payload: undefined })])
  f.clock.time = new Date(2026, 9, 24, 8, 59).getTime()
  await f.start()
  await f.clock.advance(60_000)
  expect(f.fires()).toMatchObject([
    {
      payload: { planned_at: new Date(2026, 9, 24, 9).toISOString(), payload: {}, missed: false },
    },
  ])
})

test('长定时器分段等待、时钟回拨后继续按绝对计划时间触发', async () => {
  const f = await fixture([rule({ cron: '0 0 1 1 *' })])
  f.clock.time = Date.parse('2026-10-24T00:00:00Z')
  await f.start()
  expect([...f.clock.timers.values()][0]?.at).toBe(f.clock.time + 2_147_483_647)
  await f.clock.advance(2_147_483_647)
  expect(f.fires()).toHaveLength(0)
  f.clock.time -= 3600_000
  await f.clock.advance(Date.parse('2027-01-01T00:00:00Z') - f.clock.time)
  expect(f.fires()).toMatchObject([
    { payload: { planned_at: '2027-01-01T00:00:00.000Z', missed: false } },
  ])
})

test('reload 替换旧规则与错误；文件格式错误报告失败并撤销定时器', async () => {
  const f = await fixture([rule({ cron: 'bad' })])
  const scheduler = await f.start()
  await writeFile(f.config, stringify([rule({ id: 'new' })]))
  expect(must(await scheduler.reload()).loaded).toBe(1)
  expect(scheduler.errors()).toEqual([])
  await f.clock.advance(60_000)
  expect(f.fires()).toMatchObject([{ payload: { rule_id: 'new' } }])
  await writeFile(f.config, 'rules: []\n')
  expect((await scheduler.reload()).ok).toBe(false)
  expect(scheduler.errors()).toMatchObject([{ code: 'invalid_config' }])
  expect(f.clock.timers.size).toBe(0)
  await writeFile(f.config, stringify([rule()]))
  must(await scheduler.reload())
  scheduler.stop()
  expect(f.clock.timers.size).toBe(0)
})

test('配置：逐条拒绝未知 workspace、重复 id、非法字段与时区，保留其余规则', async () => {
  const f = await fixture([
    rule(),
    rule(),
    rule({ id: 'missing-ws', workspace: 'ws/unknown' }),
    { cron: '0 * * * *', workspace: 'ws/global' },
    rule({ id: 'bad-zone', timezone: 'Invalid/Zone' }),
  ])
  const scheduler = await f.start()
  expect(scheduler.loaded()).toBe(1)
  expect(scheduler.errors()).toMatchObject([
    { rule_id: 'hourly', rule_index: 1, field: 'id', code: 'duplicate_rule' },
    { rule_id: 'missing-ws', field: 'workspace', code: 'unknown_workspace' },
    { rule_index: 3, field: 'id', code: 'missing_field' },
    { rule_id: 'bad-zone', field: 'timezone', code: 'invalid_field' },
  ])
})

test('配置：缺失与空文件表示没有规则，YAML 语法错误和非数组返回文件级错误', async () => {
  const f = await fixture()
  await rm(f.config)
  expect(must(await loadSchedulesConfig(f.home))).toEqual({ rules: [], errors: [] })
  await writeFile(f.config, '')
  expect(must(await loadSchedulesConfig(f.home))).toEqual({ rules: [], errors: [] })
  for (const invalid of ['[', 'workspace: ws/global', '- id: a\n  id: b']) {
    await writeFile(f.config, invalid)
    const loaded = await loadSchedulesConfig(f.home)
    expect(loaded.ok).toBe(false)
    if (!loaded.ok) expect(loaded.error.code).toBe('invalid_config')
  }
})

test('runHub：真实 HTTP/SSE 可见准点事件与规则错误，停止后重启仍去重', async () => {
  const f = await fixture([rule(), rule({ id: 'bad', cron: 'invalid' })])
  f.ledger.close()
  // fixture 中的连接已关闭；只在中枢停止后才重新打开账本。
  cleanups.pop()
  const hub = must(await runHub({ home: f.home, port: 0, clock: f.clock, logger: quiet }))
  cleanups.push(() => hub.stop())
  const token = (await readFile(flowPaths(f.home).hubToken, 'utf8')).trim()
  const headers = { Authorization: `Bearer ${token}` }
  expect((await fetch(`${hub.url}/v1/hub/status`)).status).toBe(401)
  const status = (await (await fetch(`${hub.url}/v1/hub/status`, { headers })).json()) as {
    data: unknown
  }
  const data = hubStatusData.parse(status.data)
  expect(data.schedule_errors).toMatchObject([{ rule_id: 'bad', field: 'cron' }])
  expect(data.schedules).toMatchObject({ loaded: 1, errors: data.schedule_errors })
  const stream = sseReader(await fetch(`${hub.url}/v1/events?after=0`, { headers }))
  cleanups.push(() => stream.cancel())
  await f.clock.advance(60_000)
  let event: LedgerEvent | undefined
  while (event?.type !== 'schedule.fired') {
    const message = await stream.next()
    const line = message.split('\n').find((line) => line.startsWith('data: '))
    if (!line) continue
    event = JSON.parse(line.slice(6)) as LedgerEvent
  }
  expect(event).toMatchObject({ type: 'schedule.fired', payload: { missed: false } })
  await stream.cancel()
  cleanups.pop()
  await hub.stop()
  await f.clock.advance(30_000)
  const restarted = must(await runHub({ home: f.home, port: 0, clock: f.clock, logger: quiet }))
  await restarted.stop()
  const ledger = await openLedger(flowPaths(f.home).ledgerDb)
  try {
    expect(ledger.eventsAfter(0).filter((event) => event.type === 'schedule.fired')).toHaveLength(1)
  } finally {
    ledger.close()
  }
  expect(f.clock.timers.size).toBe(0)
})

test.each([false, true])(
  'runHub：真实睡眠检测通知补发；旧调度回调先执行=%s',
  async (latestFirst) => {
    const f = await fixture()
    f.ledger.close()
    cleanups.pop()
    const hub = must(await runHub({ home: f.home, port: 0, clock: f.clock, logger: quiet }))
    cleanups.push(() => hub.stop())
    await f.clock.wake(8 * 3600_000, latestFirst)
    await hub.stop()
    const ledger = await openLedger(flowPaths(f.home).ledgerDb)
    try {
      const events = ledger.eventsAfter(0)
      expect(events.filter((event) => event.type === 'hub.resumed')).toHaveLength(1)
      expect(events.filter((event) => event.type === 'schedule.fired')).toMatchObject([
        { payload: { planned_at: '2026-10-24T16:00:00.000Z', missed: true } },
      ])
    } finally {
      ledger.close()
    }
  },
)
