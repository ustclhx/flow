import { z } from 'zod'
import { HubClient } from '../daemon/client.ts'
import { inboxOptions } from '../inbox/schema.ts'
import { taskId } from '../ledger/common.ts'
import { decisionPath } from '../ledger/events.ts'
import { createTaskRequest, DECISION_REVIEW_MAX, QUESTION_MAX } from '../ledger/protocol.ts'
import { prUrl } from '../ledger/task.ts'
import { fail, type Result } from '../result.ts'
import { SUPERVISOR_ACTOR } from '../roles.ts'
import { dateString } from '../schema/common.ts'
import { defineOperation, type OpContext } from './operation.ts'

/**
 * supervisor 的提问、任务提案与决策回看（design D7、D11；tasks 4.4、4.6、4.7）。
 *
 * 三个操作都**由中枢执行**：这里只做本地的身份预检并把请求交给中枢。中枢按唤醒绑定 token（D6）
 * 认定调用方是哪个唤醒、绑定哪个 workspace、origin 是什么，独立完成全部校验；本地预检只为了
 * 给其他 AI 身份一个明确的 `role_not_allowed`，不是安全边界。
 */

const supervisorOnly = (name: string, ctx: OpContext): Result<never> | null =>
  ctx.actor === SUPERVISOR_ACTOR
    ? null
    : fail('failure', 'role_not_allowed', `只有 supervisor 能调用 ${name}，当前为 ${ctx.actor}`)

const wsRef = (ws: string) => (ws.startsWith('ws/') ? ws : `ws/${ws}`)

export const askUserInput = z.strictObject({
  workspace: z.string().min(1).describe('workspace（ws/<id> 或 <id>），必须是本次唤醒绑定的'),
  question: z.string().trim().min(1).max(QUESTION_MAX).describe('提问全文'),
  options: inboxOptions
    .optional()
    .describe('可选的 2–4 个候选答复；用户在 Telegram / Web 上点选即以该选项答复'),
})
export type AskUserInput = z.infer<typeof askUserInput>

export const askUserOp = defineOperation({
  name: 'ask_user',
  cli: 'supervisor ask-user',
  summary: '经中枢向用户发一条提问（Decide 条目，可带 2–4 个选项）；不挂起本次唤醒',
  input: askUserInput,
  positional: ['workspace', 'question'],
  run: async (input: AskUserInput, ctx) => {
    const denied = supervisorOnly('ask_user', ctx)
    if (denied) return denied
    return new HubClient(ctx).askUser({
      workspace: wsRef(input.workspace),
      question: input.question,
      ...(input.options ? { options: input.options } : {}),
    })
  },
  human: ({ item }) => `已发出提问 #${item.short_id}：${item.title}`,
})

export const taskProposeInput = z.strictObject({
  draft: createTaskRequest.describe(
    '接受后要建的任务合同草稿：workspace 必须是本次唤醒绑定的，cwd / inputs.repo 在登记仓库内',
  ),
  reason: z.string().trim().min(1).max(2000).optional().describe('提案理由'),
  title: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe('决策标题；与 expected_outcome、metric、review_date 同时给出时，接受后记录一条决策'),
  expected_outcome: z.string().trim().min(1).max(2000).optional().describe('预期效果'),
  metric: z.string().trim().min(1).max(2000).optional().describe('衡量指标'),
  review_date: dateString.optional().describe('回看日期 YYYY-MM-DD：晚于今天，且不超过 180 天'),
})
export type TaskProposeInput = z.infer<typeof taskProposeInput>

const DECISION_FIELDS = ['title', 'expected_outcome', 'metric', 'review_date'] as const

export const taskProposeOp = defineOperation({
  name: 'task_propose',
  cli: 'supervisor propose',
  summary: '经中枢提交任务提案，由用户在收件箱接受后才建任务；可附决策与回看日期',
  input: taskProposeInput,
  fileInput: true,
  run: async (input: TaskProposeInput, ctx) => {
    const denied = supervisorOnly('task_propose', ctx)
    if (denied) return denied
    const given = DECISION_FIELDS.filter((k) => input[k] !== undefined)
    if (given.length > 0 && given.length < DECISION_FIELDS.length) {
      const missing = DECISION_FIELDS.filter((k) => input[k] === undefined)
      return fail(
        'usage',
        'invalid_arguments',
        `决策字段需同时给出 title、expected_outcome、metric、review_date，缺少 ${missing.join('、')}`,
        missing.map((field) => ({ field, code: 'missing_field', message: `缺少 ${field}` })),
      )
    }
    const { title, expected_outcome, metric, review_date } = input
    return new HubClient(ctx).proposeTask({
      draft: input.draft,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(title && expected_outcome && metric && review_date
        ? { decision: { title, expected_outcome, metric, review_date } }
        : {}),
    })
  },
  human: ({ proposal_id, item }) => `已提交任务提案 ${proposal_id}（条目 #${item.short_id}）`,
})

export const decisionReviewInput = z.strictObject({
  path: decisionPath.describe('本次回看唤醒关联的决策路径（decision.review_due 的 path）'),
  text: z
    .string()
    .trim()
    .min(1)
    .max(DECISION_REVIEW_MAX)
    .describe('回看结论：是否达到预期效果、指标表现、后续建议'),
})
export type DecisionReviewInput = z.infer<typeof decisionReviewInput>

export const decisionReviewOp = defineOperation({
  name: 'decision_review',
  cli: 'supervisor review-decision',
  summary: '经中枢为本次回看唤醒关联的决策追加回看结论，并把状态改为 reviewed',
  input: decisionReviewInput,
  positional: ['path', 'text'],
  run: async (input: DecisionReviewInput, ctx) => {
    const denied = supervisorOnly('decision_review', ctx)
    if (denied) return denied
    return new HubClient(ctx).reviewDecision(input)
  },
  human: (o) => `已回看决策 ${o.path}（${o.last_verified}，提交 ${o.sha.slice(0, 8)}）`,
})

export const prMergeRequestInput = z.strictObject({
  pr: prUrl.describe('要合并的 PR 链接：必须是本 workspace 指令链上任务开出的 PR'),
  review_task: taskId.describe('给出 approve 结论的审查任务 id（必须是该 PR 最新一次可信审查）'),
})
export type PrMergeRequestInput = z.infer<typeof prMergeRequestInput>

export const prMergeRequestOp = defineOperation({
  name: 'pr_merge_request',
  cli: 'supervisor merge-request',
  summary:
    '经中枢请求合并已审查通过的 PR：资格由中枢按账本核对；auto_merge 时直接建 merger 任务，否则生成合并审批条目',
  input: prMergeRequestInput,
  positional: ['pr', 'review_task'],
  run: async (input: PrMergeRequestInput, ctx) => {
    const denied = supervisorOnly('pr_merge_request', ctx)
    if (denied) return denied
    return new HubClient(ctx).requestMerge(input)
  },
  human: (o) =>
    o.mode === 'auto'
      ? `已建 merger 任务 ${o.task?.id ?? ''}（合并请求 ${o.request_id}）`
      : `已提交合并请求 ${o.request_id}，等待用户批准（条目 #${o.item?.short_id ?? ''}）`,
})
