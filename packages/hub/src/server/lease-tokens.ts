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
  authenticate(presented: string): TaskCaller | null
  size(): number
}

export interface TaskTokenOptions {
  ledger: () =>
    | Pick<LedgerStore, 'getLease' | 'activeLease' | 'getTask' | 'taskEvents' | 'wakeOf'>
    | undefined
  now?: () => number
  newSecret?: () => string
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const TERMINAL = new Set(['done', 'failed', 'cancelled'])

/** 明文不落盘、不入账本；每次请求重核当前派工，中枢重启后全部失效。 */
export function createTaskTokenAuthority(o: TaskTokenOptions): TaskTokenAuthority {
  const now = o.now ?? Date.now
  const newSecret =
    o.newSecret ?? (() => `${TASK_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`)
  const records = new Map<string, TaskCaller>()

  function current(caller: TaskCaller): boolean {
    const ledger = o.ledger()
    if (!ledger) return false
    const lease = ledger.getLease(caller.lease_id)
    const task = ledger.getTask(caller.task_id)
    return !!(
      lease?.state === 'active' &&
      lease.task_id === caller.task_id &&
      lease.attempt === caller.attempt &&
      Date.parse(lease.expires_at) > now() &&
      ledger.activeLease(caller.task_id)?.lease_id === caller.lease_id &&
      task &&
      !TERMINAL.has(task.status) &&
      task.attempt === caller.attempt &&
      task.contract.role === caller.actor &&
      task.workspace === caller.workspace &&
      !ledger
        .taskEvents(caller.task_id)
        .some(
          (event) =>
            event.type === 'task.attempt_ended' && event.payload.attempt === caller.attempt,
        )
    )
  }

  return {
    issue(grant) {
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
      for (const [key, record] of records) if (!current(record)) records.delete(key)
      const secret = newSecret()
      records.set(digest(secret), caller)
      return secret
    },
    authenticate(presented) {
      if (!presented.startsWith(TASK_TOKEN_PREFIX)) return null
      const key = digest(presented)
      const caller = records.get(key)
      if (!caller) return null
      if (current(caller)) return { ...caller }
      records.delete(key)
      return null
    },
    size: () => records.size,
  }
}
