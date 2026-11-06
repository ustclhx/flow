import {
  activeDelegation,
  isTerminalStatus,
  type LedgerEvent,
  type TaskView,
  taskStage,
} from '@raindown/core'
import type { LedgerStore } from './store.ts'

/** 从当前账本事实派生阶段；只供读取与渲染使用，不写投影。 */
export type TaskStageReader = Pick<LedgerStore, 'getTask' | 'taskEvents'>

/**
 * 终态任务没有阶段，直接返回 null，不读任何事件；未结束的任务只读一次该任务的事件，
 * 在同一份事件上计算当前有效委托与阶段。任务列表、收件箱列表与 Telegram `/inbox` 共用。
 */
export function readTaskStage(ledger: Pick<LedgerStore, 'taskEvents'>, task: TaskView) {
  if (isTerminalStatus(task.status)) return null
  return stageFromEvents(task, ledger.taskEvents(task.id))
}

/** 已持有该任务全部事件（按 seq 升序）时直接派生，不再读账本。 */
export function stageFromEvents(task: TaskView, events: readonly LedgerEvent[]) {
  return taskStage(task, activeDelegation(task, events), { events })
}
