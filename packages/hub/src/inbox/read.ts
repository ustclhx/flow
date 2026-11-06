import type { InboxItemData, InboxItemView } from '@raindown/core'
import { readTaskStage, type TaskStageReader } from '../ledger/task-stage.ts'

/** 条目持有任务引用，阶段在读取时取当前任务，避免保存创建时的旧阶段。 */
export function readInboxItem(ledger: TaskStageReader, item: InboxItemView): InboxItemData {
  if (!item.task_id) return item
  const task = ledger.getTask(item.task_id)
  return { ...item, task_stage: task ? readTaskStage(ledger, task) : null }
}
