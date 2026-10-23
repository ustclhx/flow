import { expect, test } from 'bun:test'
import { Cron } from 'croner'

/**
 * 依赖 API 的冒烟测试：确认第 6 组（定时规则）要用的 croner 接口存在且语义符合预期。
 * - `new Cron(expr, { timezone, paused: true })` 只解析不调度；
 * - `nextRun(from)` 求下一次、`previousRuns(n, ref)` 求最近 n 次（由近到远）。
 */
test('croner：nextRun / previousRuns 与时区', () => {
  const cron = new Cron('0 * * * *', { timezone: 'Asia/Shanghai', paused: true })
  const ref = new Date('2026-10-24T08:30:00.000Z')
  expect(cron.nextRun(ref)?.toISOString()).toBe('2026-10-24T09:00:00.000Z')
  expect(cron.previousRuns(2, ref).map((d) => d.toISOString())).toEqual([
    '2026-10-24T08:00:00.000Z',
    '2026-10-24T07:00:00.000Z',
  ])
  const daily = new Cron('30 3 * * *', { timezone: 'Asia/Shanghai', paused: true })
  expect(daily.nextRun(ref)?.toISOString()).toBe('2026-10-24T19:30:00.000Z')
  expect(() => new Cron('61 * * * *', { paused: true })).toThrow()
})
