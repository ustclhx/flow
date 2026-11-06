import { afterEach, expect, test } from 'bun:test'
import { type EventOf, openDatabase } from '@raindown/core'
import { drafts, must, SHA, startTask, sys, tempLedger, WS } from './ledger-helpers.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

test('上报查询按 task、lease 和 attempt 隔离，并保留消费水位与重建结果', async () => {
  let time = Date.parse('2026-10-24T00:00:00.000Z')
  const e = await tempLedger({ now: () => time })
  cleanups.push(e.cleanup)
  for (const id of ['t-report', 't-other']) {
    must(e.store.append(drafts(id)['task.created'], sys))
    startTask(e.store, id)
  }
  const report = (id: string, attempt: number) =>
    must(
      e.store.append(
        {
          type: 'task.reported',
          task_id: id,
          workspace: WS,
          payload: {
            lease_id: `l-${id}-${attempt}`,
            attempt,
            status: 'progress',
            summary: '完成数据层',
          },
        },
        sys,
      ),
    ) as EventOf<'task.reported'>
  const first = report('t-report', 1)
  report('t-other', 1)
  time += 60_000
  const since = new Date(time).toISOString()
  const latest = report('t-report', 1)
  for (const seq of [latest.seq, first.seq])
    must(
      e.store.append(
        {
          type: 'task.report_consumed',
          task_id: 't-report',
          workspace: WS,
          payload: { lease_id: 'l-t-report-1', attempt: 1, report_seq: seq },
        },
        sys,
      ),
    )
  expect(e.store.attemptEnded('t-report', 1)).toBe(false)
  must(
    e.store.append(
      {
        type: 'task.attempt_ended',
        task_id: 't-report',
        workspace: WS,
        payload: { attempt: 1, reason: 'retry' },
      },
      sys,
    ),
  )
  const d = drafts('t-report')
  must(e.store.appendMany([d['task.lease_expired'], d['task.requeued:lease_expired']], sys))
  startTask(e.store, 't-report', 2)
  report('t-report', 2)

  const check = () => {
    expect(e.store.workerReport('t-report', 'l-t-report-1', 1, first.seq)).toEqual(first)
    expect(e.store.workerReport('t-other', 'l-t-report-1', 1, first.seq)).toBeNull()
    expect(e.store.workerReport('t-report', 'l-t-report-2', 2, first.seq)).toBeNull()
    expect(e.store.latestWorkerReport('t-report', 'l-t-report-1', 1)).toEqual(latest)
    expect(e.store.latestWorkerReport('t-report', 'l-t-report-1', 2)).toBeNull()
    expect(e.store.workerReportWatermark('t-report', 'l-t-report-1', 1)).toBe(latest.seq)
    expect(e.store.workerReportWatermark('t-report', 'l-t-report-2', 2)).toBe(0)
    expect(e.store.workerReportUsage('t-report', 'l-t-report-1', 1, since)).toEqual({
      total: 2,
      recent: 1,
    })
    expect(e.store.workerReportUsage('t-report', 'l-t-report-2', 2, since)).toEqual({
      total: 1,
      recent: 1,
    })
    expect(e.store.workerReportUsage('missing', 'missing', 1, since)).toEqual({
      total: 0,
      recent: 0,
    })
    expect(e.store.attemptEnded('t-report', 1)).toBe(true)
    expect(e.store.attemptEnded('t-report', 2)).toBe(false)
    expect(e.store.attemptEnded('t-other', 1)).toBe(false)
  }
  check()
  must(e.store.rebuild())
  check()
})

test('派工结束、最新上报与消费水位查询使用派工索引', async () => {
  const e = await tempLedger()
  cleanups.push(e.cleanup)
  const db = await openDatabase(e.path)
  try {
    for (const [type, tail, index] of [
      ['task.attempt_ended', 'LIMIT 1', 'events_attempt_ended'],
      ['task.reported', 'ORDER BY seq DESC LIMIT 1', 'events_worker_report'],
      ['task.report_consumed', '', 'events_worker_report_consumed'],
    ]) {
      const rows = db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT * FROM events WHERE task_id = ? AND type = '${type}'
           AND json_extract(payload_json, '$.attempt') = ?
           ${type === 'task.attempt_ended' ? '' : "AND json_extract(payload_json, '$.lease_id') = ?"}
           ${tail}`,
        )
        .all(...(type === 'task.attempt_ended' ? ['t-report', 1] : ['t-report', 1, 'lease'])) as {
        detail: string
      }[]
      expect(rows.some((row) => row.detail.includes(index ?? ''))).toBe(true)
    }
  } finally {
    db.close()
  }
})

test('回复绑定原卡住回合，后续卡住不改变绑定；最近事件查询排除上界', async () => {
  const e = await tempLedger()
  cleanups.push(e.cleanup)
  const id = 't-reply'
  const d = drafts(id)
  must(e.store.append(d['task.created'], sys))
  startTask(e.store, id)
  const first = must(
    e.store.append(
      {
        ...d['task.blocked'],
        payload: { ...d['task.blocked'].payload, approval_fingerprint: SHA },
      },
      sys,
    ),
  )
  must(
    e.store.append(
      {
        type: 'task.replied',
        task_id: id,
        workspace: WS,
        payload: { reply_id: 'r-first', kind: 'text', text: '使用 A' },
      },
      { actor: 'user' },
    ),
  )
  const latest = must(e.store.append(d['task.blocked'], sys))
  expect(e.store.latestTaskEvent(id, 'task.blocked')).toEqual(latest)
  expect(e.store.latestTaskEvent(id, 'task.blocked', latest.seq)).toEqual(first)
  expect(e.store.replyBlock(id, 'r-first')).toEqual({
    block_seq: first.seq,
    approval_fingerprint: SHA,
  })
  expect(e.store.replyBlock('other', 'r-first')).toBeUndefined()
  expect(e.store.replyBlock(id, 'missing')).toBeUndefined()
})
