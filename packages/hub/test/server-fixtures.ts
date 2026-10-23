import type { LedgerEvent } from '@flow/core'
import type { EventFilter, LedgerReader } from '../src/ledger/port.ts'
import type { HubClock } from '../src/server/clock.ts'

export const testToken = 'x'.repeat(43)
export const authHeaders = { Authorization: `Bearer ${testToken}` }

export function event(seq: number, scope: EventFilter = {}): LedgerEvent {
  return {
    seq,
    ts: new Date(2026, 9, 24).toISOString(),
    type: 'hub.rebuilt',
    actor: 'hub',
    payload: { events_replayed: 0, duration_ms: 0 },
    ...scope,
  }
}

export class MemoryLedger implements LedgerReader {
  events: LedgerEvent[] = []
  listeners = new Set<(event: LedgerEvent) => void>()
  /** 在查询快照取得之后模拟另一个提交，覆盖补发窗口的竞争。 */
  onRead: (() => void) | undefined
  seq() {
    return this.events.at(-1)?.seq ?? 0
  }
  eventsAfter(after: number, filter: EventFilter = {}, limit = 500): LedgerEvent[] {
    const snapshot = this.events
      .filter(
        (event) =>
          event.seq > after &&
          (!filter.task_id || event.task_id === filter.task_id) &&
          (!filter.workspace || event.workspace === filter.workspace),
      )
      .slice(0, limit)
    this.onRead?.()
    return snapshot
  }
  subscribe(listener: (event: LedgerEvent) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  append(event: LedgerEvent) {
    this.events.push(event)
    for (const listener of this.listeners) listener(event)
  }
}

export const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

export class FakeClock implements HubClock {
  private timers = new Map<number, { at: number; callback: () => void | Promise<void> }>()
  private nextId = 0
  constructor(public time: number) {}
  now = () => this.time
  setTimeout(callback: () => void | Promise<void>, delayMs: number) {
    const id = ++this.nextId
    this.timers.set(id, { at: this.time + delayMs, callback })
    return () => {
      this.timers.delete(id)
    }
  }
  get pending() {
    return this.timers.size
  }
  async advance(ms: number) {
    const target = this.time + ms
    for (;;) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0]
      if (!next || next[1].at > target) break
      this.time = next[1].at
      this.timers.delete(next[0])
      await next[1].callback()
      await tick()
    }
    this.time = target
    await tick()
  }
}

/** 按 SSE 消息读取，不假设底层网络分块与消息边界相同。 */
export function sseReader(response: Response) {
  if (!response.body) throw new Error('缺少 SSE 响应体')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  return {
    cancel: () => reader.cancel(),
    async next(): Promise<string> {
      for (;;) {
        const boundary = text.indexOf('\n\n')
        if (boundary >= 0) {
          const message = text.slice(0, boundary)
          text = text.slice(boundary + 2)
          return message
        }
        const chunk = await reader.read()
        if (chunk.done) throw new Error('SSE 提前关闭')
        text += decoder.decode(chunk.value, { stream: true })
      }
    },
  }
}
