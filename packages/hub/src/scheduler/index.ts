import {
  loadSchedulesConfig,
  ok,
  type Result,
  type ScheduleError,
  type ScheduleRule,
} from '@flow/core'
import { Cron } from 'croner'
import type { LedgerStore } from '../ledger/store.ts'
import { SLEEP_THRESHOLD_MS } from '../nodes/sleep.ts'
import type { HubClock } from '../server/clock.ts'
import { consoleLogger, type HubLogger } from '../server/maintenance.ts'

export interface SchedulerOptions {
  ledger: LedgerStore
  clock: HubClock
  home: string
  logger?: Pick<HubLogger, 'warn'>
}
export interface Scheduler {
  /** 重新读取配置并替换定时器；文件级错误也可由 errors() 查询。 */
  reload(): Promise<Result<{ loaded: number }>>
  /** 睡眠检测发现唤醒后调用；每条规则最多补发最近一次。 */
  resume(): void
  errors(): ScheduleError[]
  loaded(): number
  stop(): void
}

interface ActiveRule {
  rule: ScheduleRule
  cron: Cron
  cancel: () => void
}
// Node 的 setTimeout 超出有符号 32 位范围会退化为 1ms；分段等待时仍使用绝对计划时间。
const MAX_TIMEOUT_MS = 2_147_483_647

/** croner 只计算日历时间，所有定时器均由 HubClock 驱动。 */
export async function createScheduler(o: SchedulerOptions): Promise<Scheduler> {
  const { ledger, clock } = o
  const logger = o.logger ?? consoleLogger
  const latest = ledger.latestEvent()
  const previous = latest?.type === 'hub.started' ? ledger.latestEvent(latest.seq) : latest
  let since = previous ? Date.parse(previous.ts) : clock.now()
  let active: ActiveRule[] = []
  let errors: ScheduleError[] = []
  let stopped = false
  let generation = 0

  const emit = (entry: ActiveRule, planned: Date, missed: boolean) => {
    const planned_at = planned.toISOString()
    if (ledger.hasScheduleFire(entry.rule.id, planned_at)) return
    const result = ledger.append(
      {
        type: 'schedule.fired',
        workspace: entry.rule.workspace,
        payload: { rule_id: entry.rule.id, planned_at, payload: entry.rule.payload, missed },
      },
      { actor: 'hub' },
    )
    if (!result.ok && result.error.code !== 'duplicate_fire') {
      logger.warn('定时事件写入失败', result.error)
    }
  }
  // croner 按秒排除 ref 所在秒；以后一秒为参照，包含当前秒的计划时间。
  const previousRun = (entry: ActiveRule, now: number) =>
    entry.cron.previousRuns(1, new Date(Math.floor(now / 1000) * 1000 + 1000))[0]

  const arm = (entry: ActiveRule, planned = entry.cron.nextRun(new Date(clock.now()))) => {
    entry.cancel()
    if (stopped || !planned) return
    entry.cancel = clock.setTimeout(
      () => {
        if (stopped) return
        const now = clock.now()
        if (now < planned.getTime()) {
          arm(entry, planned)
          return
        }
        // 唤醒时旧定时器可能先于睡眠检测运行：直接取最近一次，绝不沿着旧计划逐次追赶。
        const recent = previousRun(entry, now)
        if (recent && recent.getTime() >= planned.getTime()) {
          emit(
            entry,
            recent,
            recent.getTime() > planned.getTime() || now - planned.getTime() > SLEEP_THRESHOLD_MS,
          )
        }
        arm(entry)
      },
      Math.min(MAX_TIMEOUT_MS, Math.max(0, planned.getTime() - clock.now())),
    )
  }

  const resume = () => {
    if (stopped) return
    const now = clock.now()
    for (const entry of active) {
      const recent = previousRun(entry, now)
      if (recent && recent.getTime() > since) emit(entry, recent, true)
      arm(entry)
    }
    since = now
  }

  const scheduler: Scheduler = {
    async reload() {
      const version = ++generation
      const loaded = await loadSchedulesConfig(o.home)
      if (stopped || version !== generation) return ok({ loaded: active.length })
      for (const entry of active) {
        entry.cancel()
        entry.cron.stop()
      }
      active = []
      errors = []
      if (!loaded.ok) {
        errors = [{ code: loaded.error.code, message: loaded.error.message }]
        logger.warn('定时规则加载失败', errors)
        return loaded
      }
      errors = [...loaded.data.errors]
      for (const rule of loaded.data.rules) {
        let field = 'timezone'
        try {
          if (rule.timezone) new Intl.DateTimeFormat('en', { timeZone: rule.timezone })
          field = 'cron'
          const cron = new Cron(rule.cron, {
            paused: true,
            ...(rule.timezone ? { timezone: rule.timezone } : {}),
          })
          // 提前计算，保证解析失败不会留到定时器回调中才暴露。
          cron.nextRun(new Date(clock.now()))
          active.push({ rule, cron, cancel: () => {} })
        } catch (err) {
          errors.push({
            rule_id: rule.id,
            field,
            code: 'invalid_field',
            message: String(err),
          })
        }
      }
      if (errors.length) logger.warn('定时规则加载错误', errors)
      resume()
      return ok({ loaded: active.length })
    },
    resume,
    errors: () => errors.map((error) => ({ ...error })),
    loaded: () => active.length,
    stop() {
      stopped = true
      generation++
      for (const entry of active) {
        entry.cancel()
        entry.cron.stop()
      }
      active = []
    },
  }
  await scheduler.reload()
  return scheduler
}
