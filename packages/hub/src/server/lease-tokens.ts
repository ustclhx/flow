import { createHash, randomBytes } from 'node:crypto'
import type { LedgerStore } from '../ledger/store.ts'

/** 派工凭证与节点续约用的 lease_token 相互独立，仅授予 worker 本任务的读取与上报权限。 */
export const TASK_TOKEN_PREFIX = 'fls_'

export interface TaskCaller {
  actor: string
  task_id: string
  workspace: string
  lease_id: string
  attempt: number
}

export interface TaskTokenAuthority {
  issue(grant: { lease_id: string; task_id: string }): string | undefined
  ensure(grant: {
    lease_id: string
    task_id: string
    dispatch_token_sha256?: string
  }): string | undefined
  authenticate(presented: string): TaskCaller | null
  size(): number
}

export interface TaskTokenOptions {
  ledger: () =>
    | Pick<LedgerStore, 'getLease' | 'activeLease' | 'getTask' | 'attemptEnded' | 'wakeOf'>
    | undefined
  now?: () => number
  newSecret?: () => string
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const TERMINAL = new Set(['done', 'failed', 'cancelled'])

/** 明文不落盘、不入账本；每次请求重核当前派工，中枢重启后全部失效。 */
export function createTaskTokenAuthority(o: TaskTokenOptions): TaskTokenAuthority {
  const newSecret =
    o.newSecret ?? (() => `${TASK_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`)
  const records = new Map<string, TaskCaller>()
  const byLease = new Map<string, string>()

  function current(caller: TaskCaller): boolean {
    const ledger = o.ledger()
    if (!ledger) return false
    const lease = ledger.getLease(caller.lease_id)
    const task = ledger.getTask(caller.task_id)
    // 到期由清扫器裁定；只要仍 active，就与节点续约保持一致（含清扫宽限期）。
    return !!(
      lease?.state === 'active' &&
      lease.task_id === caller.task_id &&
      lease.attempt === caller.attempt &&
      ledger.activeLease(caller.task_id)?.lease_id === caller.lease_id &&
      task &&
      !TERMINAL.has(task.status) &&
      task.attempt === caller.attempt &&
      task.contract.role === caller.actor &&
      task.workspace === caller.workspace &&
      !ledger.attemptEnded(caller.task_id, caller.attempt)
    )
  }

  function discard(key: string, caller: TaskCaller) {
    records.delete(key)
    if (byLease.get(caller.lease_id) === key) byLease.delete(caller.lease_id)
  }

  function issue(grant: { lease_id: string; task_id: string }): string | undefined {
    const ledger = o.ledger()
    if (!ledger || ledger.wakeOf(grant.task_id)) return undefined
    const lease = ledger.getLease(grant.lease_id)
    const task = ledger.getTask(grant.task_id)
    if (!lease || !task) return undefined
    const caller: TaskCaller = {
      actor: task.contract.role,
      task_id: task.id,
      workspace: task.workspace,
      lease_id: lease.lease_id,
      attempt: lease.attempt,
    }
    if (!current(caller)) return undefined
    for (const [key, record] of records) if (!current(record)) discard(key, record)
    const previous = byLease.get(lease.lease_id)
    if (previous) records.delete(previous)
    const secret = newSecret()
    const key = digest(secret)
    records.set(key, caller)
    byLease.set(lease.lease_id, key)
    return secret
  }

  return {
    issue,
    ensure(grant) {
      const key = byLease.get(grant.lease_id)
      const caller = key === undefined ? undefined : records.get(key)
      if (
        caller &&
        caller.task_id === grant.task_id &&
        current(caller) &&
        grant.dispatch_token_sha256 === key?.slice(0, 16)
      )
        return undefined
      return issue(grant)
    },
    authenticate(presented) {
      if (!presented.startsWith(TASK_TOKEN_PREFIX)) return null
      const key = digest(presented)
      const caller = records.get(key)
      if (!caller) return null
      if (current(caller)) return { ...caller }
      discard(key, caller)
      return null
    },
    size: () => records.size,
  }
}
