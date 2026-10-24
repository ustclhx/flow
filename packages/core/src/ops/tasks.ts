import { z } from 'zod'
import { HubClient } from '../daemon/client.ts'
import { renderTable } from '../format/table.ts'
import { taskId } from '../ledger/common.ts'
import { cancelTaskRequest, listTasksQuery } from '../ledger/protocol.ts'
import { type TaskContractInput, type TaskView, taskContract } from '../ledger/task.ts'
import { fail } from '../result.ts'
import { loadRoles } from '../roles.ts'
import { defineOperation, type OpContext } from './operation.ts'

const client = (ctx: OpContext) => new HubClient(ctx)
const taskSummary = (task: TaskView) =>
  `${task.id} — ${task.status}\n目标：${task.contract.goal}\nWorkspace：${task.workspace}`

export const taskCreateOp = defineOperation({
  name: 'task_create',
  cli: 'task create',
  summary: '向中枢提交任务合同',
  input: taskContract,
  fileInput: true,
  run: async (input: TaskContractInput, ctx) => {
    const loaded = await loadRoles(ctx.home)
    if (!loaded.ok) return loaded
    if (!loaded.data.roles.some((role) => role.name === input.role)) {
      return fail('failure', 'unknown_role', `角色 ${input.role} 未定义`, {
        field: 'role',
        role: input.role,
        errors: loaded.data.errors,
      })
    }
    // 合同中的 executor 优先于角色配置，允许不一致；覆盖记录留待启动执行器时写入 task.started。
    return client(ctx).createTask(input)
  },
  human: ({ task, created }) => `${created ? '已创建' : '已有任务'}：${taskSummary(task)}`,
})

export const taskListOp = defineOperation({
  name: 'task_list',
  cli: 'task list',
  summary: '按 workspace 和状态列出任务',
  input: listTasksQuery,
  run: (input: z.input<typeof listTasksQuery>, ctx) => client(ctx).listTasks(input),
  human: ({ tasks }) =>
    renderTable(tasks, [
      { header: 'ID', value: (t) => t.id },
      { header: 'Workspace', value: (t) => t.workspace },
      { header: '状态', value: (t) => t.status },
      { header: '目标', value: (t) => t.contract.goal, max: 60 },
    ]),
})

export const taskShowOp = defineOperation({
  name: 'task_show',
  cli: 'task show',
  summary: '查看任务合同、结果与事件',
  input: z.strictObject({ id: taskId }),
  positional: ['id'],
  run: (input: { id: string }, ctx) => client(ctx).showTask(input.id),
  human: ({ task, events }) =>
    [
      taskSummary(task),
      `合同：${JSON.stringify(task.contract, null, 2)}`,
      ...(task.blocked ? [`卡住原因：${task.blocked.reason} — ${task.blocked.message}`] : []),
      ...(task.result
        ? [
            `结果：${task.result.summary}`,
            `产物：${task.result.artifacts.map((a) => a.ref).join('、') || '（无）'}`,
            ...task.result.verify.map((v) => `验收：${v.cmd.join(' ')} → 退出码 ${v.exit_code}`),
          ]
        : []),
      `事件：${JSON.stringify(events, null, 2)}`,
    ].join('\n'),
})

export const taskCancelOp = defineOperation({
  name: 'task_cancel',
  cli: 'task cancel',
  summary: '取消尚未结束的任务',
  input: cancelTaskRequest.extend({ id: taskId }),
  positional: ['id'],
  run: (input: { id: string; reason?: string }, ctx) => {
    const { id, ...body } = input
    return client(ctx).cancelTask(id, body)
  },
  human: ({ task }) => `${task.cancel_requested ? '已请求取消' : '已取消'}：${taskSummary(task)}`,
})
