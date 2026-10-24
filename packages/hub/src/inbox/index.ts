import { type FSWatcher, watch } from 'node:fs'
import { join } from 'node:path'
import { EMPTY_INBOX_CONFIG, flowPaths, type InboxConfig, loadInboxConfig } from '@flow/core'
import type { LedgerStore } from '../ledger/store.ts'
import type { HubClock } from '../server/clock.ts'
import type { HubLogger } from '../server/maintenance.ts'
import { createProposalWatcher, type ProposalWatcher } from './proposals.ts'
import { createInboxReactor, type InboxReactor } from './reactor.ts'

export * from './proposals.ts'
export * from './reactor.ts'

/**
 * 中枢内的收件箱组件（add-m1-inbox 3.1）：分级配置（含热加载）、反应器、提案目录监听。
 * 推送节奏（3.3）与渠道（4.1）之后挂在这里。
 */

export interface InboxServiceOptions {
  ledger: LedgerStore
  home: string
  clock: HubClock
  logger?: Pick<HubLogger, 'warn'>
  /** 是否监听 config/inbox.yaml 与提案目录，默认 true。 */
  watch?: boolean
  /** 提案定时扫描间隔，默认 60 秒。 */
  proposalIntervalMs?: number
  debounceMs?: number
}

export interface InboxService {
  reactor: InboxReactor
  proposals: ProposalWatcher
  /** 当前生效的分级配置。 */
  config(): InboxConfig
  /** 重新读取 config/inbox.yaml；文件级错误时保留上一次的配置。 */
  reloadConfig(): Promise<void>
  /** 等反应器的队列处理完。 */
  idle(): Promise<void>
  stop(): void
}

export async function startInbox(o: InboxServiceOptions): Promise<InboxService> {
  let current: InboxConfig = EMPTY_INBOX_CONFIG
  const reloadConfig = async () => {
    const loaded = await loadInboxConfig(o.home)
    if (!loaded.ok) {
      o.logger?.warn('config/inbox.yaml 无法加载，沿用上一次的分级配置', loaded.error)
      return
    }
    current = loaded.data
    for (const issue of current.errors) o.logger?.warn('config/inbox.yaml 规则有误，已跳过', issue)
  }
  await reloadConfig()

  const config = () => current
  const reactor = createInboxReactor({
    ledger: o.ledger,
    config,
    cursorPath: join(flowPaths(o.home).state, 'inbox-reactor.json'),
    ...(o.logger ? { logger: o.logger } : {}),
  })
  const proposals = createProposalWatcher({
    ledger: o.ledger,
    home: o.home,
    clock: o.clock,
    config,
    ...(o.logger ? { logger: o.logger } : {}),
    ...(o.proposalIntervalMs !== undefined ? { intervalMs: o.proposalIntervalMs } : {}),
    ...(o.debounceMs !== undefined ? { debounceMs: o.debounceMs } : {}),
  })

  reactor.start()
  let watcher: FSWatcher | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  if (o.watch !== false) {
    await proposals.start()
    try {
      watcher = watch(flowPaths(o.home).config, (_event, name) => {
        if (name && String(name) !== 'inbox.yaml') return
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = undefined
          void reloadConfig()
        }, o.debounceMs ?? 300)
      })
      watcher.on('error', (err) => o.logger?.warn('监听 config/inbox.yaml 失败', String(err)))
    } catch (err) {
      o.logger?.warn('无法监听 config/inbox.yaml', String(err))
    }
  } else {
    await proposals.scan()
  }

  return {
    reactor,
    proposals,
    config,
    reloadConfig,
    idle: () => reactor.idle(),
    stop() {
      if (timer) clearTimeout(timer)
      watcher?.close()
      proposals.stop()
      reactor.stop()
    },
  }
}
