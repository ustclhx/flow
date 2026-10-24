import { randomBytes } from 'node:crypto'
import {
  type CancelTaskData,
  type CreateTaskData,
  fail,
  formatZodIssues,
  type ListTasksData,
  listTasksQuery,
  loadWorkspaces,
  ok,
  type ReplyKind,
  type ReplyTaskData,
  type Result,
  replyTaskRequest,
  type ShowTaskData,
  taskContract,
} from '@flow/core'
import type { LedgerStore } from './store.ts'

/**
 * 任务服务（tasks.md 2.3；task-ledger spec "任务合同""幂等创建""取消"）。
 * HTTP 路由与以后的反应器都经由它操作任务，不直接拼事件。
 */

/** workspace 是否存在。中枢里用 `workspaceCheckFromHome`，测试可注入任意函数。 */
export type WorkspaceCheck = (ref: string) => boolean | Promise<boolean>

/** 基于 flow-home 的 `config/workspaces/` 检查（每次调用都重新读取，配置改动无需重启）。 */
export function workspaceCheckFromHome(home: string): WorkspaceCheck {
  return async (ref) => {
    const loaded = await loadWorkspaces(home)
    return loaded.ok && loaded.data.workspaces.some((w) => w.ref === ref)
  }
}

/**
 * 任务 id：`t-<UTC yyyymmdd>-<UTC hhmmss>-<6 位十六进制随机数>`，例如 `t-20261024-083015-3fa9c2`。
 * - 满足 `LEDGER_ID_RE`（字母数字开头，只含 `-`）；
 * - 按字典序大致等于创建时间顺序，人读起来也能看出创建时刻；
 * - 同一秒内靠 24 位随机数区分，碰撞时（极少）重新生成。
 */
export function generateTaskId(nowMs: number, random: () => string = defaultRandom): string {
  const s = new Date(nowMs).toISOString() // 2026-10-24T08:30:15.123Z
  return `t-${s.slice(0, 10).replaceAll('-', '')}-${s.slice(11, 19).replaceAll(':', '')}-${random()}`
}
const defaultRandom = () => randomBytes(3).toString('hex')

/** 回复 id：`r-<16 位十六进制>`。 */
export const generateReplyId = () => `r-${randomBytes(8).toString('hex')}`

/**
 * 各卡住原因接受的回复类型（task-interaction "审批答复不能用于提问"）：
 * awaiting_approval 接受 approve / deny / 文字，其余原因（question、no_progress、crashed…）只接受文字。
 */
export function acceptedReplyKinds(
  reason: string | undefined,
  priorReason?: string,
): readonly ReplyKind[] {
  // 节点掉线（node_lost）前在等授权：仍然可以 approve / deny（PR #16 复核第 5 条）。
  const effective = reason === 'node_lost' && priorReason ? priorReason : reason
  return effective === 'awaiting_approval' ? ['approve', 'deny', 'text'] : ['text']
}

export interface TaskServiceOptions {
  ledger: LedgerStore
  workspaceExists: WorkspaceCheck
  now?: () => number
  /** 生成任务 id，默认 `generateTaskId`。 */
  newTaskId?: (nowMs: number) => string
  /** 生成回复 id，默认 `generateReplyId`。 */
  newReplyId?: () => string
}

export interface CreateTaskOptions {
  actor: string
  /** 幂等键；也可以写在合同的 `idempotency_key` 中（两处都给时必须一致）。 */
  idempotency_key?: string
}

export interface CancelTaskOptions {
  actor: string
  reason?: string
}

export interface ReplyTaskOptions {
  actor: string
}

export interface TaskService {
  createTask(contractInput: unknown, opts: CreateTaskOptions): Promise<Result<CreateTaskData>>
  listTasks(filter?: unknown): Result<ListTasksData>
  getTask(id: string): Result<ShowTaskData>
  cancelTask(id: string, opts: CancelTaskOptions): Result<CancelTaskData>
  replyTask(id: string, body: unknown, opts: ReplyTaskOptions): Result<ReplyTaskData>
}

/** zod issues → 逐字段错误（field、code=missing_field|invalid_field、message）。 */
export function fieldIssues(issues: Parameters<typeof formatZodIssues>[0], data: unknown) {
  return formatZodIssues(issues, data, { file: '' }).map(({ file: _file, ...rest }) => rest)
}

const invalidArguments = (
  what: string,
  issues: Parameters<typeof formatZodIssues>[0],
  data: unknown,
) => {
  const fields = fieldIssues(issues, data)
  return fail(
    'usage',
    'invalid_arguments',
    `${what}不合法：${fields.map((f) => f.message).join('；')}`,
    fields,
  )
}

export function createTaskService(o: TaskServiceOptions): TaskService {
  const { ledger } = o
  const now = o.now ?? Date.now
  const newTaskId = o.newTaskId ?? ((ms: number) => generateTaskId(ms))
  const newReplyId = o.newReplyId ?? generateReplyId

  const notFound = (id: string) => fail('failure', 'not_found', `没有任务 ${id}`)

  return {
    async createTask(contractInput, opts) {
      const parsed = taskContract.safeParse(contractInput)
      if (!parsed.success) return invalidArguments('任务合同', parsed.error.issues, contractInput)
      const contract = parsed.data
      if (
        opts.idempotency_key !== undefined &&
        contract.idempotency_key !== undefined &&
        opts.idempotency_key !== contract.idempotency_key
      ) {
        return fail('usage', 'invalid_arguments', '幂等键与合同中的 idempotency_key 不一致', [
          { field: 'idempotency_key', code: 'invalid_field', message: '幂等键不一致' },
        ])
      }
      const key = opts.idempotency_key ?? contract.idempotency_key
      if (key !== undefined) contract.idempotency_key = key

      const existing = () => (key === undefined ? null : ledger.findTaskByIdempotencyKey(key))
      const hit = existing()
      if (hit) return ok({ task: hit, created: false })

      if (!(await o.workspaceExists(contract.workspace))) {
        return fail('failure', 'unknown_workspace', `workspace ${contract.workspace} 未定义`, {
          field: 'workspace',
          workspace: contract.workspace,
        })
      }

      // await 之后重新检查幂等键：从这里到 append 都是同步代码，不会与其他请求交错。
      const raced = existing()
      if (raced) return ok({ task: raced, created: false })

      let id = newTaskId(now())
      for (let i = 0; ledger.getTask(id) !== null; i++) {
        if (i >= 5) return fail('failure', 'internal_error', '无法生成不重复的任务 id')
        id = newTaskId(now())
      }
      const written = ledger.append(
        { type: 'task.created', task_id: id, workspace: contract.workspace, payload: { contract } },
        { actor: opts.actor },
      )
      if (!written.ok) return written
      const task = ledger.getTask(id)
      return task
        ? ok({ task, created: true })
        : fail('failure', 'internal_error', '任务写入后不可见')
    },

    listTasks(filter = {}) {
      const parsed = listTasksQuery.safeParse(filter)
      if (!parsed.success) return invalidArguments('查询参数', parsed.error.issues, filter)
      return ok({ tasks: ledger.listTasks(parsed.data) })
    },

    getTask(id) {
      const task = ledger.getTask(id)
      return task
        ? ok({ task, events: ledger.taskEvents(id), replies: ledger.taskReplies(id) })
        : notFound(id)
    },

    cancelTask(id, opts) {
      const task = ledger.getTask(id)
      if (!task) return notFound(id)
      const reason = opts.reason === undefined ? {} : { reason: opts.reason }
      const base = { task_id: id, workspace: task.workspace }
      // blocked 但节点仍持有租约（D7a）：与 running 一样经续约通知节点停止执行器。
      const status =
        task.status === 'blocked' && ledger.activeLease(id) !== null ? 'running' : task.status
      switch (status) {
        case 'queued':
        case 'blocked': {
          const r = ledger.append(
            { ...base, type: 'task.cancelled', payload: reason },
            { actor: opts.actor },
          )
          if (!r.ok) return r
          break
        }
        case 'running':
        case 'verifying': {
          // 已请求过取消时不重复写事件，保持幂等。
          if (task.cancel_requested) return ok({ task })
          const r = ledger.append(
            { ...base, type: 'task.cancel_requested', payload: reason },
            { actor: opts.actor },
          )
          if (!r.ok) return r
          break
        }
        default:
          return fail(
            'failure',
            'invalid_transition',
            `任务状态为 ${task.status}（终态），不能取消`,
            { from: task.status, type: 'task.cancelled' },
          )
      }
      const after = ledger.getTask(id)
      return after ? ok({ task: after }) : notFound(id)
    },

    replyTask(id, body, opts) {
      // 防止 AI 自批：只接受 actor=user 的回复（与 task_reply 操作一致）。
      // X-Flow-Actor 是自报身份，不是安全边界（ledger-daemon D7 的已知缺口）；
      // supervisor 代为答复留到变更 ④。
      if (opts.actor !== 'user') {
        return fail(
          'failure',
          'user_only',
          `只有用户本人可以回复卡住的任务，当前为 ${opts.actor}`,
          {
            actor: opts.actor,
          },
        )
      }
      const parsed = replyTaskRequest.safeParse(body)
      if (!parsed.success) return invalidArguments('回复', parsed.error.issues, body)
      const { kind, text } = parsed.data
      const task = ledger.getTask(id)
      if (!task) return notFound(id)
      if (task.status !== 'blocked') {
        return fail(
          'failure',
          'not_blocked',
          `任务状态为 ${task.status}，只有 blocked 的任务可以回复`,
          {
            status: task.status,
          },
        )
      }
      const reason = task.blocked?.reason
      const accepted = acceptedReplyKinds(reason, task.blocked?.prior_reason)
      if (!accepted.includes(kind)) {
        return fail(
          'failure',
          'reply_kind_mismatch',
          `任务卡在 ${reason}，只接受 ${accepted.join(' / ')} 回复，不接受 ${kind}`,
          { reason, kind, accepted },
        )
      }
      const replyId = newReplyId()
      const base = { task_id: id, workspace: task.workspace }
      // 没有节点持有该任务（无头执行器已结束这一轮、或节点掉线）：带着回复重新排队（D7、D7a）。
      const requeue = ledger.activeLease(id) === null
      const session = task.blocked?.session
      const written = ledger.appendMany(
        [
          {
            ...base,
            type: 'task.replied',
            payload: { reply_id: replyId, kind, ...(text === undefined ? {} : { text }) },
          },
          ...(requeue
            ? [
                {
                  ...base,
                  type: 'task.requeued_with_reply' as const,
                  payload: { reply_id: replyId, ...(session ? { session } : {}) },
                },
              ]
            : []),
        ],
        { actor: opts.actor },
      )
      if (!written.ok) return written
      const after = ledger.getTask(id)
      const reply = ledger.getReply(replyId)
      return after && reply
        ? ok({ task: after, reply, requeued: requeue })
        : fail('failure', 'internal_error', '回复写入后不可见')
    },
  }
}
