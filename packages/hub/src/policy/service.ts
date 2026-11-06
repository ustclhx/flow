import { stat } from 'node:fs/promises'
import {
  fail,
  type IndexedPolicyRule,
  loadPoliciesConfig,
  ok,
  type PolicyConfig,
  policyRuleHash,
  policyVersion,
  type Result,
  raindownPaths,
} from '@raindown/core'
import type { EventInput, LedgerStore } from '../ledger/store.ts'
import type { HubClock } from '../server/clock.ts'
import type { HubLogger } from '../server/maintenance.ts'

/** 入账前保存未脱敏的内容摘要；规则正文仍沿用账本脱敏。 */
export const auditRules = (rules: readonly IndexedPolicyRule[]): IndexedPolicyRule[] =>
  rules.map((rule) => ({ ...rule, rule_hash: policyRuleHash(rule) }))
const ruleHash = (rule: IndexedPolicyRule) => rule.rule_hash ?? policyRuleHash(rule)

export interface PolicyService {
  load(): Promise<Result<PolicyConfig>>
  version(): string
  start(): void
  stop(): Promise<void>
}

/** 所有加载串行比较版本；启动基线在 hub.started 固化，变化与任务通知原子入账。 */
export function createPolicyService(o: {
  home: string
  ledger: LedgerStore
  clock: HubClock
  logger: Pick<HubLogger, 'warn'>
}): PolicyService {
  const { ledger } = o
  let previous: { version: string; rules: Set<string> } | undefined
  let after = 0
  for (;;) {
    const events = ledger.eventsAfter(after, undefined, 1000)
    if (events.length === 0) break
    for (const e of events) {
      if (e.type === 'hub.started' && e.payload.policy_version && e.payload.policy_rules) {
        previous = { version: e.payload.policy_version, rules: new Set(e.payload.policy_rules) }
      } else if (e.type === 'policy.changed') {
        const rules = previous?.rules ?? new Set<string>()
        for (const hash of e.payload.removed) rules.delete(hash)
        for (const hash of e.payload.added) rules.add(hash)
        previous = { version: e.payload.to, rules }
      }
      after = e.seq
    }
  }
  let currentVersion = previous?.version ?? policyVersion([])
  let mtime: number | undefined
  let stopped = false
  let started = false
  let cancel = () => {}
  let tail: Promise<unknown> = Promise.resolve()
  const modifiedAt = async () => {
    try {
      return (await stat(raindownPaths(o.home).policiesConfig)).mtimeMs
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return -1
      throw err
    }
  }

  function record(config: PolicyConfig): Result<null> {
    const rules = new Set(config.rules.map(policyRuleHash))
    if (previous && previous.version !== config.version) {
      const oldRules = previous.rules
      const removed = [...oldRules].filter((hash) => !rules.has(hash))
      const added = [...rules].filter((hash) => !oldRules.has(hash))
      const removedSet = new Set(removed)
      const policySeq = ledger.seq() + 1
      const drafts: EventInput[] = [
        {
          type: 'policy.changed',
          payload: { from: previous.version, to: config.version, added, removed },
        },
      ]
      // 内部查询没有分页上限；每个受影响任务只记一条，不通知排队或已结束任务。
      for (const status of ['running', 'verifying', 'blocked'] as const) {
        for (const task of ledger.listTasks({ status, limit: Number.MAX_SAFE_INTEGER })) {
          const affected = new Set(
            (task.mandate?.matched_rules ?? [])
              .map(ruleHash)
              .filter((hash) => removedSet.has(hash)),
          )
          const delegation = ledger.pendingReply(task.id) ? null : ledger.activeDelegation(task.id)
          let approvalAffected = false
          if (delegation?.kind === 'awaiting_approval' && delegation.decision_id !== undefined) {
            const decision = ledger
              .taskEvents(task.id)
              .find((e) => e.seq === delegation.decision_id)
            if (decision?.type === 'policy.decided') {
              for (const rule of decision.payload.matched_rules) {
                const hash = ruleHash(rule)
                if (removedSet.has(hash)) {
                  affected.add(hash)
                  approvalAffected = true
                }
              }
            }
          }
          if (affected.size === 0) continue
          drafts.push({
            type: 'task.policy_changed',
            task_id: task.id,
            workspace: task.workspace,
            payload: { policy_seq: policySeq, rules: [...affected] },
          })
          if (approvalAffected && delegation)
            drafts.push({
              type: 'task.reply_escalated',
              task_id: task.id,
              workspace: task.workspace,
              payload: {
                block_seq: delegation.block_seq,
                reason: 'policy_changed',
                policy_version: config.version,
                note: `代批依赖的规则已删除或修改（策略变化 #${policySeq}）`,
              },
            })
        }
      }
      const written = ledger.appendMany(drafts, { actor: 'hub' })
      if (!written.ok) return written
    }
    previous = { version: config.version, rules }
    currentVersion = config.version
    return ok(null)
  }

  const load = (): Promise<Result<PolicyConfig>> => {
    const job = tail.then(async (): Promise<Result<PolicyConfig>> => {
      if (stopped) return fail('retryable', 'hub_stopping', '中枢正在停止')
      const stamp = await modifiedAt()
      const loaded = await loadPoliciesConfig(o.home)
      if (!loaded.ok) return loaded
      if (stopped) return fail('retryable', 'hub_stopping', '中枢正在停止')
      const written = record(loaded.data)
      if (!written.ok) return written
      mtime = stamp
      return loaded
    })
    tail = job.catch(() => {})
    return job
  }
  const arm = () => {
    cancel = o.clock.setTimeout(async () => {
      try {
        if (!stopped && (await modifiedAt()) !== mtime) {
          const result = await load()
          if (!result.ok) o.logger.warn('策略重新加载失败', result.error)
        }
      } catch (err) {
        o.logger.warn('策略文件检查失败', String(err))
      } finally {
        if (!stopped) arm()
      }
    }, 60_000)
  }
  return {
    load,
    version: () => currentVersion,
    start() {
      if (!started && !stopped) {
        started = true
        arm()
      }
    },
    async stop() {
      stopped = true
      cancel()
      await tail
    },
  }
}
