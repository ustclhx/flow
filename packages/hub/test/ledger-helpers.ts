import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ok, type TaskContractInput, taskContract } from '@flow/core'
import {
  type EventInput,
  type LedgerStore,
  type OpenLedgerOptions,
  openLedger,
  type RoleLookup,
} from '../src/index.ts'

export const WS = 'ws/demo'

/** 与角色权限无关的测试用：任何角色都存在，且任何身份都可以创建。 */
export const anyRole: RoleLookup = async (name) => ok({ name, creatable_by: ['*'] })
/** 不像密钥的 SHA-256 占位值。 */
export const SHA = 'ab'.repeat(32)

export function contractInput(over: Partial<TaskContractInput> = {}): TaskContractInput {
  return { goal: '写一个测试', workspace: WS, role: 'developer', executor: 'fake', ...over }
}

export const contract = (over: Partial<TaskContractInput> = {}) =>
  taskContract.parse(contractInput(over))

export const result = (node = 'n1') => ({ summary: '完成', executor: 'fake', node_id: node })

/** 可控时钟：每次读取前进 step 毫秒。 */
export function stepClock(start = Date.parse('2026-10-24T00:00:00.000Z'), step = 1000) {
  let t = start
  const now = () => {
    t += step
    return t
  }
  return Object.assign(now, {
    peek: () => t,
    advance: (ms: number) => {
      t += ms
    },
  })
}

export async function tempLedger(opts: OpenLedgerOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'flow-ledger-'))
  const path = join(dir, 'flow.db')
  const store = await openLedger(path, { now: stepClock(), ...opts })
  return {
    dir,
    path,
    store,
    cleanup: () => {
      try {
        store.close()
      } catch {
        // 已关闭
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** 某任务各类事件的合法草稿（结构上合法；状态是否允许由账本判断）。 */
export function drafts(
  id: string,
  o: { attempt?: number; leaseId?: string; node?: string; ws?: string } = {},
) {
  const ws = o.ws ?? WS
  const node = o.node ?? 'n1'
  const attempt = o.attempt ?? 1
  const leaseId = o.leaseId ?? `l-${id}-${attempt}`
  const base = { task_id: id, workspace: ws }
  return {
    'task.created': {
      ...base,
      type: 'task.created',
      payload: { contract: contract({ workspace: ws }) },
    },
    'task.started': {
      ...base,
      type: 'task.started',
      payload: { node_id: node, lease_id: leaseId, attempt },
    },
    'lease.granted': {
      ...base,
      type: 'lease.granted',
      payload: {
        lease_id: leaseId,
        node_id: node,
        token_sha256: SHA,
        ttl_s: 60,
        expires_at: '2026-10-24T01:00:00.000Z',
      },
    },
    'task.verifying': { ...base, type: 'task.verifying', payload: { node_id: node } },
    'task.done': { ...base, type: 'task.done', payload: { result: result(node) } },
    'task.failed': { ...base, type: 'task.failed', payload: { message: '放弃' } },
    'task.blocked': {
      ...base,
      type: 'task.blocked',
      payload: { reason: 'question', message: '需要确认', tail: ['最后一行'] },
    },
    'task.unblocked': { ...base, type: 'task.unblocked', payload: { note: '已答复' } },
    'task.requeued:manual': { ...base, type: 'task.requeued', payload: { reason: 'manual' } },
    'task.requeued:lease_expired': {
      ...base,
      type: 'task.requeued',
      payload: { reason: 'lease_expired' },
    },
    'task.cancel_requested': { ...base, type: 'task.cancel_requested', payload: {} },
    'task.cancelled': { ...base, type: 'task.cancelled', payload: { reason: '不需要了' } },
    'task.lease_expired': {
      ...base,
      type: 'task.lease_expired',
      payload: {
        lease_id: leaseId,
        node_id: node,
        expired_at: '2026-10-24T01:00:00.000Z',
        attempt,
      },
    },
  } satisfies Record<string, EventInput>
}
export type DraftKey = keyof ReturnType<typeof drafts>

export const sys = { actor: 'hub' }

/** 断言成功并返回数据。 */
export function must<T>(r: { ok: true; data: T } | { ok: false; error: { message: string } }): T {
  if (!r.ok) throw new Error(`期望成功：${r.error.message}`)
  return r.data
}

/** 建一个任务并开始执行（started + lease.granted 同事务）。 */
export function startTask(store: LedgerStore, id: string, attempt = 1) {
  const d = drafts(id, { attempt })
  must(store.appendMany([d['task.started'], d['lease.granted']], sys))
  return d
}
