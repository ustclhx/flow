import {
  clipText,
  fail,
  OBSERVED_ARGS_MAX,
  type Result,
  redactSecrets,
  type SupervisorConfig,
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

/** 该唤醒的写类动作是否只记录（autonomous 唤醒且 `supervisor.observe.autonomous` 开启）。 */
export const observeAutonomous = (
  origin: string | undefined,
  config: Pick<SupervisorConfig, 'observe'> | null | undefined,
): boolean => origin === 'autonomous' && config?.observe.autonomous === true

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

/** 写 `supervisor.observed_action` 并返回 `observe_not_executed`（写入失败时返回写入错误，同样未执行）。 */
export function recordObservedAction(
  ledger: Pick<LedgerStore, 'append'>,
  o: { workspace: string; wake_task_id: string; action: ObservedAction; args: unknown },
): Result<never> {
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
