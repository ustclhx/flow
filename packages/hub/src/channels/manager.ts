import {
  CHANNEL_ID_RE,
  CHANNEL_REF_MAX,
  DEFAULT_INBOX_CADENCE,
  fail,
  type InboxCadence,
  type InboxItemView,
  ok,
  redactSecrets,
} from '@flow/core'
import { planPushes } from '../inbox/cadence.ts'
import type { LedgerStore } from '../ledger/store.ts'
import type { HubClock } from '../server/clock.ts'
import type { HubLogger } from '../server/maintenance.ts'
import { renderMessage } from './render.ts'
import type {
  ChannelPlugin,
  ChannelSpec,
  ChannelStatus,
  InboundAction,
  InboundResult,
  InboxActFn,
} from './types.ts'

/**
 * 中枢内的渠道管理器（notify-channel 全部场景；add-m1-inbox 4.1）。
 *
 * - **隔离失败**：每个渠道各自串行处理，调用都包在 try/catch 与超时里。一个渠道抛错、超时或
 *   一直挂起，不影响其他渠道和中枢的其他功能；
 * - **退避重试**：连续失败按 1s、2s、4s… 指数退避，最长 5 分钟；期间记录警告，状态为 `backoff`；
 * - **补推**：未推送成功的条目不写任何事件，保持 pending；渠道恢复后，`flush` 按推送节奏
 *   （`planPushes`，只看投影与当前时间）把它们补推出去；
 * - **推送前确认条目仍 open**：发送前重新读取条目，已关闭或已推送到该渠道的不发；
 * - **已处理同步**：条目关闭后，对它所在的每条消息调用 `update`（合并消息整体重新渲染），
 *   成功后写 `inbox.pushed`（op=update）；未同步的会在下一次 flush 重试，重启后也能继续；
 * - **脱敏与截断**：消息由 `renderMessage` 生成，所有文字先经过名单 + 正则脱敏，终端片段截断到配置长度；
 * - **入站**：渠道把用户的操作交给 `onAction`，管理器按条目 id 或短 id 找到条目，调用 `act`
 *   （中枢里是 3.2 的 `actOnInbox`，以 user 身份执行），以渠道的 `via` 记录来源，然后刷新消息；
 * - **缺少密钥**：注册项的 `config` 中有未解析的 `secret://` 引用时，该渠道不启动（`disabled`），
 *   `flow hub status` 中报告缺少的路径；`refresh()` 在密钥变化后重试。
 */

export interface ChannelManagerOptions {
  ledger: LedgerStore
  clock: HubClock
  channels?: readonly ChannelSpec[]
  /** 当前的推送节奏（热加载时返回新值）。 */
  cadence?: () => InboxCadence
  /**
   * 收件箱操作：中枢里接的是 3.2 的 `actOnInbox`（以 user 身份，via 取渠道的 via），见 runHub。
   * 缺省时入站操作返回 `not_implemented`（只在单独使用管理器时出现）。
   */
  act?: InboxActFn
  /** 解析 `secret://` 引用（`HubSecrets.resolve`）；缺省不解析。 */
  resolve?: <T>(value: T) => { value: T; missing: string[] }
  /** 外发文字的脱敏，默认 core 的 `redactSecrets`（名单 + 正则）。 */
  redact?: (text: string) => string
  logger?: Pick<HubLogger, 'warn'>
  /** 退避的初始与最长间隔，默认 1 秒与 5 分钟。 */
  backoff?: { baseMs?: number; maxMs?: number }
  /** 单次渠道调用的超时，默认 30 秒。 */
  callTimeoutMs?: number
  /** 写推送事件的操作者，默认 `hub`。 */
  actor?: string
}

export interface ChannelManager {
  /** 启动全部渠道并做一次 flush。 */
  start(): Promise<void>
  /** 推送到期的条目、同步已关闭条目的消息（各渠道并行，同一渠道串行）。 */
  flush(): Promise<void>
  /** 密钥变化后重试未启动的渠道。 */
  refresh(): Promise<void>
  status(): ChannelStatus[]
  stop(): Promise<void>
}

interface Slot {
  id: string
  spec: ChannelSpec
  plugin: ChannelPlugin | null
  started: boolean
  missing: string[]
  failures: number
  retryAt: number | null
  cancelRetry: (() => void) | undefined
  lastError: string | null
  chain: Promise<void>
  /** 正在 flush 时又有新的请求：本轮结束后再来一轮。 */
  again: boolean
  busy: boolean
}

class Timeout extends Error {}

export function createChannelManager(o: ChannelManagerOptions): ChannelManager {
  const { ledger, clock } = o
  const actor = o.actor ?? 'hub'
  const redact = o.redact ?? redactSecrets
  const cadence = o.cadence ?? (() => ({ ...DEFAULT_INBOX_CADENCE }))
  const baseMs = o.backoff?.baseMs ?? 1000
  const maxMs = o.backoff?.maxMs ?? 5 * 60_000
  const timeoutMs = o.callTimeoutMs ?? 30_000
  const slots: Slot[] = []
  let stopped = false

  for (const spec of o.channels ?? []) {
    if (!CHANNEL_ID_RE.test(spec.id) || slots.some((s) => s.id === spec.id)) {
      o.logger?.warn('渠道 id 无效或重复，已跳过', { id: spec.id })
      continue
    }
    slots.push({
      id: spec.id,
      spec,
      plugin: null,
      started: false,
      missing: [],
      failures: 0,
      retryAt: null,
      cancelRetry: undefined,
      lastError: null,
      chain: Promise.resolve(),
      again: false,
      busy: false,
    })
  }

  /** 带超时的渠道调用：超时按失败处理（挂起的调用不会拖住其他渠道）。 */
  function call<T>(what: string, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const cancel = clock.setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Timeout(`${what} 超过 ${timeoutMs} 毫秒没有返回`))
      }, timeoutMs)
      let p: Promise<T>
      try {
        p = Promise.resolve(fn())
      } catch (err) {
        p = Promise.reject(err)
      }
      p.then(
        (v) => {
          if (settled) return
          settled = true
          cancel()
          resolve(v)
        },
        (err) => {
          if (settled) return
          settled = true
          cancel()
          reject(err)
        },
      )
    })
  }

  /** 创建插件：缺少密钥时不创建。 */
  function prepare(slot: Slot) {
    if (slot.plugin) return
    let config = slot.spec.config
    if (config !== undefined && o.resolve) {
      const r = o.resolve(config)
      slot.missing = r.missing
      if (r.missing.length > 0) return
      config = r.value
    }
    try {
      const plugin = slot.spec.create(config)
      if (plugin.id !== slot.id) throw new Error(`插件 id ${plugin.id} 与注册的 ${slot.id} 不一致`)
      slot.plugin = plugin
    } catch (err) {
      slot.lastError = redact(String(err))
      o.logger?.warn('渠道创建失败，不启动', { channel: slot.id, error: slot.lastError })
    }
  }

  function onFailure(slot: Slot, err: unknown) {
    slot.failures += 1
    const delay = Math.min(maxMs, baseMs * 2 ** Math.min(slot.failures - 1, 30))
    slot.retryAt = clock.now() + delay
    slot.lastError = redact(err instanceof Error ? err.message : String(err))
    o.logger?.warn('渠道调用失败，稍后重试', {
      channel: slot.id,
      failures: slot.failures,
      retry_in_ms: delay,
      error: slot.lastError,
    })
    slot.cancelRetry?.()
    slot.cancelRetry = clock.setTimeout(() => {
      slot.cancelRetry = undefined
      slot.retryAt = null
      // 不把 flush 的 Promise 交还给时钟：挂起的渠道调用不能拖住定时器（超时也靠定时器）。
      void flushSlot(slot)
    }, delay)
  }

  function record(
    slot: Slot,
    op: 'send' | 'update',
    kind: 'item' | 'batch',
    ref: string,
    itemIds: string[],
  ) {
    const r = ledger.append(
      { type: 'inbox.pushed', payload: { channel: slot.id, ref, op, kind, item_ids: itemIds } },
      { actor },
    )
    if (!r.ok) o.logger?.warn('推送记录写入失败', { channel: slot.id, op, error: r.error })
  }

  const renderOpts = () => ({ ledger, snippetMax: cadence().snippet_max_chars, redact })

  /** 条目关闭后，把它所在的消息改为已处理。 */
  async function syncClosed(slot: Slot, plugin: ChannelPlugin) {
    for (const { ref, item_ids } of ledger.pendingChannelUpdates(slot.id)) {
      if (stopped) return
      const all = ledger
        .channelMessageItems(slot.id, ref)
        .map((id) => ledger.getInboxItem(id))
        .filter((i): i is InboxItemView => i !== null)
      const kind = all[0]?.channels.find((c) => c.channel === slot.id && c.ref === ref)?.kind
      if (!kind || all.length === 0) continue
      await call(`${slot.id}.update`, () =>
        plugin.update(ref, renderMessage(kind, all, renderOpts())),
      )
      record(slot, 'update', kind, ref, item_ids)
    }
  }

  async function sendDue(slot: Slot, plugin: ChannelPlugin) {
    const open = ledger.listInboxItems({ state: 'open', limit: 10_000 })
    for (const plan of planPushes(open, slot.id, clock.now(), cadence())) {
      if (stopped) return
      // 推送前重新确认：条目仍是 open、还没推送到该渠道（例如处理期间被用户在终端答复）。
      const items = plan.items
        .map((i) => ledger.getInboxItem(i.id))
        .filter(
          (i): i is InboxItemView =>
            i !== null && i.state === 'open' && !i.channels.some((c) => c.channel === slot.id),
        )
      if (items.length === 0) continue
      const message = renderMessage(plan.kind, items, renderOpts())
      const ref = await call(`${slot.id}.send`, () => plugin.send(message))
      if (typeof ref !== 'string' || ref.length === 0 || ref.length > CHANNEL_REF_MAX) {
        throw new Error(`${slot.id}.send 返回的消息引用无效`)
      }
      record(
        slot,
        'send',
        plan.kind,
        ref,
        items.map((i) => i.id),
      )
    }
  }

  async function runSlot(slot: Slot) {
    if (stopped) return
    prepare(slot)
    const plugin = slot.plugin
    if (!plugin) return
    if (slot.retryAt !== null && slot.retryAt > clock.now()) return
    try {
      if (!slot.started) {
        await call(`${slot.id}.start`, () => plugin.start((req) => inbound(slot, plugin, req)))
        slot.started = true
      }
      await syncClosed(slot, plugin)
      await sendDue(slot, plugin)
      // 发送期间可能有条目关闭：再同步一次。
      await syncClosed(slot, plugin)
      if (slot.failures > 0) {
        o.logger?.warn('渠道已恢复', { channel: slot.id, failures: slot.failures })
      }
      slot.failures = 0
      slot.retryAt = null
      slot.lastError = null
    } catch (err) {
      if (!stopped) onFailure(slot, err)
    }
  }

  function flushSlot(slot: Slot): Promise<void> {
    if (slot.busy) {
      slot.again = true
      return slot.chain
    }
    slot.busy = true
    slot.chain = (async () => {
      try {
        do {
          slot.again = false
          await runSlot(slot)
        } while (slot.again && !stopped)
      } finally {
        slot.busy = false
      }
    })()
    return slot.chain
  }

  async function inbound(
    slot: Slot,
    plugin: ChannelPlugin,
    req: InboundAction,
  ): Promise<InboundResult> {
    if (stopped) return fail('retryable', 'hub_stopping', '中枢正在停止')
    try {
      const item =
        typeof req.item === 'string'
          ? (ledger.getInboxItem(req.item) ?? ledger.getInboxItemByShortId(req.item))
          : null
      if (!item) return fail('failure', 'not_found', `收件箱条目 ${String(req.item)} 不存在`)
      if (!o.act) {
        return fail('failure', 'not_implemented', '收件箱操作尚未接入（add-m1-inbox 3.2）')
      }
      const r = await o.act(item.id, req.action, req.text, plugin.via)
      // 操作可能关闭了条目：尽快把各渠道的消息改为已处理。
      void flush()
      return r.ok ? ok({ item_id: item.id }) : r
    } catch (err) {
      o.logger?.warn('渠道入站操作失败', { channel: slot.id, error: redact(String(err)) })
      return fail('failure', 'act_failed', '操作失败，请稍后再试')
    }
  }

  async function flush() {
    if (stopped) return
    await Promise.all(slots.map((s) => flushSlot(s)))
  }

  return {
    async start() {
      await flush()
    },
    flush,
    async refresh() {
      for (const slot of slots) if (!slot.plugin) slot.lastError = null
      await flush()
    },
    status() {
      return slots.map((s) => ({
        id: s.id,
        state: stopped
          ? 'stopped'
          : !s.plugin
            ? 'disabled'
            : s.retryAt !== null
              ? 'backoff'
              : 'running',
        missing_secrets: [...s.missing],
        failures: s.failures,
        next_retry_at: s.retryAt === null ? null : new Date(s.retryAt).toISOString(),
        last_error: s.lastError,
      }))
    },
    async stop() {
      if (stopped) return
      stopped = true
      for (const slot of slots) {
        slot.cancelRetry?.()
        slot.cancelRetry = undefined
      }
      await Promise.all(
        slots.map(async (slot) => {
          if (!slot.plugin || !slot.started) return
          try {
            await call(`${slot.id}.stop`, () => (slot.plugin as ChannelPlugin).stop())
          } catch (err) {
            o.logger?.warn('渠道停止失败', { channel: slot.id, error: redact(String(err)) })
          }
        }),
      )
    },
  }
}
