import { type FSWatcher, watch } from 'node:fs'
import { join } from 'node:path'
import {
  EMPTY_INBOX_CONFIG,
  flowPaths,
  type InboxConfig,
  type InboxItemView,
  inboxCadence,
  loadInboxConfig,
} from '@flow/core'
import { type ChannelManager, createChannelManager } from '../channels/manager.ts'
import type { ChannelSpec, InboxActFn } from '../channels/types.ts'
import type { LedgerStore } from '../ledger/store.ts'
import type { Scheduler } from '../scheduler/index.ts'
import type { HubClock } from '../server/clock.ts'
import type { HubLogger } from '../server/maintenance.ts'
import { createProposalWatcher, type ProposalWatcher } from './proposals.ts'
import { createInboxPusher, type InboxPusher } from './pusher.ts'
import { createInboxReactor, type InboxReactor } from './reactor.ts'

export * from './actions.ts'
export * from './cadence.ts'
export * from './proposals.ts'
export * from './pusher.ts'
export * from './reactor.ts'
export * from './routes.ts'

/**
 * 中枢内的收件箱组件：分级与节奏配置（含热加载）、反应器、提案目录监听（3.1），
 * 推送节奏（3.3）与渠道管理器（4.1）。
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
  /** 内部定时规则（Decide 时间点、静默结束、每日摘要）挂在调度器上。 */
  scheduler?: Pick<Scheduler, 'setInternalRules'>
  /** 推送渠道（Telegram 等由 5.x 注册）。 */
  channels?: readonly ChannelSpec[]
  /** 渠道入站操作调用的收件箱操作（3.2 的 inbox_act）。 */
  act?: InboxActFn
  /** 解析渠道配置中的 `secret://` 引用。 */
  resolve?: <T>(value: T) => { value: T; missing: string[] }
  /** 渠道退避参数（测试用）。 */
  backoff?: { baseMs?: number; maxMs?: number }
  staleKnowledge?: () => number | Promise<number>
  /** 暂缓推送的条目（D15 代回复委托中），见 `ChannelManagerOptions.held`。 */
  held?: (item: InboxItemView) => boolean
}

export interface InboxService {
  reactor: InboxReactor
  proposals: ProposalWatcher
  pusher: InboxPusher
  channels: ChannelManager
  /** 当前生效的分级配置。 */
  config(): InboxConfig
  /** 重新读取 config/inbox.yaml；文件级错误时保留上一次的配置。 */
  reloadConfig(): Promise<void>
  /** 等反应器的队列处理完。 */
  idle(): Promise<void>
  stop(): Promise<void>
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
    pusher?.reconfigure()
  }
  let pusher: InboxPusher | undefined
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

  const channels = createChannelManager({
    ledger: o.ledger,
    clock: o.clock,
    cadence: () => inboxCadence(current),
    ...(o.channels ? { channels: o.channels } : {}),
    ...(o.act ? { act: o.act } : {}),
    ...(o.resolve ? { resolve: o.resolve } : {}),
    ...(o.backoff ? { backoff: o.backoff } : {}),
    ...(o.logger ? { logger: o.logger } : {}),
    ...(o.held ? { held: o.held } : {}),
  })
  pusher = createInboxPusher({
    ledger: o.ledger,
    clock: o.clock,
    config,
    flush: () => channels.flush(),
    ...(o.scheduler ? { scheduler: o.scheduler } : {}),
    ...(o.staleKnowledge ? { staleKnowledge: o.staleKnowledge } : {}),
    ...(o.logger ? { logger: o.logger } : {}),
  })
  const activePusher = pusher

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

  // 反应器补处理完停机期间的事件之后再推送，避免推送随即被关闭的条目。
  await reactor.idle()
  await activePusher.start()

  return {
    reactor,
    proposals,
    pusher: activePusher,
    channels,
    config,
    reloadConfig,
    idle: () => reactor.idle(),
    async stop() {
      if (timer) clearTimeout(timer)
      watcher?.close()
      activePusher.stop()
      proposals.stop()
      reactor.stop()
      await channels.stop()
    },
  }
}
