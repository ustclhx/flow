import { captureOp, kbJournalOp } from './journal.ts'
import type { Operation } from './operation.ts'
import {
  kbProposalsAcceptOp,
  kbProposalsDiffOp,
  kbProposalsListOp,
  kbProposalsRejectOp,
  kbProposeOp,
} from './proposals.ts'
import { kbGetOp, kbQueryOp, kbSearchOp } from './search.ts'
import { taskCancelOp, taskCreateOp, taskListOp, taskShowOp } from './tasks.ts'
import { resourceTransferOp, wsBriefOp, wsListOp, wsResourcesOp } from './workspace.ts'

export * from './journal.ts'
export * from './operation.ts'
export * from './proposals.ts'
export * from './search.ts'
export * from './tasks.ts'
export * from './workspace.ts'

/**
 * 全部知识访问操作。CLI 与 MCP 都遍历这个列表生成命令与工具；
 * 新增操作时在 `ops/` 下新建文件并在此追加。
 */
export const operations = [
  taskCreateOp,
  taskListOp,
  taskShowOp,
  taskCancelOp,
  kbJournalOp,
  captureOp,
  kbSearchOp,
  kbGetOp,
  kbQueryOp,
  kbProposeOp,
  kbProposalsListOp,
  kbProposalsDiffOp,
  kbProposalsAcceptOp,
  kbProposalsRejectOp,
  wsListOp,
  wsResourcesOp,
  resourceTransferOp,
  wsBriefOp,
] as Operation<never, unknown>[]
