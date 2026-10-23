import { ENDPOINTS, eventsQuery, HEADERS, type LedgerEvent } from '@flow/core'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { errorResponse } from '../app.ts'
import type { EventFilter, LedgerReader } from '../ledger/port.ts'
import { type HubClock, systemClock } from './clock.ts'

export interface EventStreamOptions {
  clock?: HubClock
  /** stopHub 时关闭长连接并取消订阅。 */
  signal?: AbortSignal
}

export function createEventsApp(ledger: LedgerReader, options: EventStreamOptions = {}): Hono {
  const app = new Hono()
  const clock = options.clock ?? systemClock
  app.get(ENDPOINTS.events.path, (c) => {
    const query = eventsQuery.safeParse({
      ...c.req.query(),
      ...(c.req.header(HEADERS.lastEventId) !== undefined
        ? { after: c.req.header(HEADERS.lastEventId) }
        : {}),
    })
    if (!query.success) {
      return errorResponse(c, 'invalid_arguments', '事件流查询参数不合法', query.error.issues)
    }
    const { after, task_id, workspace } = query.data
    const filter: EventFilter = {
      ...(task_id ? { task_id } : {}),
      ...(workspace ? { workspace } : {}),
    }
    return streamSSE(c, async (stream) => {
      let cursor = after
      let pending: LedgerEvent[] = []
      let wake: (() => void) | undefined
      let closed = false
      let heartbeat = false
      let cancelTimer = () => {}
      // 必须先订阅：补发中的写入即使不在当前查询批次中，也会进入 pending。
      const unsubscribe = ledger.subscribe((event) => {
        if (
          event.seq > cursor &&
          (!filter.task_id || event.task_id === filter.task_id) &&
          (!filter.workspace || event.workspace === filter.workspace)
        ) {
          pending.push(event)
          wake?.()
        }
      })
      const cleanup = () => {
        if (closed) return
        closed = true
        unsubscribe()
        cancelTimer()
        options.signal?.removeEventListener('abort', abort)
        c.req.raw.signal.removeEventListener('abort', abort)
        wake?.()
      }
      const abort = () => {
        cleanup()
        stream.abort()
      }
      stream.onAbort(cleanup)
      options.signal?.addEventListener('abort', abort, { once: true })
      c.req.raw.signal.addEventListener('abort', abort, { once: true })
      const armHeartbeat = () => {
        cancelTimer = clock.setTimeout(() => {
          heartbeat = true
          wake?.()
          if (!closed) armHeartbeat()
        }, 25_000)
      }
      const send = async (event: LedgerEvent) => {
        if (closed || event.seq <= cursor) return
        await stream.writeSSE({
          id: String(event.seq),
          event: event.type,
          data: JSON.stringify(event),
        })
        cursor = event.seq
      }
      try {
        if (options.signal?.aborted || c.req.raw.signal.aborted) return abort()
        armHeartbeat()
        while (!closed) {
          const batch = ledger.eventsAfter(cursor, filter, 500)
          if (!batch.length) break
          for (const event of batch) await send(event)
        }
        while (!closed) {
          const batch = pending.sort((a, b) => a.seq - b.seq)
          pending = []
          for (const event of batch) await send(event)
          if (heartbeat && !closed) {
            heartbeat = false
            await stream.write(': heartbeat\n\n')
          }
          if (!closed && !pending.length && !heartbeat) {
            await new Promise<void>((resolve) => {
              wake = resolve
            })
            wake = undefined
          }
        }
      } finally {
        cleanup()
      }
    })
  })
  return app
}
