import { HubClient } from '../daemon/client.ts'
import { type WorkerReportInput, workerReportInput } from '../ledger/worker-report.ts'
import { fail } from '../result.ts'
import { defineOperation } from './operation.ts'

/** 上报属于绑定身份操作：只转交中枢，由派工令牌核定任务与当前派工。 */
export const raindownReportOp = defineOperation({
  name: 'raindown_report',
  cli: 'report',
  summary: '向中枢结构化上报本次派工的进展、问题或结果；需要当前派工令牌',
  input: workerReportInput,
  positional: ['status', 'summary'],
  fileInput: true,
  run: async (input: WorkerReportInput, ctx) => {
    const { id, ...report } = input
    const task = id ?? (ctx.binding?.kind === 'task' ? ctx.binding.task : undefined)
    if (!task) return fail('failure', 'forbidden', '上报需要绑定当前派工的任务')
    return new HubClient(ctx).request('tasks-report', report, task)
  },
})
