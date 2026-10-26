import {
  acceptProposals,
  fail,
  type InboxActRequest,
  type InboxItemView,
  type InboxVia,
  inboxItemRef,
  ok,
  type Result,
  rejectProposals,
} from '@flow/core'
import type { LedgerStore } from '../ledger/store.ts'
import type { TaskService } from '../ledger/tasks.ts'
import { answerQuestion } from '../supervisor-tools/questions.ts'

/**
 * 任务提案条目（`source: task_proposal`）的接受与驳回（design D11；tasks 4.6）。
 * 中枢里由 `supervisor-tools/task-proposals.ts` 实现；身份已由 `actOnInbox` 核对为 user。
 */
export interface TaskProposalHandler {
  accept(item: InboxItemView, opts: { goal?: string; via: InboxVia }): Promise<Result<unknown>>
  reject(item: InboxItemView, opts: { note?: string; via: InboxVia }): Result<unknown>
}

/**
 * 合并请求条目（`source: merge_request`）的批准与驳回（design D10；tasks 4.8 实现）。
 * 批准由中枢以 hub 身份建 merger 任务并写 `merge_request.approved`；驳回唤醒 supervisor。
 * 本组（4.5）只留接口：未注入时这两个操作返回 `action_not_available`。
 */
export interface MergeRequestHandler {
  approve(item: InboxItemView, opts: { via: InboxVia }): Promise<Result<unknown>>
  reject(item: InboxItemView, opts: { note?: string; via: InboxVia }): Promise<Result<unknown>>
}

export interface InboxActionDeps {
  ledger: LedgerStore
  tasks: TaskService
  home: string
  /** 接受或拒绝成功后通知扫描器；关闭仍由扫描器根据归档状态决定。 */
  scanProposals(): Promise<void>
  /** 任务提案的接受与驳回；未注入时这两个操作不可用。 */
  taskProposals?: TaskProposalHandler
  /** 合并请求的批准与驳回（4.8）；未注入时这两个操作不可用。 */
  mergeRequests?: MergeRequestHandler
}

/** 统一的条目操作入口，HTTP 与中枢内渠道共用；身份由调用方的认证边界提供。 */
export async function actOnInbox(
  deps: InboxActionDeps,
  id: string,
  input: InboxActRequest,
  actor: string,
  /** 唤醒绑定 token 认定的调用方（D6）：只能作用于绑定的 workspace。 */
  binding?: { workspace: string },
): Promise<Result<{ item: InboxItemView }>> {
  const { ledger, tasks, home } = deps
  if (actor !== 'user' && input.action !== 'dismiss') {
    return fail('failure', 'user_only', '只有用户本人可以处理收件箱条目')
  }
  if (!inboxItemRef.safeParse(id).success) {
    return fail('usage', 'invalid_arguments', '条目 id 不合法')
  }
  const item = ledger.getInboxItem(id)
  if (!item) return fail('failure', 'not_found', '收件箱条目不存在')
  if (binding && item.workspace !== binding.workspace) {
    return fail('failure', 'workspace_mismatch', '本次唤醒不能处理其他 workspace 的条目')
  }
  if (actor !== 'user' && item.created_by !== actor) {
    return fail('failure', 'user_only', '只能忽略自己发起的条目')
  }
  if (item.state === 'closed') return fail('failure', 'item_closed', '收件箱条目已关闭')
  const { action, text } = input
  const via = input.via ?? 'cli'
  if (action === 'dismiss') {
    const result = ledger.append(
      {
        type: 'inbox.item_closed',
        ...(item.task_id ? { task_id: item.task_id } : {}),
        ...(item.workspace ? { workspace: item.workspace } : {}),
        payload: { item_id: item.id, reason: 'dismissed', cause_actor: actor, via },
      },
      { actor },
    )
    if (!result.ok) return result
  } else {
    if (!item.actions.includes(action)) {
      return fail('failure', 'action_not_available', '条目不支持该操作', { action })
    }
    if (input.goal !== undefined && !(item.source === 'task_proposal' && action === 'accept')) {
      return fail('usage', 'invalid_arguments', 'goal 只能用于接受任务提案')
    }
    // 按条目来源路由：各来源的操作与自动关闭规则互不复用（inbox spec "任务提案与合并审批来源"）。
    switch (item.source) {
      case 'task': {
        if (
          item.task_id === null ||
          (action !== 'approve' && action !== 'deny' && action !== 'reply')
        ) {
          return fail('failure', 'action_not_available', '条目未关联可回复的任务')
        }
        const result = tasks.replyTask(
          item.task_id,
          { kind: action === 'reply' ? 'text' : action, ...(text ? { text } : {}) },
          { actor, via },
        )
        if (!result.ok) return result
        break
      }
      case 'supervisor': {
        // supervisor 提问：条目以 answered 关闭并写 supervisor.answered（D11）。
        if (action !== 'reply') return fail('failure', 'action_not_available', '提问只能答复')
        const result = answerQuestion(ledger, item, text, via)
        if (!result.ok) return result
        break
      }
      case 'task_proposal': {
        if (!deps.taskProposals) {
          return fail('failure', 'action_not_available', '任务提案处理尚未启用')
        }
        const result =
          action === 'accept'
            ? await deps.taskProposals.accept(item, {
                ...(input.goal ? { goal: input.goal } : {}),
                via,
              })
            : action === 'reject'
              ? deps.taskProposals.reject(item, { ...(text ? { note: text } : {}), via })
              : fail('failure', 'action_not_available', '任务提案只能接受或驳回')
        if (!result.ok) return result
        break
      }
      case 'merge_request': {
        if (!deps.mergeRequests) {
          return fail('failure', 'action_not_available', '合并审批尚未启用（tasks 4.8）')
        }
        const result =
          action === 'approve'
            ? await deps.mergeRequests.approve(item, { via })
            : action === 'reject'
              ? await deps.mergeRequests.reject(item, { ...(text ? { note: text } : {}), via })
              : fail('failure', 'action_not_available', '合并请求只能批准或驳回')
        if (!result.ok) return result
        break
      }
      case 'proposal': {
        if (action !== 'accept' && action !== 'reject') {
          return fail('failure', 'action_not_available', '条目未关联提案')
        }
        const selection = { ids: [item.source_ref] }
        const result =
          action === 'accept'
            ? await acceptProposals(home, selection, { actor, via })
            : await rejectProposals(
                home,
                { ...selection, ...(text ? { reason: text } : {}) },
                { actor, via },
              )
        if (!result.ok) return result
        const outcome = result.data.results[0]
        if (outcome?.error) return { ok: false, error: outcome.error }
        if (!outcome || outcome.status !== (action === 'accept' ? 'accepted' : 'rejected')) {
          return fail('failure', 'internal_error', '提案处理未成功')
        }
        await deps.scanProposals()
        break
      }
      default:
        return fail('failure', 'action_not_available', '条目不支持该操作', { action })
    }
  }
  return ok({ item: ledger.getInboxItem(item.id) ?? item })
}
