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
 * 扫描不取写锁，只读目录；内容不合法的提案文件跳过并告警。
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

  async function pending(): Promise<Map<string, Proposal>> {
    const out = new Map<string, Proposal>()
    let names: string[]
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith('.json'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return out
      throw err
    }
    for (const name of names.sort()) {
      const id = name.slice(0, -5)
      try {
        const parsed = proposalSchema.safeParse(JSON.parse(await readFile(join(dir, name), 'utf8')))
        if (parsed.success && parsed.data.id === id) out.set(id, parsed.data)
        else if (!warned.has(id)) {
          warned.add(id)
          o.logger?.warn('提案文件不合法，已跳过', { id })
        }
      } catch (err) {
        // 扫描期间提案被接受或拒绝（文件被移走）：下次扫描再处理。
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && !warned.has(id)) {
          warned.add(id)
          o.logger?.warn('提案文件读取失败，已跳过', { id, error: String(err) })
        }
      }
    }
    return out
  }

  const closeReason = (id: string): InboxCloseReason =>
    existsSync(join(dir, 'accepted', `${id}.json`))
      ? 'proposal_accepted'
      : existsSync(join(dir, 'rejected', `${id}.json`))
        ? 'proposal_rejected'
        : 'proposal_removed'

  const report = (r: ReturnType<LedgerStore['append']>) => {
    if (!r.ok && r.error.code !== 'duplicate_item' && r.error.code !== 'item_closed') {
      o.logger?.warn('提案条目写入失败', r.error)
    }
  }

  async function doScan() {
    if (stopped) return
    let found: Map<string, Proposal>
    try {
      found = await pending()
    } catch (err) {
      o.logger?.warn('扫描提案目录失败', String(err))
      return
    }
    if (stopped) return
    for (const [id, p] of found) {
      if (ledger.getInboxItem(proposalItemId(id))) continue
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
      if (found.has(item.source_ref)) continue
      report(
        ledger.append(
          {
            type: 'inbox.item_closed',
            payload: { item_id: item.id, reason: closeReason(item.source_ref) },
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
