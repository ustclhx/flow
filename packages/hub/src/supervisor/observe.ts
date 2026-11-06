import {
  clipText,
  fail,
  OBSERVED_ARGS_MAX,
  type Result,
  redactSecrets,
  type SupervisorConfig,
  type TaskView,
} from '@raindown/core'
import type { LedgerStore } from '../ledger/store.ts'
import { HUB_ACTOR } from '../ledger/supervisor-checks.ts'

/**
 * observe 模式下 autonomous 唤醒的写类动作（add-harness-neutral-coordination D10，tasks 7.3）。
 *
 * `task_create`、`task_propose`、`pr_merge_request` 在各自的核对全部通过、即将写入之前调用：
 * 只写 `supervisor.observed_action{action, args 摘要, reason}`（hub 身份），**不执行**，
 * 返回给 supervisor 的结果是错误码 `observe_not_executed`，说明以"observe：未执行"开头。
 * instruction 与 reply 唤醒不受影响（调用方按唤醒的 origin 判断）。
 */

export type ObservedAction = 'task_create' | 'task_propose' | 'pr_merge_request'

/**
 * 该唤醒的写类动作是否只记录：autonomous 唤醒，或合并了 PR 评论的唤醒（来源 instruction:pr，
 * 与 autonomous 同样对待），且 `supervisor.observe.autonomous` 开启。
 */
export const observeAutonomous = (
  origin: string | undefined,
  config: Pick<SupervisorConfig, 'observe'> | null | undefined,
  source?: 'pr',
): boolean => (origin === 'autonomous' || source === 'pr') && config?.observe.autonomous === true

/**
 * 唤醒是否为 PR 来源（instruction:pr）：不只信 payload 标记，也从唤醒合并的事件推导——
 * 事件中有 `pr.wake_requested`，或事件涉及的任务授权依据带 `pr_sourced`（污染沿唤醒链向下传递）。
 */
export function prSourcedWake(
  ledger: Pick<LedgerStore, 'wakeOf' | 'eventsAfter' | 'getTask'>,
  wakeTaskId: string | undefined,
): boolean {
  if (wakeTaskId === undefined) return false
  const wake = ledger.wakeOf(wakeTaskId)
  if (!wake) return false
  if (wake.source === 'pr') return true
  for (const seq of wake.events) {
    const e = ledger.eventsAfter(seq - 1, {}, 1)[0]
    if (e?.seq !== seq) continue
    if (e.type === 'pr.wake_requested') return true
    if (e.task_id !== undefined && ledger.getTask(e.task_id)?.mandate?.pr_sourced) return true
  }
  return false
}

/** 任务是否带 PR 来源污染：授权依据标记，或其来源唤醒为 PR 来源。 */
export const prSourcedTask = (
  ledger: Pick<LedgerStore, 'wakeOf' | 'eventsAfter' | 'getTask'>,
  task: Pick<TaskView, 'mandate'> | null | undefined,
): boolean => !!task?.mandate?.pr_sourced || prSourcedWake(ledger, task?.mandate?.wake_task)

/** 参数摘要：JSON 序列化后遮蔽疑似密钥，再截断到 `OBSERVED_ARGS_MAX`（先遮蔽后截断，避免切开密钥）。 */
export function summarizeArgs(args: unknown): string {
  let text: string
  try {
    text = JSON.stringify(args) ?? ''
  } catch {
    text = String(args)
  }
  return clipText(redactSecrets(text), OBSERVED_ARGS_MAX)
}

const OBSERVE_REASON =
  '本 workspace 的 supervisor.observe.autonomous 已开启：autonomous 唤醒的写类动作只记录、不执行'

/** 本次唤醒已记录的 observe 动作数。 */
export const observedActionCount = (
  ledger: Pick<LedgerStore, 'eventsByPayload'>,
  wakeTaskId: string,
): number => ledger.eventsByPayload('supervisor.observed_action', 'wake_task_id', wakeTaskId).length

/**
 * 写 `supervisor.observed_action` 并返回 `observe_not_executed`（写入失败时返回写入错误，同样未执行）。
 * 记录数计入 `limits.tasks_per_wake`（`limit`）：一次唤醒不能无限写 observe 记录，达到上限返回 `limit_exceeded`。
 */
export function recordObservedAction(
  ledger: Pick<LedgerStore, 'append' | 'eventsByPayload'>,
  o: {
    workspace: string
    wake_task_id: string
    action: ObservedAction
    args: unknown
    limit: number
  },
): Result<never> {
  const made = observedActionCount(ledger, o.wake_task_id)
  if (made >= o.limit) {
    return fail(
      'failure',
      'limit_exceeded',
      `observe：本次唤醒已记录 ${made} 个未执行的动作，达到上限 ${o.limit}（supervisor.limits.tasks_per_wake）`,
      { limit: 'tasks_per_wake', max: o.limit },
    )
  }
  const written = ledger.append(
    {
      type: 'supervisor.observed_action',
      workspace: o.workspace,
      payload: {
        wake_task_id: o.wake_task_id,
        action: o.action,
        args: summarizeArgs(o.args),
        reason: OBSERVE_REASON,
      },
    },
    { actor: HUB_ACTOR },
  )
  if (!written.ok) return written
  return fail(
    'failure',
    'observe_not_executed',
    `observe：未执行。${o.action} 只记录为 supervisor.observed_action（#${written.data.seq}），没有建任务、提交提案或合并请求；不要重试，用户会在 raindown supervisor report 中查看。`,
    { observed: true, action: o.action, seq: written.data.seq },
  )
}
