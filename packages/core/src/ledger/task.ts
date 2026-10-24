import { z } from 'zod'
import { workspaceRef } from '../schema/common.ts'
import {
  capability,
  executorCapability,
  executorType,
  leaseId,
  nodeId,
  taskId,
  timestamp,
} from './common.ts'

/**
 * 任务合同、任务结果、状态与状态机（task-ledger spec）。
 */

// ---------------------------------------------------------------------------
// 状态与卡住原因
// ---------------------------------------------------------------------------

export const TASK_STATUSES = [
  'queued',
  'running',
  'verifying',
  'done',
  'failed',
  'blocked',
  'cancelled',
] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]
export const taskStatus = z.enum(TASK_STATUSES).meta({ description: '任务状态' })

/** 终态：不再发生任何转换。 */
export const TERMINAL_STATUSES = ['done', 'failed', 'cancelled'] as const satisfies TaskStatus[]
export const isTerminalStatus = (s: TaskStatus): boolean =>
  (TERMINAL_STATUSES as readonly TaskStatus[]).includes(s)

export const BLOCKED_REASONS = [
  'awaiting_approval',
  'question',
  'no_progress',
  'crashed',
  'node_lost',
  'other',
] as const
export type BlockedReason = (typeof BLOCKED_REASONS)[number]
export const blockedReason = z.enum(BLOCKED_REASONS).meta({
  description:
    '卡住原因：awaiting_approval 等审批、question 提问、no_progress 无进展、crashed 崩溃、node_lost 节点掉线（租约过期）、other 其他',
})

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

/**
 * 状态转换表（task-ledger spec "状态机"）：
 * - queued → running
 * - running → verifying | done | failed | blocked
 * - verifying → done | failed | blocked
 * - blocked → queued | running | cancelled | failed
 * - 任何非终态 → cancelled
 *
 * 另加 `running | verifying → queued`：仅用于"允许重试的任务租约过期后重新排队"
 * （node-protocol spec "租约过期处理"），只能由 `task.requeued`（reason=lease_expired）触发。
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ['running', 'cancelled'],
  running: ['verifying', 'done', 'failed', 'blocked', 'cancelled', 'queued'],
  verifying: ['done', 'failed', 'blocked', 'cancelled', 'queued'],
  blocked: ['queued', 'running', 'cancelled', 'failed'],
  done: [],
  failed: [],
  cancelled: [],
}

/** 状态图中是否存在 `from → to` 这条边（不考虑由哪种事件触发）。 */
export const canTransition = (from: TaskStatus, to: TaskStatus): boolean =>
  TASK_TRANSITIONS[from].includes(to)

// ---------------------------------------------------------------------------
// 活动（节点续约时批量上报，见 events.ts 中关于不入账本的说明）
// ---------------------------------------------------------------------------

export const ACTIVITY_KINDS = ['output', 'status', 'heartbeat'] as const
export const activity = z
  .object({
    ts: timestamp,
    kind: z.enum(ACTIVITY_KINDS).meta({
      description: 'output 输出片段、status 状态提示、heartbeat 执行器心跳（无内容）',
    }),
    text: z.string().max(16_384).optional().meta({ description: '输出片段或状态说明' }),
    data: z
      .record(z.string(), z.unknown())
      .optional()
      .meta({ description: '执行器专用的结构化信息' }),
  })
  .meta({ title: 'Task activity', description: '执行器上报的一条活动' })
export type Activity = z.infer<typeof activity>

// ---------------------------------------------------------------------------
// 任务合同
// ---------------------------------------------------------------------------

export const verifyStep = z
  .strictObject({
    cmd: z
      .array(z.string())
      .min(1)
      .meta({ description: '命令 argv 数组（不经 shell），例如 ["bun", "test"]' }),
    cwd: z.string().min(1).optional().meta({ description: '工作目录；缺省为任务的 cwd' }),
    timeout_s: z
      .number()
      .int()
      .positive()
      .optional()
      .meta({ description: '单条命令超时秒数，缺省为 600（10 分钟）' }),
  })
  .meta({ title: 'Verify step', description: '一条验收命令' })
export type VerifyStep = z.infer<typeof verifyStep>

/**
 * fake 执行器脚本的一步（add-m1-executors 1.2：覆盖卡住检测的各种情形）。按顺序执行：
 * - `output`：上报一条输出（kind=output）；
 * - `wait`：等待若干毫秒（期间没有任何活动，可用来触发无进展计时）；
 * - `idle`：上报"worker 停下了"的信号（status 活动，`data.idle=true`，可附带 hint），
 *   节点随即调用执行器的 `classify` 判定卡住原因；
 * - `await_reply`：等待节点送达回复（`deliver`），收到后上报一条"收到回复"的输出；
 * - `resumed`：上报"worker 自行恢复"的信号（`data.resumed=true`）；
 * - `exit`：模拟进程意外退出（附退出码），执行到此结束；
 * - `hang`：永远不结束；`ignore_cancel` 为 true 时连取消也不理会（测试超时强制结束）。
 */
export const fakeStep = z
  .discriminatedUnion('do', [
    z.strictObject({ do: z.literal('output'), text: z.string() }),
    z.strictObject({ do: z.literal('wait'), ms: z.number().int().min(0).max(86_400_000) }),
    z.strictObject({
      do: z.literal('idle'),
      hint: z
        .record(z.string(), z.unknown())
        .optional()
        .meta({ description: '随 idle 信号附带的结构化信息，交给 classify' }),
    }),
    z.strictObject({ do: z.literal('await_reply') }),
    z.strictObject({ do: z.literal('resumed') }),
    z.strictObject({
      do: z.literal('exit'),
      code: z.number().int().nullable().meta({ description: '退出码；被信号终止时为 null' }),
      signal: z.string().min(1).optional(),
    }),
    z.strictObject({ do: z.literal('hang'), ignore_cancel: z.boolean().default(false) }),
  ])
  .meta({ title: 'Fake executor step' })
export type FakeStep = z.infer<typeof fakeStep>

const fakeShape = {
  outcome: z
    .enum(['done', 'failed', 'blocked'])
    .default('done')
    .meta({ description: '模拟的结束方式' }),
  delay_ms: z
    .number()
    .int()
    .min(0)
    .max(86_400_000)
    .default(0)
    .meta({ description: '结束前等待的毫秒数，用于模拟长时间运行' }),
  blocked_reason: blockedReason
    .optional()
    .meta({ description: 'outcome=blocked 时必填的卡住原因' }),
  message: z
    .string()
    .min(1)
    .optional()
    .meta({ description: '卡住或失败时的说明；done 时作为结果摘要' }),
  activity: z
    .array(z.string())
    .max(1000)
    .default([])
    .meta({ description: '执行期间依次上报的输出片段（kind=output）' }),
  script: z
    .array(fakeStep)
    .max(1000)
    .optional()
    .meta({ description: '在 activity / delay_ms 之前依次执行的脚本步骤' }),
  session: z
    .string()
    .min(1)
    .optional()
    .meta({ description: '以 blocked 结束时上报的会话 id（模拟无头执行器的 resume）' }),
  deliver_failures: z
    .number()
    .int()
    .min(0)
    .max(1_000_000)
    .optional()
    .meta({ description: 'deliver 前 N 次抛出异常（模拟临时送达失败）' }),
  deliver_hangs: z
    .number()
    .int()
    .min(0)
    .max(1_000_000)
    .optional()
    .meta({ description: 'deliver 前 N 次永不返回（模拟卡死的送达）' }),
  deliver_delay_ms: z
    .number()
    .int()
    .min(0)
    .max(86_400_000)
    .optional()
    .meta({ description: 'deliver 耗时（毫秒），模拟缓慢的送达' }),
}

type FakeOutcomeFields = { outcome: string; blocked_reason?: unknown }
const checkBlockedReason = (v: FakeOutcomeFields, ctx: z.RefinementCtx) => {
  if (v.outcome === 'blocked' && v.blocked_reason === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['blocked_reason'],
      message: 'outcome 为 blocked 时必须提供 blocked_reason',
    })
  }
  if (v.outcome !== 'blocked' && v.blocked_reason !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['blocked_reason'],
      message: '只有 outcome 为 blocked 时才能提供 blocked_reason',
    })
  }
}

/** 带回复恢复执行（`resume`）时 fake 执行器的行为；缺省为 done，摘要中带上会话 id 与回复。 */
export const fakeResumeInputs = z
  .strictObject(fakeShape)
  .superRefine(checkBlockedReason)
  .meta({ title: 'Fake executor resume inputs' })

/** fake 执行器的指令（design D11）；只在 `executor === 'fake'` 时允许。 */
export const fakeInputs = z
  .strictObject({
    ...fakeShape,
    resume: fakeResumeInputs
      .optional()
      .meta({ description: '任务带着回复重新排队后，下一次执行改按这里的指令' }),
  })
  .superRefine(checkBlockedReason)
  .meta({ title: 'Fake executor inputs' })
export type FakeInputs = z.infer<typeof fakeInputs>
export type FakeResumeInputs = z.infer<typeof fakeResumeInputs>

/** 无进展阈值的默认分钟数（stuck-detection "无进展超时"）。 */
export const DEFAULT_NO_PROGRESS_MINUTES = 15

export const DEFAULT_TIMEOUT_S = 3600

export const taskContract = z
  .strictObject({
    goal: z.string().trim().min(1).meta({ description: '任务目标' }),
    workspace: workspaceRef,
    role: z.string().min(1).meta({ description: '角色，例如 developer、reviewer、triage' }),
    executor: executorType,
    requires: z.array(capability).default([]).meta({
      description: '所需节点能力；匹配时 executor:<executor> 视为隐含必需，不必重复写出',
    }),
    cwd: z.string().min(1).optional().meta({ description: '工作目录（节点上的绝对路径）' }),
    context: z
      .array(z.string().min(1))
      .optional()
      .meta({ description: '上下文引用：brain 条目 id 或文件路径' }),
    verify: z.array(verifyStep).optional().meta({ description: '验收命令，按顺序执行' }),
    timeout_s: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_TIMEOUT_S)
      .meta({ description: '单次尝试的超时秒数，默认 3600' }),
    no_progress_minutes: z.number().positive().max(10_080).optional().meta({
      description:
        '无进展阈值（分钟）：执行器这么久没有任何新活动即上报 blocked(no_progress)；缺省取角色设置，再缺省为 15',
    }),
    retry: z
      .strictObject({
        max_attempts: z
          .number()
          .int()
          .min(1)
          .max(100)
          .meta({ description: '最多尝试次数（含第一次）；1 等同于不重试' }),
      })
      .optional()
      .meta({ description: '重试策略；缺省为不重试（执行器可能已有副作用）' }),
    parent: taskId.optional().meta({ description: '父任务 id' }),
    idempotency_key: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .meta({ description: '幂等键：同一个键再次提交时返回已有任务' }),
    inputs: z
      .looseObject({ fake: fakeInputs.optional() })
      .optional()
      .meta({ description: '执行器专用输入，按执行器类型取用；inputs.fake 仅 executor=fake 可用' }),
  })
  .superRefine((c, ctx) => {
    if (c.inputs?.fake !== undefined && c.executor !== 'fake') {
      ctx.addIssue({
        code: 'custom',
        path: ['inputs', 'fake'],
        message: 'inputs.fake 只允许在 executor 为 fake 时使用',
      })
    }
  })
  .meta({ title: 'Flow task contract', description: '创建任务时提交的合同' })

/** 合同（已补默认值）。 */
export type TaskContract = z.infer<typeof taskContract>
/** 合同（调用方提交的形态，默认值字段可省略）。 */
export type TaskContractInput = z.input<typeof taskContract>

/** 合同要求的全部能力：显式 requires 加上隐含的 `executor:<executor>`，去重后排序。 */
export function requiredCapabilities(contract: Pick<TaskContract, 'executor' | 'requires'>) {
  return [...new Set([...contract.requires, executorCapability(contract.executor)])].sort()
}

/** 节点能力是否满足合同：所需能力必须是节点能力的子集（node-protocol spec）。 */
export function capabilitiesSatisfy(
  nodeCapabilities: readonly string[],
  contract: Pick<TaskContract, 'executor' | 'requires'>,
): boolean {
  const have = new Set(nodeCapabilities)
  return requiredCapabilities(contract).every((c) => have.has(c))
}

// ---------------------------------------------------------------------------
// 任务结果
// ---------------------------------------------------------------------------

export const ARTIFACT_KINDS = ['file', 'pr', 'commit', 'url', 'other'] as const
export const artifact = z
  .strictObject({
    kind: z.enum(ARTIFACT_KINDS),
    ref: z.string().min(1).meta({ description: '文件路径、PR 链接、提交 sha 或 URL' }),
    note: z.string().optional(),
  })
  .meta({ title: 'Task artifact' })
export type Artifact = z.infer<typeof artifact>

export const verifyOutcome = z
  .strictObject({
    cmd: z.array(z.string()).min(1).meta({ description: '执行的 argv' }),
    cwd: z.string().min(1).optional(),
    exit_code: z
      .number()
      .int()
      .nullable()
      .meta({ description: '退出码；被信号终止或超时时为 null' }),
    duration_ms: z.number().int().min(0),
    timed_out: z.boolean().default(false),
    output_tail: z
      .array(z.string())
      .max(200)
      .default([])
      .meta({ description: '合并 stdout/stderr 后的末尾若干行' }),
  })
  .meta({ title: 'Verify outcome', description: '一条验收命令的执行结果' })
export type VerifyOutcome = z.infer<typeof verifyOutcome>

/** 执行器上报的费用与用量（估算值，不是账单）。 */
export const taskCost = z
  .strictObject({
    usd: z.number().min(0).meta({ description: '估算费用（美元）' }),
    turns: z.number().int().min(0).optional().meta({ description: '模型往返轮数' }),
    duration_ms: z.number().int().min(0).optional(),
    input_tokens: z.number().int().min(0).optional(),
    output_tokens: z.number().int().min(0).optional(),
  })
  .meta({ title: 'Task cost', description: '执行器上报的费用与用量（估算）' })
export type TaskCost = z.infer<typeof taskCost>

export const taskResult = z
  .strictObject({
    summary: z.string().min(1).meta({ description: '结果摘要' }),
    artifacts: z.array(artifact).default([]),
    verify: z.array(verifyOutcome).default([]).meta({ description: '每条验收命令的结果' }),
    executor: executorType,
    node_id: nodeId,
    reason: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/)
      .optional()
      .meta({ description: '失败原因的机器可读码，例如 timeout（超过 timeout_s 被停止）' }),
    session: z.string().min(1).max(512).optional().meta({
      description: '执行器会话 id（例如 Claude Agent SDK 的 session_id），便于事后查看或恢复',
    }),
    cost: taskCost.optional(),
  })
  .meta({ title: 'Flow task result', description: '任务结束（done / failed）时的结果' })
export type TaskResult = z.infer<typeof taskResult>
export type TaskResultInput = z.input<typeof taskResult>

// ---------------------------------------------------------------------------
// 回复（task-interaction spec；design D7）
// ---------------------------------------------------------------------------

export const REPLY_KINDS = ['text', 'approve', 'deny'] as const
export type ReplyKind = (typeof REPLY_KINDS)[number]
export const replyKind = z.enum(REPLY_KINDS).meta({
  description: 'text 文字回复；approve 批准；deny 拒绝（可以附带理由）',
})

export const replyId = z
  .string()
  .regex(/^r-[A-Za-z0-9_.-]{1,64}$/, '回复 id 形如 r-<随机串>')
  .meta({ description: '回复 id，由中枢在收到回复时分配' })

/** 回复的状态：pending 待送达；delivered 已送进运行中的 worker；requeued 随重新排队附到下一次执行；dropped 任务已不再等待它。 */
export const REPLY_STATES = ['pending', 'delivered', 'requeued', 'dropped'] as const
export const replyState = z.enum(REPLY_STATES)

/** 送达给执行器的回复。 */
export const deliveredReply = z
  .object({
    reply_id: replyId,
    kind: replyKind,
    text: z.string().optional(),
    by: z.string().meta({ description: '回复者（task.replied 的 actor）' }),
  })
  .meta({ title: 'Task reply', description: '待送达给执行器的一条回复' })
export type DeliveredReply = z.infer<typeof deliveredReply>

export const replyView = z
  .object({
    id: replyId,
    task_id: taskId,
    kind: replyKind,
    text: z.string().nullable(),
    by: z.string(),
    created_at: timestamp,
    state: replyState,
    delivered_at: timestamp.nullable().meta({ description: '送达或随重新排队附上的时间' }),
  })
  .meta({ title: 'Task reply view' })
export type ReplyView = z.infer<typeof replyView>

/** 带回复重新排队后，下一次执行要带上的恢复信息（design D6、D7）。 */
export const taskResume = z
  .object({
    reply: deliveredReply,
    session: z.string().optional().meta({ description: '上一轮卡住时执行器上报的会话 id' }),
  })
  .meta({ title: 'Task resume', description: '下一次执行据此恢复（例如 codex exec resume）' })
export type TaskResume = z.infer<typeof taskResume>

// ---------------------------------------------------------------------------
// 任务视图（tasks 投影对外的形态，用于 API 响应）
// ---------------------------------------------------------------------------

export const taskView = z
  .object({
    id: taskId,
    workspace: workspaceRef,
    status: taskStatus,
    contract: taskContract,
    attempt: z.number().int().min(0).meta({ description: '已开始的尝试次数（task.started 次数）' }),
    created_at: timestamp,
    updated_at: timestamp,
    started_at: timestamp.nullable().meta({ description: '最近一次开始执行的时间' }),
    finished_at: timestamp.nullable().meta({ description: '进入终态的时间' }),
    cancel_requested: z.boolean(),
    blocked: z
      .object({
        reason: blockedReason,
        message: z.string(),
        tail: z.array(z.string()).optional(),
        session: z.string().optional().meta({ description: '执行器上报的会话 id（用于恢复）' }),
        prior_reason: blockedReason.optional().meta({ description: 'node_lost 之前的卡住原因' }),
        lease_held: z
          .boolean()
          .meta({ description: 'true 表示节点仍持有租约、worker 还活着（交互式执行器，D7a）' }),
      })
      .nullable()
      .meta({ description: '当前处于 blocked 时的原因与说明' }),
    lease: z
      .object({ lease_id: leaseId, node_id: nodeId, expires_at: timestamp })
      .nullable()
      .meta({ description: '当前有效的租约' }),
    result: taskResult.nullable(),
    created_by: z.string().meta({ description: '创建者（task.created 的 actor）' }),
    last_activity_at: timestamp
      .nullable()
      .meta({ description: '最近一次活动（续约上报）时间；非事件派生，重建后为 null' }),
  })
  .meta({ title: 'Flow task', description: '任务的当前状态（由事件投影得到）' })
export type TaskView = z.infer<typeof taskView>
