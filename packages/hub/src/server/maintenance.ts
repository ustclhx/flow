import { mkdir, readdir, unlink } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { flowPaths, type HubConfig } from '@flow/core'
import type { LedgerMaintenance } from '../ledger/port.ts'
import { type HubClock, systemClock } from './clock.ts'

export interface BackupInfo {
  /** 相对 flow-home 的备份路径。 */
  path: string
  at: string
  kept: number
}

export interface HubLogger {
  info(message: string, details?: unknown): void
  warn(message: string, details?: unknown): void
}

export const consoleLogger: HubLogger = {
  info: (message, details) => console.info(message, details ?? ''),
  warn: (message, details) => console.warn(message, details ?? ''),
}

export type HubFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface MaintenanceOptions {
  home: string
  config: HubConfig
  ledger?: LedgerMaintenance
  clock?: HubClock
  fetch?: HubFetch
  logger?: HubLogger
  /** 协调者在此把备份事实写为 hub.backup_done；账本备份本身不追加事件。 */
  onBackupDone?: (info: BackupInfo) => void
}

const pad = (n: number) => String(n).padStart(2, '0')
const dateStamp = (date: Date) =>
  `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
const backupName = (date: Date) =>
  `flow-${dateStamp(date)}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.db`
const BACKUP_NAME = /^flow-\d{8}-\d{6}\.db$/

/** 外部心跳和每日备份互相独立；stop 会取消定时器与进行中的 HTTP 请求。 */
export function startMaintenance(options: MaintenanceOptions): { stop(): Promise<void> } {
  const { config } = options
  const clock = options.clock ?? systemClock
  const logger = options.logger ?? consoleLogger
  const request = options.fetch ?? globalThis.fetch
  const backups = flowPaths(options.home).backups
  let stopped = false
  let cancelHeartbeat = () => {}
  let cancelBackup = () => {}
  let activeHeartbeat: AbortController | undefined
  const jobs = new Set<Promise<void>>()

  const run = (fn: () => Promise<void>) => {
    const job = fn().catch((err) => logger.warn('中枢维护失败', String(err)))
    jobs.add(job)
    void job.finally(() => jobs.delete(job))
    return job
  }

  const heartbeat = async () => {
    const controller = new AbortController()
    activeHeartbeat = controller
    const cancelTimeout = clock.setTimeout(() => controller.abort(), 10_000)
    try {
      const response = await request(config.heartbeat_url as string, {
        method: 'GET',
        signal: controller.signal,
      })
      // 不持有响应体和连接；非 2xx 同样记为失败。
      await response.body?.cancel()
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
    } catch (err) {
      if (!stopped) logger.warn('外部心跳失败', String(err))
    } finally {
      cancelTimeout()
      activeHeartbeat = undefined
    }
  }
  // 按固定间隔触发；间隔至少 10 秒，与请求超时相同，不重叠发送。
  const armHeartbeat = () => {
    cancelHeartbeat = clock.setTimeout(() => {
      if (stopped) return
      if (!activeHeartbeat) run(heartbeat)
      armHeartbeat()
    }, config.heartbeat_interval_s * 1000)
  }

  const scheduledAt = (date: Date) => {
    const [hour, minute] = config.backup_at.split(':').map(Number)
    const target = new Date(date)
    target.setHours(hour as number, minute as number, 0, 0)
    return target
  }
  const backup = async () => {
    const ledger = options.ledger
    if (!ledger || stopped) return
    const now = new Date(clock.now())
    await mkdir(backups, { recursive: true })
    const names = (await readdir(backups)).filter((name) => BACKUP_NAME.test(name)).sort()
    // 当天已有任意一份完整备份，就不再重复补做。
    const alreadyBackedUp = names.some((name) => name.startsWith(`flow-${dateStamp(now)}-`))
    const path = join(backups, backupName(now))
    if (!alreadyBackedUp) {
      ledger.backupTo(path)
      names.push(backupName(now))
    }
    names.sort()
    const removed = names.splice(0, Math.max(0, names.length - config.backup_keep))
    for (const name of removed) await unlink(join(backups, name))
    if (alreadyBackedUp) return
    const info: BackupInfo = {
      path: relative(options.home, path),
      at: now.toISOString(),
      kept: names.length,
    }
    logger.info('账本备份完成', info)
    options.onBackupDone?.(info)
  }
  const armBackup = () => {
    const now = new Date(clock.now())
    const next = scheduledAt(now)
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
    cancelBackup = clock.setTimeout(() => {
      if (stopped) return
      return run(async () => {
        try {
          await backup()
        } finally {
          if (!stopped) armBackup()
        }
      })
    }, next.getTime() - now.getTime())
  }

  if (config.heartbeat_url) armHeartbeat()
  if (options.ledger) {
    if (clock.now() >= scheduledAt(new Date(clock.now())).getTime()) run(backup)
    armBackup()
  }
  return {
    async stop() {
      stopped = true
      cancelHeartbeat()
      cancelBackup()
      activeHeartbeat?.abort()
      await Promise.all(jobs)
    },
  }
}
