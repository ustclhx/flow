import { createHash, randomBytes } from 'node:crypto'
import { SUPERVISOR_ACTOR, type WakeOrigin } from '@flow/core'
import type { LedgerStore } from '../ledger/store.ts'

/**
 * 唤醒绑定 token（add-m1-supervisor D6；tasks 2.2）。
 *
 * - 节点领到 supervisor 唤醒任务（以 `supervisor.wake_started` 判定）的租约时，中枢签发一个只对这次唤醒有效的
 *   token，随租约响应（`lease.wake_token`）下发一次；
 * - 身份固定为 `supervisor`，绑定 workspace、唤醒任务 id 与租约 id；
 * - 每次鉴权都重新核对账本：租约仍是 active 且未过期、属于该唤醒任务，任务未结束——租约结束或任务结束即失效；
 * - 明文不入账本、不落盘，内存中只按 sha256 摘要保存；**中枢重启后全部失效**（失效方向安全：之后该唤醒的
 *   MCP 调用得到 401，唤醒按普通任务结束或失败）；
 * - 中枢据此认定调用方是哪个唤醒及其 origin，不信任 `--task`、`FLOW_TASK_ID`、`X-Flow-Actor`。
 */

export const WAKE_TOKEN_PREFIX = 'fwk_'

/** 经唤醒绑定 token 认定的调用方。 */
export interface WakeCaller {
  actor: typeof SUPERVISOR_ACTOR
  /** 唤醒任务 id。 */
  task_id: string
  workspace: string
  lease_id: string
  /** `supervisor.wake_started` 记录的 origin（instruction、autonomous 或 reply）。 */
  origin: WakeOrigin
  generation: number
}

export interface WakeTokenAuthority {
  /** 为唤醒任务的这次租约签发 token；任务不是唤醒任务时返回 undefined（不签发）。 */
  issue(grant: { lease_id: string; task_id: string }): string | undefined
  /** 校验 token；无效、租约已结束或任务已结束时返回 null（并清掉记录）。 */
  authenticate(presented: string): WakeCaller | null
  /** 当前保存的记录数（测试与诊断）。 */
  size(): number
}

const TERMINAL = new Set(['done', 'failed', 'cancelled'])

const digest = (s: string) => createHash('sha256').update(s).digest('hex')

export interface WakeTokenOptions {
  /** 账本；中枢里账本在启动流程中才打开，所以用取值函数。 */
  ledger: () => Pick<LedgerStore, 'getLease' | 'getTask' | 'wakeOf'> | undefined
  now?: () => number
  /** 生成 token 明文，默认 32 字节随机数（测试可注入）。 */
  newSecret?: () => string
}

export function createWakeTokenAuthority(o: WakeTokenOptions): WakeTokenAuthority {
  const now = o.now ?? Date.now
  const newSecret =
    o.newSecret ?? (() => `${WAKE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`)
  /** sha256(token) → 绑定的租约与任务。 */
  const records = new Map<string, { lease_id: string; task_id: string }>()

  /** 账本核对：租约 active 且未过期、属于该任务；任务未结束且是唤醒任务。 */
  function resolve(rec: { lease_id: string; task_id: string }): WakeCaller | null {
    const ledger = o.ledger()
    if (!ledger) return null
    const lease = ledger.getLease(rec.lease_id)
    if (lease?.state !== 'active' || lease.task_id !== rec.task_id) return null
    if (Date.parse(lease.expires_at) <= now()) return null
    const task = ledger.getTask(rec.task_id)
    if (!task || TERMINAL.has(task.status)) return null
    const wake = ledger.wakeOf(rec.task_id)
    if (!wake || wake.workspace !== task.workspace) return null
    return {
      actor: SUPERVISOR_ACTOR,
      task_id: rec.task_id,
      workspace: wake.workspace,
      lease_id: rec.lease_id,
      origin: wake.origin,
      generation: wake.generation,
    }
  }

  /** 清掉已失效的记录，防止长期运行时堆积。 */
  function prune() {
    for (const [key, rec] of records) if (!resolve(rec)) records.delete(key)
  }

  return {
    issue(grant) {
      const ledger = o.ledger()
      if (!ledger?.wakeOf(grant.task_id)) return undefined
      prune()
      const secret = newSecret()
      records.set(digest(secret), { lease_id: grant.lease_id, task_id: grant.task_id })
      return secret
    },
    authenticate(presented) {
      if (!presented.startsWith(WAKE_TOKEN_PREFIX)) return null
      const key = digest(presented)
      const rec = records.get(key)
      if (!rec) return null
      const caller = resolve(rec)
      if (!caller) records.delete(key)
      return caller
    },
    size: () => records.size,
  }
}
