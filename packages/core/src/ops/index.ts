import { briefUpdateOp } from './brief.ts'
import { inboxActOp, inboxListOp } from './inbox.ts'
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
import {
  askUserOp,
  decisionReviewOp,
  patrolReportOp,
  prMergeRequestOp,
  taskProposeOp,
  taskRespondOp,
} from './supervisor.ts'
import { taskCancelOp, taskCreateOp, taskListOp, taskReplyOp, taskShowOp } from './tasks.ts'
import { resourceTransferOp, wsBriefOp, wsListOp, wsResourcesOp } from './workspace.ts'

export * from './binding.ts'
export * from './brief.ts'
export * from './inbox.ts'
export * from './journal.ts'
export * from './operation.ts'
export * from './proposals.ts'
export * from './search.ts'
export * from './supervisor.ts'
export * from './tasks.ts'
export * from './workspace.ts'

/**
 * 全部知识访问操作。CLI 与 MCP 都遍历这个列表生成命令与工具；
 * 新增操作时在 `ops/` 下新建文件并在此追加。
 */
export const operations = [
  inboxListOp,
  inboxActOp,
  taskCreateOp,
  taskListOp,
  taskShowOp,
  taskCancelOp,
  taskReplyOp,
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
  briefUpdateOp,
  askUserOp,
  taskProposeOp,
  decisionReviewOp,
  patrolReportOp,
  prMergeRequestOp,
  taskRespondOp,
] as Operation<never, unknown>[]
