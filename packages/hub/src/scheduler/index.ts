import {
  fail,
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
/**
 * 中枢内部的定时规则（add-m1-inbox design D8）：与 `schedules.yaml` 的规则共用触发与睡眠补发机制，
 * 但 id 以 `<命名空间>:` 开头（例如 `inbox:digest`），不写进 `schedules.yaml`，
 * 触发时不写 `schedule.fired`，而是回调（回调方自己保证幂等，例如按日期确定的条目 id）。
 * 时间按系统本地时区计算。
 */
export interface InternalRule {
  id: string
  cron: string
  onFire(planned: Date, missed: boolean): void | Promise<void>
}

export interface Scheduler {
  /**
   * 替换某个命名空间（例如 `inbox:`）下的全部内部规则；cron 写错时整组不生效并返回错误。
   * 不受 `reload()` 影响。某个 id 第一次设置时，若中枢停机期间错过了它的触发时间，补发最近一次（missed）。
   */
  setInternalRules(prefix: string, rules: readonly InternalRule[]): Result<{ loaded: number }>
  /** 重新读取配置并替换定时器；文件级错误也可由 errors() 查询。 */
  reload(): Promise<Result<{ loaded: number }>>
  /** 睡眠检测发现唤醒后调用；每条规则最多补发最近一次。 */
  resume(): void
  errors(): ScheduleError[]
  loaded(): number
  stop(): void
}

interface ActiveRule {
  id: string
  cron: Cron
  cancel: () => void
  fire: (planned: Date, missed: boolean) => void
  /** 最近一次触发的计划时间（毫秒）：睡眠补发与定时器先后到达时不重复触发。 */
  last?: number
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
  /** 本次启动前账本的最后位置：内部规则首次设置时，据此补发停机期间错过的最近一次。 */
  const bootSince = since
  const seenInternal = new Set<string>()
  let active: ActiveRule[] = []
  /** 内部规则，按命名空间分组。 */
  const internal = new Map<string, ActiveRule[]>()
  const allRules = () => [...active, ...[...internal.values()].flat()]
  let errors: ScheduleError[] = []
  let stopped = false
  let generation = 0

  const emitter = (rule: ScheduleRule) => (planned: Date, missed: boolean) => {
    const planned_at = planned.toISOString()
    if (ledger.hasScheduleFire(rule.id, planned_at)) return
    const result = ledger.append(
      {
        type: 'schedule.fired',
        workspace: rule.workspace,
        payload: { rule_id: rule.id, planned_at, payload: rule.payload, missed },
      },
      { actor: 'hub' },
    )
    if (!result.ok && result.error.code !== 'duplicate_fire') {
      logger.warn('定时事件写入失败', result.error)
    }
  }
  const emit = (entry: ActiveRule, planned: Date, missed: boolean) => {
    if (entry.last !== undefined && planned.getTime() <= entry.last) return
    entry.last = planned.getTime()
    try {
      entry.fire(planned, missed)
    } catch (err) {
      logger.warn('定时规则回调失败', { rule_id: entry.id, error: String(err) })
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
    for (const entry of allRules()) {
      const recent = previousRun(entry, now)
      if (recent && recent.getTime() > since) emit(entry, recent, true)
      arm(entry)
    }
    since = now
  }

  const scheduler: Scheduler = {
    setInternalRules(prefix, rules) {
      if (!/^[a-z]+:$/.test(prefix)) {
        return fail('usage', 'invalid_prefix', `内部规则的命名空间应形如 inbox:，收到 ${prefix}`)
      }
      const built: ActiveRule[] = []
      for (const rule of rules) {
        if (!rule.id.startsWith(prefix) || rule.id.length === prefix.length) {
          return fail('usage', 'invalid_rule', `内部规则 ${rule.id} 的 id 应以 ${prefix} 开头`)
        }
        try {
          const cron = new Cron(rule.cron, { paused: true })
          cron.nextRun(new Date(clock.now()))
          built.push({
            id: rule.id,
            cron,
            cancel: () => {},
            fire: (planned, missed) => {
              void Promise.resolve(rule.onFire(planned, missed)).catch((err) =>
                logger.warn('内部定时规则回调失败', { rule_id: rule.id, error: String(err) }),
              )
            },
          })
        } catch (err) {
          for (const b of built) b.cron.stop()
          return fail('usage', 'invalid_rule', `内部规则 ${rule.id} 的 cron 无效：${String(err)}`)
        }
      }
      for (const entry of internal.get(prefix) ?? []) {
        entry.cancel()
        entry.cron.stop()
      }
      if (stopped) return ok({ loaded: 0 })
      internal.set(prefix, built)
      const now = clock.now()
      for (const entry of built) {
        if (!seenInternal.has(entry.id)) {
          seenInternal.add(entry.id)
          const recent = previousRun(entry, now)
          if (recent && recent.getTime() > bootSince) emit(entry, recent, true)
        }
        arm(entry)
      }
      return ok({ loaded: built.length })
    },
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
          active.push({ id: rule.id, cron, cancel: () => {}, fire: emitter(rule) })
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
      for (const entry of allRules()) {
        entry.cancel()
        entry.cron.stop()
      }
      active = []
      internal.clear()
    },
  }
  await scheduler.reload()
  return scheduler
}
