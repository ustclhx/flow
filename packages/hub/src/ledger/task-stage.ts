import { type TaskView, taskStage } from '@raindown/core'
import type { LedgerStore } from './store.ts'

/** 从当前账本事实派生阶段；只供读取与渲染使用，不写投影。 */
export type TaskStageReader = Pick<LedgerStore, 'getTask' | 'activeDelegation' | 'taskEvents'>

export function readTaskStage(ledger: TaskStageReader, task: TaskView) {
  return taskStage(task, ledger.activeDelegation(task.id), { events: ledger.taskEvents(task.id) })
}
