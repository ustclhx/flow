import {
  CHANNEL_ID_RE,
  CHANNEL_REF_MAX,
  clipText,
  DEFAULT_INBOX_CADENCE,
  fail,
  INBOX_PUSH_REASON_MAX,
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
import {
  type ChannelHealth,
  type ChannelPlugin,
  type ChannelSpec,
  type ChannelStatus,
  channelErrorKind,
  type InboundAction,
  type InboundResult,
  type InboxActFn,
} from './types.ts'

/**
 * 中枢内的渠道管理器（notify-channel 全部场景；add-m1-inbox 4.1）。
 *
 * - **隔离失败**：每个渠道各自串行处理，调用都包在 try/catch 与超时里。一个渠道抛错、超时或
 *   一直挂起，不影响其他渠道和中枢的其他功能；
 * - **退避重试**：传输层错误（网络、超时、限流，以及未分类的错误）按 1s、2s、4s… 指数退避，
 *   最长 5 分钟；期间记录警告，状态为 `backoff`；
 * - **单条消息的失败不卡住渠道**：插件抛 `ChannelError('message')` 时只记在这一条上，跳过它继续处理
 *   后面的，同一条连续 5 次后放弃；`ChannelError('permanent')` 立即放弃；同一条超时 3 次也放弃。
 *   放弃写 `inbox.pushed`（op=failed），投影视为已处理，条目视图与 `flow hub status` 中标出"推送失败"；
 * - **超时不重复推送**：超时后 abort 插件收到的 signal；原调用仍在进行时不重复发起同一条，
 *   它最终成功了照常记录。渠道返回无效的消息引用时按已发出记录（占位引用）并告警，不重发；
 * - **补推**：未推送成功的条目不写任何事件，保持 pending；渠道恢复后，`flush` 按推送节奏
 *   （`planPushes`，只看投影与当前时间）把它们补推出去；
 * - **推送前确认条目仍 open**：发送前重新读取条目，已关闭或已推送到该渠道的不发；
 * - **已处理同步**：先推新条目，再同步已关闭的条目（两步各自捕获错误）。条目关闭后，对它所在的
 *   每条消息调用 `update`（合并消息整体重新渲染），成功后写 `inbox.pushed`（op=update）；
 *   未同步的会在下一次 flush 重试，重启后也能继续；
 * - **脱敏与截断**：消息由 `renderMessage` 生成，所有文字先经过名单 + 正则脱敏，终端片段截断到配置长度；
 * - **入站**：渠道把用户的操作交给 `onAction`，管理器按条目 id 或短 id 找到条目，调用 `act`
 *   （中枢里是 3.2 的 `actOnInbox`，以 user 身份执行），以渠道的 `via` 记录来源，然后刷新消息；
 * - **缺少密钥**：注册项的 `config` 中有未解析的 `secret://` 引用时，该渠道不启动（`disabled`），
 *   `flow hub status` 中报告缺少的路径；`refresh()` 在密钥变化后重试。
 *
 * 消息级失败与超时的计数只在内存中：中枢重启后从零开始。
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
  /**
   * 暂缓推送的条目（D15：委托给 supervisor 处理中、或正在判定是否委托的卡住条目）：不推送，
   * 也不计入 Decide 的提前推送阈值；不再被挡住后按自身级别适用推送节奏。
   */
  held?: (item: InboxItemView) => boolean
}

export interface ChannelManager {
  /** 启动全部渠道并做一次 flush。 */
  start(): Promise<void>
  /** 推送到期的条目、同步已关闭条目的消息（各渠道并行，同一渠道串行）。 */
  flush(): Promise<void>
  /** 密钥变化后重试未启动的渠道（含插件自己报告停用的，例如 token 无效）。 */
  refresh(): Promise<void>
  /** 立即重试某个渠道：取消退避等待并 flush（例如 Telegram 刚完成绑定）。 */
  wake(id: string): Promise<void>
  status(): ChannelStatus[]
  stop(): Promise<void>
}

/** 消息级失败连续这么多次后放弃这一条（op=failed）。 */
export const MESSAGE_FAILURE_LIMIT = 5
/** 同一条消息超时这么多次后放弃这一条。 */
export const TIMEOUT_LIMIT = 3
/** 渠道返回了无效消息引用时记录用的占位前缀：之后不再对它调用 update。 */
export const PLACEHOLDER_REF_PREFIX = '!invalid-ref:'

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
  /** 超时后仍在进行的调用（`send:<条目 id>`、`update:<ref>`）：结束之前不再重复发起。 */
  inflight: Set<string>
  /** 同一条消息连续的消息级失败次数（键同上）。 */
  messageFailures: Map<string, number>
  /** 同一条消息的超时次数（键同上）。 */
  timeouts: Map<string, number>
}

/** 调用超时；`pending` 是仍在进行的原调用（已 abort，插件可能仍会完成）。 */
class Timeout extends Error {
  constructor(
    message: string,
    readonly pending: Promise<unknown>,
  ) {
    super(message)
  }
}

/** 一次调用失败后，针对这条消息的处理。 */
interface CallTarget {
  /** 计数与在途标记的键。 */
  keys: string[]
  /** 放弃这条消息（写 op=failed）。 */
  giveUp: (reason: string) => void
  /** 超时的原调用最终成功时的记录。 */
  settle: (value: unknown) => void
}

const sendKey = (id: string) => `send:${id}`
const updateKey = (ref: string) => `update:${ref}`

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
  let placeholders = 0

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
      inflight: new Set(),
      messageFailures: new Map(),
      timeouts: new Map(),
    })
  }

  const errorText = (err: unknown) =>
    clipText(redact(err instanceof Error ? err.message : String(err)), INBOX_PUSH_REASON_MAX)

  /**
   * 带超时的渠道调用：超时后 abort 传给插件的 signal，并以 `Timeout` 拒绝（带上仍在进行的原调用），
   * 挂起的调用不会拖住其他渠道。
   */
  function call<T>(what: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    let p: Promise<T>
    try {
      p = Promise.resolve(fn(controller.signal))
    } catch (err) {
      p = Promise.reject(err)
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const cancel = clock.setTimeout(() => {
        if (settled) return
        settled = true
        const err = new Timeout(`${what} 超过 ${timeoutMs} 毫秒没有返回`, p)
        controller.abort(err)
        reject(err)
      }, timeoutMs)
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
      slot.lastError = errorText(err)
      o.logger?.warn('渠道创建失败，不启动', { channel: slot.id, error: slot.lastError })
    }
  }

  /** 插件自己报告的停用原因（例如 token 无效）；没有或读取失败时为 null。 */
  function selfDisabled(slot: Slot): string | null {
    try {
      return slot.plugin?.health?.().disabled ?? null
    } catch {
      return null
    }
  }

  function healthOf(slot: Slot): ChannelHealth | null {
    try {
      return slot.plugin?.health?.() ?? null
    } catch {
      return null
    }
  }

  /** 最近一次改绑的时间（`channel.rebound`，按渠道）。 */
  function lastRebound(id: string): string | null {
    let before: number | undefined
    for (let i = 0; i < 50; i++) {
      const e = ledger.latestEvent(before, 'channel.rebound')
      if (!e) return null
      if (e.type === 'channel.rebound' && e.payload.channel === id) return e.ts
      before = e.seq
    }
    return null
  }

  function onFailure(slot: Slot, err: unknown) {
    slot.failures += 1
    const delay = Math.min(maxMs, baseMs * 2 ** Math.min(slot.failures - 1, 30))
    slot.retryAt = clock.now() + delay
    slot.lastError = errorText(err)
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

  type PushedPayload =
    | { op: 'send' | 'update'; kind: 'item' | 'batch'; ref: string; item_ids: string[] }
    | { op: 'failed'; kind: 'item' | 'batch'; ref?: string; item_ids: string[]; reason: string }

  function append(slot: Slot, payload: PushedPayload) {
    const r = ledger.append(
      { type: 'inbox.pushed', payload: { channel: slot.id, ...payload } },
      { actor },
    )
    if (!r.ok) {
      o.logger?.warn('推送记录写入失败', { channel: slot.id, op: payload.op, error: r.error })
    }
  }

  /** 消息已发出：记录；渠道返回的引用无效时用占位引用记录（视为已发出，不重发）。 */
  function recordSent(slot: Slot, kind: 'item' | 'batch', itemIds: string[], ref: unknown) {
    let r = ref
    if (typeof r !== 'string' || r.length === 0 || r.length > CHANNEL_REF_MAX) {
      placeholders += 1
      r = `${PLACEHOLDER_REF_PREFIX}${clock.now()}-${placeholders}`
      o.logger?.warn('渠道返回的消息引用无效，按已发出记录，不再重发', {
        channel: slot.id,
        items: itemIds,
      })
    }
    for (const id of itemIds) {
      slot.messageFailures.delete(sendKey(id))
      slot.timeouts.delete(sendKey(id))
    }
    append(slot, { op: 'send', kind, ref: r as string, item_ids: itemIds })
  }

  /** 放弃一条消息：写 op=failed，投影把它视为已处理。 */
  function recordFailed(
    slot: Slot,
    kind: 'item' | 'batch',
    itemIds: string[],
    reason: string,
    ref?: string,
  ) {
    o.logger?.warn('放弃推送', { channel: slot.id, ref, items: itemIds, reason })
    append(slot, {
      op: 'failed',
      kind,
      item_ids: itemIds,
      reason: clipText(reason, INBOX_PUSH_REASON_MAX),
      ...(ref === undefined ? {} : { ref }),
    })
  }

  /**
   * 处理一次调用失败。返回 true 表示传输层错误（含超时），整个渠道退避，调用方应停止本轮；
   * 消息级失败与永久错误只记在这条消息上，返回 false，继续处理后面的。
   */
  function onCallError(slot: Slot, err: unknown, target: CallTarget): boolean {
    if (err instanceof Timeout) {
      for (const key of target.keys) slot.inflight.add(key)
      err.pending.then(
        (v) => {
          for (const key of target.keys) slot.inflight.delete(key)
          // 超时的调用最终成功：照常记录（消息确实发出了）。
          if (stopped) return
          target.settle(v)
          void flushSlot(slot)
        },
        () => {
          for (const key of target.keys) slot.inflight.delete(key)
        },
      )
      const count = Math.max(...target.keys.map((k) => (slot.timeouts.get(k) ?? 0) + 1))
      for (const key of target.keys) slot.timeouts.set(key, count)
      if (count >= TIMEOUT_LIMIT) {
        for (const key of target.keys) slot.timeouts.delete(key)
        target.giveUp(`连续 ${count} 次超时：${errorText(err)}`)
      }
      return true
    }
    const kind = channelErrorKind(err)
    if (kind === 'transport') return true
    const reason = errorText(err)
    if (kind === 'permanent') {
      for (const key of target.keys) slot.messageFailures.delete(key)
      target.giveUp(reason)
      return false
    }
    const count = Math.max(...target.keys.map((k) => (slot.messageFailures.get(k) ?? 0) + 1))
    for (const key of target.keys) slot.messageFailures.set(key, count)
    o.logger?.warn('消息推送失败，跳过这一条', { channel: slot.id, count, error: reason })
    if (count >= MESSAGE_FAILURE_LIMIT) {
      for (const key of target.keys) slot.messageFailures.delete(key)
      target.giveUp(`连续 ${count} 次失败：${reason}`)
    }
    return false
  }

  const renderOpts = () => ({
    ledger,
    snippetMax: cadence().snippet_max_chars,
    redact,
  })

  /** 推送到期的条目。遇到传输层错误时抛出（由 runSlot 退避）。 */
  async function sendDue(slot: Slot, plugin: ChannelPlugin) {
    const held = o.held
    const open = ledger.listInboxItems({ state: 'open', limit: 10_000 }).filter((i) => !held?.(i))
    for (const plan of planPushes(open, slot.id, clock.now(), cadence())) {
      if (stopped) return
      // 推送前重新确认：条目仍是 open、还没推送到该渠道（例如处理期间被用户在终端答复），
      // 也不在超时后仍在进行的发送里。
      const items = plan.items
        .map((i) => ledger.getInboxItem(i.id))
        .filter(
          (i): i is InboxItemView =>
            i !== null &&
            i.state === 'open' &&
            !held?.(i) &&
            !i.channels.some((c) => c.channel === slot.id) &&
            !slot.inflight.has(sendKey(i.id)),
        )
      if (items.length === 0) continue
      const ids = items.map((i) => i.id)
      const message = renderMessage(plan.kind, items, renderOpts())
      try {
        const ref = await call(`${slot.id}.send`, (signal) => plugin.send(message, { signal }))
        recordSent(slot, plan.kind, ids, ref)
      } catch (err) {
        const transport = onCallError(slot, err, {
          keys: ids.map(sendKey),
          giveUp: (reason) => recordFailed(slot, plan.kind, ids, reason),
          settle: (ref) => recordSent(slot, plan.kind, ids, ref),
        })
        if (transport) throw err
      }
    }
  }

  /** 条目关闭后，把它所在的消息改为已处理。遇到传输层错误时抛出（由 runSlot 退避）。 */
  async function syncClosed(slot: Slot, plugin: ChannelPlugin) {
    for (const { ref, item_ids } of ledger.pendingChannelUpdates(slot.id)) {
      if (stopped) return
      if (slot.inflight.has(updateKey(ref))) continue
      const all = ledger
        .channelMessageItems(slot.id, ref)
        .map((id) => ledger.getInboxItem(id))
        .filter((i): i is InboxItemView => i !== null)
      const kind = all[0]?.channels.find((c) => c.channel === slot.id && c.ref === ref)?.kind
      if (!kind || all.length === 0) continue
      if (ref.startsWith(PLACEHOLDER_REF_PREFIX)) {
        recordFailed(slot, kind, item_ids, '消息引用无效，无法改为已处理', ref)
        continue
      }
      const done = () => append(slot, { op: 'update', kind, ref, item_ids })
      try {
        await call(`${slot.id}.update`, (signal) =>
          plugin.update(ref, renderMessage(kind, all, renderOpts()), { signal }),
        )
        slot.messageFailures.delete(updateKey(ref))
        slot.timeouts.delete(updateKey(ref))
        done()
      } catch (err) {
        const transport = onCallError(slot, err, {
          keys: [updateKey(ref)],
          giveUp: (reason) => recordFailed(slot, kind, item_ids, reason, ref),
          settle: done,
        })
        if (transport) throw err
      }
    }
  }

  async function runSlot(slot: Slot) {
    if (stopped) return
    prepare(slot)
    const plugin = slot.plugin
    if (!plugin) return
    // 插件报告停用（例如 token 无效）：不再调用，等 refresh() 重新创建。
    if (selfDisabled(slot) !== null) return
    if (slot.retryAt !== null && slot.retryAt > clock.now()) return
    if (!slot.started) {
      try {
        await call(`${slot.id}.start`, () => plugin.start((req) => inbound(slot, plugin, req)))
        slot.started = true
      } catch (err) {
        if (!stopped) onFailure(slot, err)
        return
      }
    }
    // 启动过程中发现无法使用（例如 token 无效）：不再推送。
    if (selfDisabled(slot) !== null) return
    // 先推新条目，再同步已关闭的条目；两步各自捕获错误，一步失败不妨碍另一步。
    let transport: unknown
    try {
      await sendDue(slot, plugin)
    } catch (err) {
      transport = err
    }
    try {
      await syncClosed(slot, plugin)
    } catch (err) {
      transport ??= err
    }
    if (stopped) return
    if (transport !== undefined) {
      if (selfDisabled(slot) !== null) return
      onFailure(slot, transport)
      return
    }
    if (slot.failures > 0) {
      o.logger?.warn('渠道已恢复', { channel: slot.id, failures: slot.failures })
    }
    slot.failures = 0
    slot.retryAt = null
    slot.lastError = null
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
      o.logger?.warn('渠道入站操作失败', { channel: slot.id, error: errorText(err) })
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
      for (const slot of slots) {
        const plugin = slot.plugin
        if (plugin && selfDisabled(slot) !== null) {
          // 插件自己停用了（例如 token 无效）：停掉旧实例，按新的密钥重新创建。
          slot.plugin = null
          if (slot.started) {
            slot.started = false
            try {
              await call(`${slot.id}.stop`, () => plugin.stop())
            } catch (err) {
              o.logger?.warn('渠道停止失败', { channel: slot.id, error: errorText(err) })
            }
          }
        }
        if (!slot.plugin) slot.lastError = null
      }
      await flush()
    },
    async wake(id) {
      const slot = slots.find((s) => s.id === id)
      if (!slot || stopped) return
      slot.cancelRetry?.()
      slot.cancelRetry = undefined
      slot.retryAt = null
      await flushSlot(slot)
    },
    status() {
      return slots.map((s) => {
        const disabled = selfDisabled(s)
        const health = healthOf(s)
        return {
          id: s.id,
          state: stopped
            ? 'stopped'
            : !s.plugin || disabled !== null
              ? 'disabled'
              : s.retryAt !== null
                ? 'backoff'
                : 'running',
          missing_secrets: [...s.missing],
          failures: s.failures,
          next_retry_at:
            disabled !== null
              ? (health?.retry_at ?? null)
              : s.retryAt === null
                ? null
                : new Date(s.retryAt).toISOString(),
          last_error: disabled ?? s.lastError,
          failed_items: ledger.channelFailedCount(s.id),
          ignored_inbound: health?.ignored ?? 0,
          warning: health?.warning ?? null,
          last_rebound_at: lastRebound(s.id),
        }
      })
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
          const plugin = slot.plugin
          if (!plugin || !slot.started) return
          try {
            await call(`${slot.id}.stop`, () => plugin.stop())
          } catch (err) {
            o.logger?.warn('渠道停止失败', { channel: slot.id, error: errorText(err) })
          }
        }),
      )
    },
  }
}
