import { z } from 'zod'
import { HubClient } from '../daemon/client.ts'
import { renderTable } from '../format/table.ts'
import { taskId } from '../ledger/common.ts'
import { cancelTaskRequest, listTasksQuery, type ReplyTaskRequest } from '../ledger/protocol.ts'
import { type TaskContractInput, type TaskView, taskContract } from '../ledger/task.ts'
import { fail } from '../result.ts'
import { loadRoles } from '../roles.ts'
import { USER_ACTOR } from '../write/policy.ts'
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

/**
 * `task_reply`（task-interaction "回复卡住的任务"）：文字回复、`--approve` 或 `--deny`（可附理由）。
 * 三者恰好选一种；`--deny` 可以同时给出文字作为理由。回复者即操作者（CLI 为 user，MCP 为其 actor）。
 */
export const taskReplyInput = z
  .strictObject({
    id: taskId,
    text: z
      .string()
      .trim()
      .min(1)
      .max(16_384)
      .optional()
      .meta({ description: '回复文字；与 deny 同时给出时作为拒绝理由' }),
    approve: z.boolean().optional().meta({ description: '批准等待中的授权请求' }),
    deny: z.boolean().optional().meta({ description: '拒绝等待中的授权请求' }),
  })
  .superRefine((v, ctx) => {
    if (v.approve && v.deny) {
      ctx.addIssue({ code: 'custom', path: ['deny'], message: 'approve 与 deny 只能选一个' })
    } else if (v.approve && v.text !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['text'], message: '批准时不能附带文字' })
    } else if (!v.approve && !v.deny && v.text === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['text'],
        message: '需要回复文字，或者 approve / deny',
      })
    }
  })
export type TaskReplyInput = z.infer<typeof taskReplyInput>

/** 操作输入 → 协议请求体。 */
export function replyRequestOf(input: TaskReplyInput): ReplyTaskRequest {
  if (input.approve) return { kind: 'approve' }
  if (input.deny) return { kind: 'deny', ...(input.text === undefined ? {} : { text: input.text }) }
  return { kind: 'text', text: input.text as string }
}

const userOnly = (actor: string) =>
  fail(
    'failure',
    'user_only',
    `只有用户本人（actor=user，经 CLI）可以回复卡住的任务，当前为 ${actor}`,
    {
      actor,
    },
  )

export const taskReplyOp = defineOperation({
  name: 'task_reply',
  cli: 'task reply',
  summary: '回复卡住的任务：文字、--approve 或 --deny（可附理由）',
  input: taskReplyInput,
  positional: ['id', 'text'],
  run: async (input: TaskReplyInput, ctx) => {
    // 防止 AI 自批：回复与审批只允许人（actor=user，经 CLI）。MCP 的调用方一定是 AI harness，
    // worker 可能借此批准自己的授权请求，所以一律拒绝。supervisor 代为答复留到变更 ④ 再放开
    // （届时由策略引擎决定哪些请求可以由 supervisor 答复）。中枢 /v1/tasks/:id/reply 同样校验 actor。
    if (ctx.via !== 'cli' || ctx.actor !== USER_ACTOR) return userOnly(ctx.actor)
    return client(ctx).replyTask(input.id, replyRequestOf(input))
  },
  human: ({ task, reply, requeued }) =>
    [
      `已回复（${reply.kind === 'approve' ? '批准' : reply.kind === 'deny' ? '拒绝' : '文字'}）：${taskSummary(task)}`,
      requeued ? '没有节点持有该任务，已带着回复重新排队。' : '回复将在节点下一次续约时送达。',
    ].join('\n'),
})
