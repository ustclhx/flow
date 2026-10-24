import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InboxItemAction, InboxLevel, InboxVia } from '@flow/core'
import type {
  ChannelCallOptions,
  ChannelMessage,
  ChannelPlugin,
  ChannelSpec,
  InboundHandler,
  LedgerStore,
} from '../src/index.ts'
import { createScheduler, openLedger, startInbox } from '../src/index.ts'
import { must } from './ledger-helpers.ts'
import { FakeClock } from './server-fixtures.ts'

/**
 * 内存中的假渠道（notify-channel 场景测试用）：记录发送与更新的消息，可以模拟失败与挂起。
 */
export class MemoryChannel implements ChannelPlugin {
  readonly via: InboxVia
  sent: { ref: string; message: ChannelMessage }[] = []
  updates: { ref: string; message: ChannelMessage }[] = []
  /** 为 true 时 send / update 抛错（模拟 API 连续失败）。 */
  down = false
  /** 为 true 时 send 一直不返回，直到超时被 abort。 */
  hang = false
  /**
   * 为 true 时 send 挂起，直到测试调用 `releaseSends()`；不理会 abort（模拟插件没能中止请求，
   * 原请求最终仍然成功）。
   */
  slow = false
  slowSends: { message: ChannelMessage; resolve: () => void }[] = []
  /** 收到 abort 的调用数。 */
  aborted = 0
  /** 为 true 时 send 返回空的消息引用。 */
  badRef = false
  /** 按消息决定抛出的错误（例如某个条目一直 ChannelError('message')）。 */
  failWith: ((op: 'send' | 'update', message: ChannelMessage) => Error | undefined) | undefined
  /** start 失败的剩余次数。 */
  startFailures = 0
  sendCalls = 0
  updateCalls = 0
  started = 0
  stopped = 0
  handler: InboundHandler | undefined
  private n = 0

  constructor(
    readonly id = 'memory',
    via: InboxVia = 'telegram',
  ) {
    this.via = via
  }

  async send(message: ChannelMessage, options: ChannelCallOptions): Promise<string> {
    this.sendCalls += 1
    options.signal.addEventListener('abort', () => {
      this.aborted += 1
    })
    // 挂起，直到被 abort（遵守 signal 的插件）
    if (this.hang) {
      return new Promise<string>((_, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('已中止')))
      })
    }
    if (this.down) throw new Error('渠道 API 请求失败（模拟）')
    const err = this.failWith?.('send', message)
    if (err) throw err
    if (this.slow) await new Promise<void>((resolve) => this.slowSends.push({ message, resolve }))
    if (this.badRef) return ''
    const ref = `${this.id}-${++this.n}`
    this.sent.push({ ref, message })
    return ref
  }

  /** 放行挂起的 send（它们随即"成功"）。 */
  releaseSends() {
    for (const s of this.slowSends.splice(0)) s.resolve()
  }

  async update(ref: string, message: ChannelMessage, _options: ChannelCallOptions): Promise<void> {
    this.updateCalls += 1
    if (this.down) throw new Error('渠道 API 请求失败（模拟）')
    const err = this.failWith?.('update', message)
    if (err) throw err
    this.updates.push({ ref, message })
  }

  async start(onAction: InboundHandler): Promise<void> {
    if (this.startFailures > 0) {
      this.startFailures -= 1
      throw new Error('启动失败（模拟）')
    }
    this.started += 1
    this.handler = onAction
  }

  async stop(): Promise<void> {
    this.stopped += 1
  }

  /** 消息里的条目 id。 */
  static ids(message: ChannelMessage): string[] {
    return message.kind === 'item' ? [message.item.id] : message.items.map((i) => i.id)
  }

  /** 发出的消息里的条目 id（按发送先后，合并消息展开）。 */
  sentIds(): string[][] {
    return this.sent.map(({ message }) =>
      message.kind === 'item' ? [message.item.id] : message.items.map((i) => i.id),
    )
  }
}

export const specOf = (channel: MemoryChannel, config?: unknown): ChannelSpec => ({
  id: channel.id,
  ...(config === undefined ? {} : { config }),
  create: () => channel,
})

/** 直接写一个收件箱条目（不经反应器）。 */
export function createItem(
  ledger: LedgerStore,
  id: string,
  level: InboxLevel,
  o: { source?: 'task' | 'proposal' | 'policy' | 'supervisor'; actions?: InboxItemAction[] } = {},
) {
  return must(
    ledger.append(
      {
        type: 'inbox.item_created',
        payload: {
          item_id: id,
          level,
          source: o.source ?? 'supervisor',
          source_ref: id,
          title: `条目 ${id}`,
          body: '需要你看一下',
          actions: o.actions ?? ['reply'],
        },
      },
      { actor: 'hub' },
    ),
  )
}

export function closeItem(
  ledger: LedgerStore,
  id: string,
  o: { via?: InboxVia; cause_actor?: string; actor?: string } = {},
) {
  return must(
    ledger.append(
      {
        type: 'inbox.item_closed',
        payload: {
          item_id: id,
          reason: 'answered',
          ...(o.via ? { via: o.via } : {}),
          ...(o.cause_actor ? { cause_actor: o.cause_actor } : {}),
        },
      },
      { actor: o.actor ?? 'hub' },
    ),
  )
}

const quietLogger = () => {
  const warns: { message: string; details: unknown }[] = []
  return {
    warns,
    logger: {
      info() {},
      warn(message: string, details?: unknown) {
        warns.push({ message, details })
      },
    },
  }
}

/**
 * 收件箱全套（反应器 + 推送节奏 + 渠道管理器 + 真实调度器），用注入的时钟；
 * 账本事件时间戳也取自同一个时钟。
 */
export async function inboxRig(
  o: {
    start?: number
    channels?: ChannelSpec[]
    act?: Parameters<typeof startInbox>[0]['act']
    resolve?: Parameters<typeof startInbox>[0]['resolve']
    backoff?: { baseMs?: number; maxMs?: number }
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'flow-inbox-push-'))
  const home = join(dir, 'home')
  const clock = new FakeClock(o.start ?? new Date(2026, 9, 26, 10, 0).getTime())
  const ledger = await openLedger(join(dir, 'flow.db'), { now: clock.now })
  const { warns, logger } = quietLogger()
  const scheduler = await createScheduler({ ledger, clock, home, logger })
  const inbox = await startInbox({
    ledger,
    home,
    clock,
    logger,
    watch: false,
    scheduler,
    ...(o.channels ? { channels: o.channels } : {}),
    ...(o.act ? { act: o.act } : {}),
    ...(o.resolve ? { resolve: o.resolve } : {}),
    ...(o.backoff ? { backoff: o.backoff } : {}),
  })
  /** 让微任务里的推送跑完。 */
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await inbox.idle()
      await clock.advance(0)
    }
  }
  return {
    dir,
    home,
    clock,
    ledger,
    scheduler,
    inbox,
    warns,
    settle,
    async cleanup() {
      await inbox.stop()
      scheduler.stop()
      ledger.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** 本地时间（测试与系统时区无关：节奏按系统本地时区计算）。 */
export const local = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m).getTime()
