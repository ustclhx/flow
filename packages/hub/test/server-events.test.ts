import { describe, expect, test } from 'bun:test'
import { createHubApp } from '../src/index.ts'
import {
  authHeaders,
  event,
  FakeClock,
  MemoryLedger,
  sseReader,
  testToken,
  tick,
} from './server-fixtures.ts'

function setup() {
  const ledger = new MemoryLedger()
  const clock = new FakeClock(0)
  const shutdown = new AbortController()
  const app = createHubApp({ ledger, clock, signal: shutdown.signal, token: testToken })
  return { ledger, clock, app, shutdown }
}

describe('SSE 断点续传', () => {
  test('收到 10 后断开，期间写入 11、12，重连后依次且只收到一次', async () => {
    const { ledger, app, clock } = setup()
    ledger.append(event(10))
    const first = sseReader(await app.request('/v1/events?after=9', { headers: authHeaders }))
    expect((await first.next()).split('\n')).toContain('id: 10')
    await first.cancel()
    expect(ledger.listeners.size).toBe(0)
    ledger.append(event(11))
    ledger.append(event(12))
    const second = sseReader(await app.request('/v1/events?after=10', { headers: authHeaders }))
    try {
      for (const seq of [11, 12]) {
        const message = await second.next()
        expect(message.split('\n')).toContain(`id: ${seq}`)
        expect(message).toContain('event: hub.rebuilt\n')
        const data = message.split('\n').find((line) => line.startsWith('data: '))
        if (!data) throw new Error('缺少事件信封')
        expect(JSON.parse(data.slice(6))).toEqual(event(seq))
      }
      ledger.append(event(13))
      expect((await second.next()).split('\n')).toContain('id: 13')
    } finally {
      await second.cancel()
    }
    expect(ledger.listeners.size).toBe(0)
    expect(clock.pending).toBe(0)
  })

  test('补发查询返回空快照时并发提交，缓冲事件不丢失且与历史去重', async () => {
    const { ledger, app } = setup()
    ledger.append(event(11))
    let reads = 0
    ledger.onRead = () => {
      reads++
      if (reads === 1) ledger.append(event(12))
      if (reads === 3) {
        ledger.onRead = undefined
        ledger.append(event(13))
      }
    }
    const stream = sseReader(await app.request('/v1/events?after=10', { headers: authHeaders }))
    try {
      for (const seq of [11, 12, 13])
        expect((await stream.next()).split('\n')).toContain(`id: ${seq}`)
      ledger.append(event(14))
      expect((await stream.next()).split('\n')).toContain('id: 14')
    } finally {
      await stream.cancel()
    }
  })

  test('历史超过一批时按序补发，Last-Event-ID 覆盖 after', async () => {
    const { ledger, app } = setup()
    for (let seq = 1; seq <= 505; seq++) ledger.append(event(seq))
    const stream = sseReader(
      await app.request('/v1/events?after=504', {
        headers: { ...authHeaders, 'Last-Event-ID': '2' },
      }),
    )
    try {
      for (let seq = 3; seq <= 505; seq++)
        expect((await stream.next()).split('\n')).toContain(`id: ${seq}`)
      ledger.append(event(506))
      expect((await stream.next()).split('\n')).toContain('id: 506')
    } finally {
      await stream.cancel()
    }
  })

  test('task_id 和 workspace 对补发与实时事件同时生效', async () => {
    const { ledger, app } = setup()
    const scope = { task_id: 'task-a', workspace: 'ws/demo' }
    ledger.append(event(1, scope))
    ledger.append(event(2, { ...scope, task_id: 'task-b' }))
    const stream = sseReader(
      await app.request('/v1/events?task_id=task-a&workspace=ws/demo', { headers: authHeaders }),
    )
    try {
      expect((await stream.next()).split('\n')).toContain('id: 1')
      ledger.append(event(3, { ...scope, workspace: 'ws/other' }))
      ledger.append(event(4, scope))
      expect((await stream.next()).split('\n')).toContain('id: 4')
    } finally {
      await stream.cancel()
    }
  })

  test('每 25 秒发注释心跳，服务停止取消订阅与 timer', async () => {
    const { ledger, app, clock, shutdown } = setup()
    const stream = sseReader(await app.request('/v1/events', { headers: authHeaders }))
    try {
      const message = stream.next()
      await clock.advance(24_999)
      let received = false
      void message.then(() => {
        received = true
      })
      await tick()
      expect(received).toBe(false)
      await clock.advance(1)
      expect(await message).toBe(': heartbeat')
      shutdown.abort()
      expect(ledger.listeners.size).toBe(0)
      expect(clock.pending).toBe(0)
    } finally {
      await stream.cancel()
    }
  })

  test.each(['after=-1', 'after=oops', 'after=1.5', 'task_id=bad%20id', 'extra=x'])(
    '拒绝非法查询 %s',
    async (query) => {
      const { app, ledger } = setup()
      expect((await app.request(`/v1/events?${query}`, { headers: authHeaders })).status).toBe(400)
      expect(ledger.listeners.size).toBe(0)
    },
  )

  test('请求 AbortSignal 断开也取消订阅', async () => {
    const { app, ledger, clock } = setup()
    const controller = new AbortController()
    const response = await app.request('/v1/events', {
      headers: authHeaders,
      signal: controller.signal,
    })
    controller.abort()
    expect(ledger.listeners.size).toBe(0)
    expect(clock.pending).toBe(0)
    await response.body?.cancel()
  })
})
