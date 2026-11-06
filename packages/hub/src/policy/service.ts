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
import { approvalAuthorization } from './approval.ts'

/** 入账前保存未脱敏的内容摘要；规则正文仍沿用账本脱敏。 */
export const auditRules = (rules: readonly IndexedPolicyRule[]): IndexedPolicyRule[] =>
  rules.map((rule) => ({ ...rule, rule_hash: policyRuleHash(rule) }))
const ruleHash = (rule: IndexedPolicyRule) => rule.rule_hash ?? policyRuleHash(rule)

export interface PolicyService {
  load(): Promise<Result<PolicyConfig>>
  version(): string
  current(): PolicyConfig | undefined
  start(): void
  stop(): Promise<void>
}

/** 所有加载串行比较版本；启动基线在 hub.started 固化，全局变化与任务通知分别入账，单任务失败不阻断加载。 */
export function createPolicyService(o: {
  home: string
  ledger: LedgerStore
  clock: HubClock
  logger: Pick<HubLogger, 'warn'>
}): PolicyService {
  const { ledger } = o
  let previous: { version: string; rules: Set<string> } | undefined
  // 只回溯启动事件寻找最近有效快照，再读取它之后的策略事件；不解析无关任务历史。
  let before: number | undefined
  let after = 0
  for (;;) {
    const event = ledger.latestEvent(before, 'hub.started')
    if (!event) break
    if (
      event.type === 'hub.started' &&
      event.payload.policy_version &&
      event.payload.policy_rules
    ) {
      previous = {
        version: event.payload.policy_version,
        rules: new Set(event.payload.policy_rules),
      }
      after = event.seq
      break
    }
    before = event.seq
  }
  for (;;) {
    const events = ledger.eventsBetween(
      'policy.changed',
      '0000-01-01T00:00:00.000Z',
      '9999-12-31T23:59:59.999Z',
      1000,
      after,
    )
    if (events.length === 0) break
    for (const event of events) {
      if (event.type !== 'policy.changed') continue
      const rules = previous?.rules ?? new Set<string>()
      for (const hash of event.payload.removed) rules.delete(hash)
      for (const hash of event.payload.added) rules.add(hash)
      previous = { version: event.payload.to, rules }
      after = event.seq
    }
  }
  let currentVersion = previous?.version ?? policyVersion([])
  let currentConfig: PolicyConfig | undefined
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
    if ((previous && previous.version !== config.version) || (!previous && started)) {
      const oldRules = previous?.rules ?? new Set<string>()
      const removed = [...oldRules].filter((hash) => !rules.has(hash))
      const added = [...rules].filter((hash) => !oldRules.has(hash))
      const removedSet = new Set(removed)
      // 全局变化先固化；任务侧某一草稿失败只报告该任务，不阻断其他任务与后续策略加载。
      const changed = ledger.append(
        {
          type: 'policy.changed',
          payload: { from: previous?.version ?? null, to: config.version, added, removed },
        },
        { actor: 'hub' },
      )
      if (!changed.ok) return changed
      const policySeq = changed.data.seq
      for (const status of ['running', 'verifying', 'blocked'] as const) {
        for (const task of ledger.listTasks({ status, limit: Number.MAX_SAFE_INTEGER })) {
          const affected = new Set(
            (task.mandate?.matched_rules ?? [])
              .map(ruleHash)
              .filter((hash) => removedSet.has(hash)),
          )
          const pending = ledger.pendingReply(task.id)
          const delegation = ledger.activeDelegation(task.id)
          const pendingApproval = pending?.by === 'supervisor' && pending.kind === 'approve'
          let handoffNote: string | undefined
          let escalation: EventInput | undefined
          if (
            delegation?.kind === 'awaiting_approval' &&
            delegation.decision_id !== undefined &&
            (!pending || pendingApproval)
          ) {
            const events = ledger.taskEvents(task.id)
            const decision = events.find((event) => event.seq === delegation.decision_id)
            if (decision?.type === 'policy.decided') {
              const authorization = approvalAuthorization(config.rules, task, decision)
              if (!authorization.allowed) {
                const alreadyFetched = pendingApproval && pending.fetched_at != null
                if (alreadyFetched)
                  handoffNote =
                    '批准在撤回生效前已交给节点，不能撤回；正在等待节点确认实际送达结果。'

                for (const rule of [
                  ...decision.payload.matched_rules,
                  ...authorization.matched_rules,
                ])
                  affected.add(ruleHash(rule))
                const delegated = events.find((event) => event.seq === delegation.seq)
                const version =
                  decision.payload.policy_version ??
                  (delegated?.type === 'task.reply_delegated'
                    ? delegated.payload.policy_version
                    : undefined) ??
                  previous?.version
                escalation = {
                  type: 'task.reply_escalated',
                  task_id: task.id,
                  workspace: task.workspace,
                  payload: {
                    block_seq: delegation.block_seq,
                    reason: 'policy_changed',
                    ...(version ? { policy_version: version } : {}),
                    to_version: config.version,
                    matched_rules: decision.payload.matched_rules,
                    ...(pendingApproval && !alreadyFetched ? { dropped_reply_id: pending.id } : {}),
                    note: `当前策略已不再允许 supervisor 代批（策略变化 #${policySeq}）${handoffNote ? `；${handoffNote}` : ''}`,
                  },
                }
              }
            }
          }
          const drafts: EventInput[] = []
          if (affected.size > 0)
            drafts.push({
              type: 'task.policy_changed',
              task_id: task.id,
              workspace: task.workspace,
              payload: {
                policy_seq: policySeq,
                rules: [...affected],
                ...(handoffNote ? { note: handoffNote } : {}),
              },
            })
          if (escalation) drafts.push(escalation)
          for (const draft of drafts) {
            const written = ledger.append(draft, { actor: 'hub' })
            if (!written.ok)
              o.logger.warn('策略变化的任务事件写入失败', {
                task_id: task.id,
                type: draft.type,
                policy_seq: policySeq,
                error: written.error,
              })
          }
        }
      }
    }
    previous = { version: config.version, rules }
    currentVersion = config.version
    currentConfig = config
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
    current: () => currentConfig,
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
