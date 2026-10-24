import {
  acceptProposals,
  fail,
  type InboxActRequest,
  type InboxItemView,
  inboxItemRef,
  ok,
  type Result,
  rejectProposals,
} from '@flow/core'
import type { LedgerStore } from '../ledger/store.ts'
import type { TaskService } from '../ledger/tasks.ts'

export interface InboxActionDeps {
  ledger: LedgerStore
  tasks: TaskService
  home: string
  /** 接受或拒绝成功后通知扫描器；关闭仍由扫描器根据归档状态决定。 */
  scanProposals(): Promise<void>
}

/** 统一的条目操作入口，HTTP 与中枢内渠道共用；身份由调用方的认证边界提供。 */
export async function actOnInbox(
  deps: InboxActionDeps,
  id: string,
  input: InboxActRequest,
  actor: string,
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
    if (action === 'approve' || action === 'deny' || action === 'reply') {
      if (item.source !== 'task' || item.task_id === null) {
        return fail('failure', 'action_not_available', '条目未关联可回复的任务')
      }
      const result = tasks.replyTask(
        item.task_id,
        { kind: action === 'reply' ? 'text' : action, ...(text ? { text } : {}) },
        { actor, via },
      )
      if (!result.ok) return result
    } else {
      if (item.source !== 'proposal') {
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
    }
  }
  return ok({ item: ledger.getInboxItem(item.id) ?? item })
}
