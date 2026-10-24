import { existsSync, type FSWatcher, mkdirSync, watch } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  clipText,
  flowPaths,
  INBOX_BODY_MAX,
  INBOX_TITLE_MAX,
  type InboxCloseReason,
  type InboxConfig,
  type Proposal,
  proposalSchema,
  resolveInboxLevel,
} from '@flow/core'
import type { LedgerStore } from '../ledger/store.ts'
import type { HubClock } from '../server/clock.ts'
import type { HubLogger } from '../server/maintenance.ts'

/**
 * 提案目录监听（add-m1-inbox design D1："文件监听 + 每分钟扫描"）。
 *
 * 提案不在账本中，是 `state/proposals/<id>.json`；接受或拒绝后移入 `accepted/`、`rejected/`。
 * 每次扫描：
 * - 待处理、还没有条目的提案 → `inbox.item_created`（`prop.<id>`，默认 Decide，操作 accept / reject）；
 * - 未关闭的提案条目，其提案已不在待处理目录 → `inbox.item_closed`，按归档位置注明
 *   proposal_accepted / proposal_rejected，都找不到时为 proposal_removed。
 * 条目 id 固定为 `prop.<id>`：已关闭（例如被用户忽略）的提案不会因为再次扫描而重新打开。
 * 扫描不取写锁，只读目录。读取或解析失败的提案文件保持现状（不开也不关条目），告警一次；
 * 只有确认文件已不在待处理目录（在 accepted/、rejected/ 中或已不存在）才关闭条目。
 */

export interface ProposalWatcherOptions {
  ledger: LedgerStore
  home: string
  clock: HubClock
  config?: () => Pick<InboxConfig, 'levels'>
  logger?: Pick<HubLogger, 'warn'>
  /** 定时扫描间隔，默认 60 秒。 */
  intervalMs?: number
  /** 文件变化后的去抖时间，默认 300 毫秒。 */
  debounceMs?: number
  actor?: string
}

export interface ProposalWatcher {
  /** 立即扫描一次（多次调用串行执行）。 */
  scan(): Promise<void>
  /** 启动：先扫描一次，然后监听目录并定时扫描。 */
  start(): Promise<void>
  stop(): void
}

export const proposalItemId = (id: string) => `prop.${id}`

export function createProposalWatcher(o: ProposalWatcherOptions): ProposalWatcher {
  const { ledger } = o
  const actor = o.actor ?? 'hub'
  const config = o.config ?? (() => ({ levels: [] }))
  const dir = join(flowPaths(o.home).state, 'proposals')
  let chain: Promise<void> = Promise.resolve()
  let watcher: FSWatcher | undefined
  let debounce: ReturnType<typeof setTimeout> | undefined
  let cancelTimer: (() => void) | undefined
  let stopped = false
  const warned = new Set<string>()

  const warnOnce = (id: string, message: string, details: Record<string, unknown> = {}) => {
    if (warned.has(id)) return
    warned.add(id)
    o.logger?.warn(message, { id, ...details })
  }

  /**
   * 待处理目录中的提案。`unreadable`：文件还在但读取或解析失败的 id。它们的状态不确定：
   * 不开条目，也不关已有条目（条目 id 固定，关了就再也不会重开），等文件恢复正常。
   */
  async function pending(): Promise<{ found: Map<string, Proposal>; unreadable: Set<string> }> {
    const found = new Map<string, Proposal>()
    const unreadable = new Set<string>()
    let names: string[]
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith('.json'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { found, unreadable }
      throw err
    }
    for (const name of names.sort()) {
      const id = name.slice(0, -5)
      let text: string
      try {
        text = await readFile(join(dir, name), 'utf8')
      } catch (err) {
        // 扫描期间提案被接受或拒绝（文件被移走）：按"不在待处理目录"处理。
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
        unreadable.add(id)
        warnOnce(id, '提案文件读取失败，暂不处理', { error: String(err) })
        continue
      }
      let data: unknown
      try {
        data = JSON.parse(text)
      } catch {
        unreadable.add(id)
        warnOnce(id, '提案文件不是合法的 JSON，暂不处理')
        continue
      }
      const parsed = proposalSchema.safeParse(data)
      if (parsed.success && parsed.data.id === id) {
        found.set(id, parsed.data)
        warned.delete(id)
      } else {
        unreadable.add(id)
        warnOnce(id, '提案文件不合法，暂不处理')
      }
    }
    return { found, unreadable }
  }

  const pendingPath = (id: string) => join(dir, `${id}.json`)

  /** 只有确认提案已离开待处理目录时才给出关闭原因；文件仍在时返回 null（保持现状）。 */
  const closeReason = (id: string): InboxCloseReason | null =>
    existsSync(join(dir, 'accepted', `${id}.json`))
      ? 'proposal_accepted'
      : existsSync(join(dir, 'rejected', `${id}.json`))
        ? 'proposal_rejected'
        : existsSync(pendingPath(id))
          ? null
          : 'proposal_removed'

  const report = (r: ReturnType<LedgerStore['append']>) => {
    if (!r.ok && r.error.code !== 'duplicate_item' && r.error.code !== 'item_closed') {
      o.logger?.warn('提案条目写入失败', r.error)
    }
  }

  async function doScan() {
    if (stopped) return
    let found: Map<string, Proposal>
    let unreadable: Set<string>
    try {
      ;({ found, unreadable } = await pending())
    } catch (err) {
      o.logger?.warn('扫描提案目录失败', String(err))
      return
    }
    if (stopped) return
    for (const [id, p] of found) {
      if (ledger.getInboxItem(proposalItemId(id))) continue
      // 读完目录到写入之间提案可能刚被接受或拒绝：开条目前再确认文件仍在待处理目录。
      // 仍有极小的窗口（确认之后才被处理），由下一次扫描关闭条目；
      // TODO(add-m1-inbox 4.1)：渠道推送前要确认条目仍是 open，避免推送已处理的提案。
      if (!existsSync(pendingPath(id))) continue
      report(
        ledger.append(
          {
            type: 'inbox.item_created',
            payload: {
              item_id: proposalItemId(id),
              level: resolveInboxLevel(config(), { source: 'proposal' }),
              source: 'proposal',
              source_ref: id,
              title: clipText(`修改提案：${p.target}`, INBOX_TITLE_MAX),
              body: clipText(
                `${p.reason}\n\n提议者：${p.actor}${p.base_hash === null ? '（新建条目）' : ''}`,
                INBOX_BODY_MAX,
              ),
              actions: ['accept', 'reject'],
            },
          },
          { actor },
        ),
      )
    }
    for (const item of ledger.listInboxItems({
      source: 'proposal',
      state: 'open',
      limit: 10_000,
    })) {
      if (found.has(item.source_ref) || unreadable.has(item.source_ref)) continue
      const reason = closeReason(item.source_ref)
      if (reason === null) continue
      // 处理来源跟随归档持久保存；扫描器重启后仍能恢复关闭的操作者和渠道。
      let decision: Pick<Proposal, 'decided_by' | 'via'> = {}
      if (reason === 'proposal_accepted' || reason === 'proposal_rejected') {
        try {
          const kind = reason === 'proposal_accepted' ? 'accepted' : 'rejected'
          const parsed = proposalSchema.safeParse(
            JSON.parse(await readFile(join(dir, kind, `${item.source_ref}.json`), 'utf8')),
          )
          if (parsed.success) decision = parsed.data
        } catch (err) {
          o.logger?.warn('读取提案处理来源失败', { id: item.source_ref, error: String(err) })
          continue
        }
      }
      report(
        ledger.append(
          {
            type: 'inbox.item_closed',
            payload: {
              item_id: item.id,
              reason,
              ...(decision.decided_by ? { cause_actor: decision.decided_by } : {}),
              ...(decision.via ? { via: decision.via } : {}),
            },
          },
          { actor },
        ),
      )
    }
  }

  const scan = () => {
    chain = chain.then(doScan, doScan)
    return chain
  }

  const tick = () => {
    if (stopped) return
    cancelTimer = o.clock.setTimeout(async () => {
      await scan()
      tick()
    }, o.intervalMs ?? 60_000)
  }

  return {
    scan,
    async start() {
      await scan()
      if (stopped) return
      try {
        mkdirSync(dir, { recursive: true })
        watcher = watch(dir, () => {
          if (stopped) return
          if (debounce) clearTimeout(debounce)
          debounce = setTimeout(() => {
            debounce = undefined
            void scan()
          }, o.debounceMs ?? 300)
        })
        watcher.on('error', (err) => o.logger?.warn('监听提案目录失败', String(err)))
      } catch (err) {
        o.logger?.warn('无法监听提案目录，只靠定时扫描', String(err))
      }
      tick()
    },
    stop() {
      stopped = true
      if (debounce) clearTimeout(debounce)
      cancelTimer?.()
      watcher?.close()
      watcher = undefined
    },
  }
}
