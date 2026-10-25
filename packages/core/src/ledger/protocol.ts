import { z } from 'zod'
import { scheduleErrorSchema } from '../daemon/schedules.ts'
import { inboxActData, inboxActRequest, inboxListData, inboxListQuery } from '../inbox/schema.ts'
import { policyDecisionSchema } from '../policy/decide.ts'
import { workspaceRef } from '../schema/common.ts'
import { actor, capability, leaseId, nodeId, taskId, timestamp } from './common.ts'
import { executorInfo, ledgerEvent } from './events.ts'
import { PROTOCOL_MESSAGE_MAX, TAIL_LINE_MAX } from './redact.ts'
import {
  activity,
  blockedReason,
  deliveredReply,
  replyId,
  replyKind,
  replyView,
  taskContract,
  taskResult,
  taskResume,
  taskStatus,
  taskView,
} from './task.ts'

/**
 * 中枢 HTTP 协议（hub-daemon、node-protocol spec；design D3、D4）。
 *
 * 约定：
 * - 全部路径以 `/v1` 开头，只监听 127.0.0.1。
 * - 除 `GET /v1/health` 外都需要 `Authorization: Bearer <token>`。操作者由 token 决定（design D9）：
 *   `state/hub.token` 是 user，可用 `X-Flow-Actor` 降级声明非 user 身份；绑定 token 的身份固定，
 *   请求头与之不一致时返回 403 `actor_mismatch`。
 * - 成功响应：`{ ok: true, data }`；失败响应与 CLI `--json` 一致：
 *   `{ ok: false, error: { kind, code, message, details?, retryable } }`（见 `toJsonDocument`）。
 * - 请求体与响应 `data` 都用这里的 zod 定义校验，并导出到 `schemas/protocol/`。
 */

export const PROTOCOL_VERSION = 'v1'

/**
 * 节点上报的卡住说明与末尾输出的上限（PR #16 复核第 1 条）：超长的请求直接被 zod 拒绝，
 * 不让任意大小的文本进入中枢的同步写事务。节点上报前用 `clipTail` 截断。
 */
const blockedMessage = z.string().min(1).max(PROTOCOL_MESSAGE_MAX)
const blockedTail = z
  .array(z.string().max(TAIL_LINE_MAX))
  .max(200)
  .optional()
  .meta({ description: '末尾输出：最多 200 行，每行最多 2000 字符' })
export const DEFAULT_HUB_PORT = 7477
export const HUB_HOSTNAME = '127.0.0.1'

export const HEADERS = {
  authorization: 'Authorization',
  actor: 'X-Flow-Actor',
  lastEventId: 'Last-Event-ID',
} as const

/** 协议错误码及其 HTTP 状态与错误类别。各组实现必须使用这里的码，不要另起。 */
export const PROTOCOL_ERRORS = {
  invalid_arguments: { status: 400, kind: 'usage' },
  unauthorized: { status: 401, kind: 'failure' },
  not_found: { status: 404, kind: 'failure' },
  unknown_workspace: { status: 422, kind: 'failure' },
  unknown_role: { status: 422, kind: 'failure' },
  invalid_transition: { status: 409, kind: 'failure' },
  lease_expired: { status: 409, kind: 'failure' },
  lease_not_found: { status: 404, kind: 'failure' },
  invalid_lease_token: { status: 403, kind: 'failure' },
  node_not_registered: { status: 409, kind: 'failure' },
  not_blocked: { status: 409, kind: 'failure' },
  reply_kind_mismatch: { status: 409, kind: 'failure' },
  reply_pending: { status: 409, kind: 'failure' },
  reply_not_found: { status: 404, kind: 'failure' },
  action_not_available: { status: 409, kind: 'failure' },
  item_closed: { status: 409, kind: 'failure' },
  user_only: { status: 403, kind: 'failure' },
  actor_mismatch: { status: 403, kind: 'failure' },
  reserved_actor: { status: 403, kind: 'failure' },
  remote_not_allowed: { status: 403, kind: 'failure' },
  scope_denied: { status: 403, kind: 'failure' },
  role_not_allowed: { status: 403, kind: 'failure' },
  secret_suspected: { status: 400, kind: 'usage' },
  hub_busy: { status: 503, kind: 'retryable' },
  internal_error: { status: 500, kind: 'failure' },
} as const satisfies Record<string, { status: number; kind: 'usage' | 'failure' | 'retryable' }>
export type ProtocolErrorCode = keyof typeof PROTOCOL_ERRORS

/** 客户端侧（HubClient）专用：连接被拒绝或超时，不会出现在中枢响应中。 */
export const HUB_UNAVAILABLE = 'hub_unavailable'

export const errorBody = z
  .object({
    ok: z.literal(false),
    error: z.object({
      kind: z.enum(['failure', 'usage', 'retryable']),
      code: z.string().min(1).meta({ description: '稳定的机器可读错误码' }),
      message: z.string(),
      details: z.unknown().optional(),
      retryable: z.boolean(),
    }),
  })
  .meta({ title: 'Flow API error', description: '失败响应，与 CLI --json 的失败形态一致' })
export type ErrorBody = z.infer<typeof errorBody>

/** 成功响应信封。 */
export const okBody = <T extends z.ZodType>(data: T) => z.object({ ok: z.literal(true), data })

const limit = z.coerce.number().int().min(1).max(500)

// ---------------------------------------------------------------------------
// health / hub
// ---------------------------------------------------------------------------

export const healthData = z
  .object({
    version: z.string(),
    uptime: z.number().min(0).meta({ description: '中枢已运行的秒数' }),
    ledger_seq: z.number().int().min(0).meta({ description: '账本最新序号，空账本为 0' }),
  })
  .meta({ title: 'GET /v1/health' })
export type HealthData = z.infer<typeof healthData>

/** 中枢运行时的密钥解析状态（secret-provider "运行时解析"）：只有个数与缺失的路径，没有值。 */
export const secretsStatus = z.object({
  loaded: z.number().int().min(0).meta({ description: '已解析的密钥个数' }),
  missing: z
    .array(z.object({ path: z.string(), file: z.string() }))
    .meta({ description: '配置中引用了但尚未设置的密钥路径；依赖它们的功能不启动' }),
  error: z.string().nullable().meta({ description: '最近一次解密失败的错误码' }),
})
export type SecretsStatusData = z.infer<typeof secretsStatus>

export const policiesStatus = z.object({
  loaded: z.number().int().min(0),
  errors: z.array(
    z.object({
      file: z.string(),
      rule_index: z.number().int().min(0).optional(),
      field: z.string().optional(),
      code: z.string(),
      message: z.string(),
    }),
  ),
})

/** 推送渠道的状态（notify-channel；add-m1-inbox 4.1）。 */
export const channelStatus = z.object({
  id: z.string(),
  state: z.enum(['running', 'backoff', 'disabled', 'stopped']).meta({
    description:
      'running 正常；backoff 失败后等待重试；disabled 缺少密钥等原因未启动；stopped 正在停止',
  }),
  missing_secrets: z.array(z.string()).meta({ description: '该渠道缺少的密钥路径' }),
  failures: z.number().int().min(0).meta({ description: '连续失败次数' }),
  next_retry_at: timestamp.nullable(),
  last_error: z.string().nullable().meta({ description: '最近一次失败的说明（已脱敏）' }),
  failed_items: z
    .number()
    .int()
    .min(0)
    .default(0)
    .meta({ description: '记为推送失败（放弃推送或同步）的条目数' }),
  ignored_inbound: z
    .number()
    .int()
    .min(0)
    .default(0)
    .meta({ description: '被忽略的入站消息与按钮数（例如陌生 chat 发来的），自中枢启动起计' }),
  warning: z.string().nullable().default(null).meta({
    description: '需要用户注意的情况，例如"可能有人在使用同一个 bot token"',
  }),
  last_rebound_at: timestamp
    .nullable()
    .default(null)
    .meta({ description: '最近一次改绑（channel.rebound）的时间' }),
})
export type ChannelStatusData = z.infer<typeof channelStatus>

export const hubStatusData = healthData
  .extend({
    pid: z.number().int().positive(),
    started_at: timestamp,
    runtime: z.enum(['bun', 'node']),
    schedules: z.object({
      loaded: z.number().int().min(0),
      errors: z.array(scheduleErrorSchema),
    }),
    schedule_errors: z.array(scheduleErrorSchema).default([]),
    last_backup: z.object({ path: z.string(), at: timestamp }).nullable(),
    secrets: secretsStatus.default({ loaded: 0, missing: [], error: null }),
    policies: policiesStatus.default({ loaded: 0, errors: [] }),
    channels: z.array(channelStatus).default([]).meta({ description: '推送渠道的状态' }),
  })
  .meta({ title: 'GET /v1/hub/status' })
export type HubStatusData = z.infer<typeof hubStatusData>

// ---------------------------------------------------------------------------
// hub tokens（design D9：按 token 绑定操作者身份）
// ---------------------------------------------------------------------------

/**
 * 保留身份（比较时不区分大小写）：`user` 只属于 `state/hub.token`；`hub`、`scheduler`、`policy`
 * 是中枢内部写事件用的身份，`unknown` 是历史上缺省的占位。`node:*` 只由中枢在节点注册流程中设置，
 * 或由签发给 `node:<id>` 的绑定 token 使用。
 */
export const RESERVED_ACTORS = ['user', 'hub', 'scheduler', 'policy', 'unknown'] as const

/** 名字（不区分大小写）属于保留身份。 */
export const isReservedName = (a: string) =>
  (RESERVED_ACTORS as readonly string[]).includes(a.toLowerCase())
/** 身份（不区分大小写）以 `node:` 开头。 */
export const isNodeActor = (a: string) => a.toLowerCase().startsWith('node:')

/**
 * user token 用 `X-Flow-Actor` 降级时可以声明的身份：除精确的 `user` 外，
 * 不能是保留身份或其大小写变体，也不能是 `node:*`。
 */
export const isDeclarableActor = (a: string) =>
  a === 'user' || (!isReservedName(a) && !isNodeActor(a))

export const hubTokenId = z
  .string()
  .regex(/^tok_[0-9a-f]{12}$/, 'token id 格式为 tok_ 加 12 位十六进制')
  .meta({ description: '绑定 token 的 id（不是 token 本身）' })

const NODE_ACTOR_RE = /^node:[A-Za-z0-9][A-Za-z0-9._-]{0,57}$/

/** 绑定 token 的身份：不能是保留身份（不区分大小写）；`node:` 前缀必须是小写且后接合法节点 id。 */
export const boundActor = actor
  .refine((a) => !isReservedName(a), {
    message: `绑定 token 的身份不能是 ${RESERVED_ACTORS.join('、')}（不区分大小写）`,
  })
  .refine((a) => !isNodeActor(a) || NODE_ACTOR_RE.test(a), {
    message: '节点身份应为 node:<节点 id>（小写 node:）',
  })

/** token 记录的公开视图：不含摘要。 */
export const hubTokenView = z
  .object({
    id: hubTokenId,
    actor,
    issued_at: timestamp,
    note: z.string().optional(),
    last_used_at: timestamp.nullable(),
    revoked_at: timestamp.nullable(),
    remote: z
      .boolean()
      .optional()
      .meta({ description: '供远程调用方使用（变更 ⑤ 的远程入口）；本变更只做标注' }),
  })
  .meta({ title: 'Hub token' })
export type HubTokenView = z.infer<typeof hubTokenView>

export const issueTokenRequest = z
  .strictObject({
    actor: boundActor,
    note: z.string().max(200).optional(),
    remote: z.boolean().optional(),
  })
  // 目前只签发两类：本机以外的节点（node:<id>），或给变更 ⑤ 远程入口用的 remote token。
  .refine((r) => NODE_ACTOR_RE.test(r.actor) || r.remote === true, {
    message: '目前只能签发 node:<id> 身份的 token，或带 --remote 标注的 token',
    path: ['actor'],
  })
  .meta({ title: 'POST /v1/hub/tokens', description: '签发绑定 token；仅 user' })
export type IssueTokenRequest = z.infer<typeof issueTokenRequest>

export const issueTokenData = z
  .object({
    token: hubTokenView,
    secret: z.string().meta({ description: 'token 明文，只在签发时返回这一次' }),
  })
  .meta({ title: 'POST /v1/hub/tokens 响应' })
export type IssueTokenData = z.infer<typeof issueTokenData>

export const listTokensData = z
  .object({ tokens: z.array(hubTokenView) })
  .meta({ title: 'GET /v1/hub/tokens' })
export type ListTokensData = z.infer<typeof listTokensData>

export const revokeTokenData = z
  .object({ token: hubTokenView })
  .meta({ title: 'POST /v1/hub/tokens/:id/revoke' })
export type RevokeTokenData = z.infer<typeof revokeTokenData>

/**
 * Web 页面的一次性登录码（add-m1-inbox 6.1，design D5）：`flow ui` 申请后打开
 * `/ui/login?code=...`。登录码只在内存中以摘要保存，60 秒内有效、只能使用一次；仅 user。
 */
export const uiLoginCodeData = z
  .object({
    code: z.string().meta({ description: '一次性登录码明文，只在申请时返回这一次' }),
    login_path: z.string().meta({ description: '登录路径（含登录码），拼在中枢地址之后打开' }),
    expires_at: timestamp,
  })
  .meta({ title: 'POST /v1/ui/login-code 响应' })
export type UiLoginCodeData = z.infer<typeof uiLoginCodeData>

/**
 * Telegram 绑定码（add-m1-inbox 5.1，telegram-channel "绑定用户本人"）：`flow telegram link` 申请，
 * 用户在 Telegram 中给 bot 发送 `/link <绑定码>`（或打开 `link_url`）。绑定码至少 64 位随机，
 * 只在中枢内存中以摘要保存，10 分钟内有效，只能使用一次；仅 user。
 */
export const telegramLinkCodeRequest = z
  .strictObject({
    rebind: z.boolean().default(false).meta({
      description: '已绑定时必须为 true 才发码（改绑到另一个账号）；改绑成功前会通知原 chat',
    }),
  })
  .meta({ title: 'POST /v1/telegram/link-code' })
export type TelegramLinkCodeRequest = z.input<typeof telegramLinkCodeRequest>

/** `POST /v1/telegram/unlink`：解除 Telegram 绑定（仅 user）。 */
export const telegramUnlinkData = z
  .object({ unlinked: z.boolean().meta({ description: 'false 表示原本就没有绑定' }) })
  .meta({ title: 'POST /v1/telegram/unlink 响应' })
export type TelegramUnlinkData = z.infer<typeof telegramUnlinkData>

export const telegramLinkCodeData = z
  .object({
    code: z.string().meta({ description: '一次性绑定码明文，只在申请时返回这一次' }),
    command: z.string().meta({ description: '要发给 bot 的完整命令，例如 /link <绑定码>' }),
    link_url: z.string().nullable().meta({
      description: 't.me 深链接（打开后点"开始"即发送绑定码）；不知道 bot 用户名时为 null',
    }),
    expires_at: timestamp,
  })
  .meta({ title: 'POST /v1/telegram/link-code 响应' })
export type TelegramLinkCodeData = z.infer<typeof telegramLinkCodeData>

export const rebuildData = z
  .object({
    events_replayed: z.number().int().min(0),
    duration_ms: z.number().int().min(0),
    ledger_seq: z.number().int().min(0),
  })
  .meta({ title: 'POST /v1/hub/rebuild' })
export type RebuildData = z.infer<typeof rebuildData>

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------

/** 创建入口要求绝对 cwd；读路径的 taskContract 兼容历史合同。 */
export const createTaskRequest = taskContract
  .safeExtend({
    cwd: z
      .string()
      .regex(/^(?:\/|~\/)/, 'cwd 必须是绝对路径或以 ~/ 开头')
      .optional()
      .meta({ description: '工作目录（节点上的绝对路径，允许 ~/ 开头并由节点展开）' }),
  })
  .meta({ title: 'Flow task contract', description: '创建任务时提交的合同' })
export const createTaskData = z
  .object({
    task: taskView,
    created: z.boolean().meta({ description: 'false 表示命中幂等键，返回的是已有任务' }),
  })
  .meta({ title: 'POST /v1/tasks' })
export type CreateTaskData = z.infer<typeof createTaskData>

/** scope 只能来自任务合同，不能由请求方覆盖。超长输入拒绝，不能截断后参与判定。 */
export const policyCheckRequest = z
  .strictObject({
    task_id: taskId,
    tool: z.string().trim().min(1).max(128),
    command: z.string().max(PROTOCOL_MESSAGE_MAX).optional(),
    paths: z.array(z.string().min(1).max(TAIL_LINE_MAX)).max(200).optional(),
    dry_run: z.boolean().optional().meta({
      description: '默认 false；user 可设为 true 只判定不入账，节点传 true 返回 400',
    }),
  })
  .meta({ title: 'POST /v1/policy/check' })
export type PolicyCheckRequest = z.infer<typeof policyCheckRequest>
export const policyCheckData = policyDecisionSchema.meta({ title: 'POST /v1/policy/check 响应' })
export type PolicyCheckData = z.infer<typeof policyCheckData>

export const listTasksQuery = z
  .strictObject({
    workspace: workspaceRef.optional(),
    status: taskStatus.optional(),
    parent: taskId.optional(),
    limit: limit.default(50),
  })
  .meta({ title: 'GET /v1/tasks 查询参数', description: '按创建时间倒序' })
export type ListTasksQuery = z.infer<typeof listTasksQuery>

export const listTasksData = z.object({ tasks: z.array(taskView) }).meta({ title: 'GET /v1/tasks' })
export type ListTasksData = z.infer<typeof listTasksData>

export const showTaskData = z
  .object({
    task: taskView,
    events: z.array(ledgerEvent).meta({ description: '该任务的全部事件' }),
    replies: z.array(replyView).default([]).meta({ description: '该任务收到的全部回复' }),
  })
  .meta({ title: 'GET /v1/tasks/:id' })
export type ShowTaskData = z.infer<typeof showTaskData>

export const cancelTaskRequest = z
  .strictObject({ reason: z.string().optional() })
  .meta({ title: 'POST /v1/tasks/:id/cancel' })
export type CancelTaskRequest = z.infer<typeof cancelTaskRequest>
export const cancelTaskData = z.object({ task: taskView }).meta({
  title: 'POST /v1/tasks/:id/cancel 响应',
  description: 'queued/blocked 任务立即 cancelled；running/verifying 任务 cancel_requested=true',
})
export type CancelTaskData = z.infer<typeof cancelTaskData>

/**
 * `POST /v1/tasks/:id/reply`（task-interaction spec）：只有 blocked 任务可以回复。
 * - question：只接受文字；awaiting_approval：approve / deny / 文字；其他原因：只接受文字。
 * - 节点仍持有租约时，回复在下一次续约时送达；否则任务带着回复重新排队（D7）。
 */
export const replyTaskRequest = z
  .strictObject({
    kind: replyKind,
    text: z.string().trim().min(1).max(16_384).optional().meta({
      description: '回复文字；kind=deny 时可作为理由，kind=text 时必填',
    }),
  })
  .refine((r) => r.kind !== 'text' || r.text !== undefined, {
    message: '文字回复不能为空',
    path: ['text'],
  })
  .meta({ title: 'POST /v1/tasks/:id/reply' })
export type ReplyTaskRequest = z.infer<typeof replyTaskRequest>
export const replyTaskData = z
  .object({
    task: taskView,
    reply: replyView,
    requeued: z.boolean().meta({ description: 'true：没有节点持有该任务，任务已带着回复重新排队' }),
  })
  .meta({ title: 'POST /v1/tasks/:id/reply 响应' })
export type ReplyTaskData = z.infer<typeof replyTaskData>

// ---------------------------------------------------------------------------
// events（SSE）
// ---------------------------------------------------------------------------

/**
 * `GET /v1/events?after=<seq>`：SSE 流。每条消息 `id` 为 seq、`event` 为事件 type、
 * `data` 为事件信封的 JSON（`ledgerEvent`）。断线重连时用 `after` 或 `Last-Event-ID`。
 */
export const eventsQuery = z
  .strictObject({
    after: z.coerce
      .number()
      .int()
      .min(0)
      .default(0)
      .meta({ description: '只发送 seq 大于它的事件' }),
    task_id: taskId.optional(),
    workspace: workspaceRef.optional(),
  })
  .meta({ title: 'GET /v1/events 查询参数' })
export type EventsQuery = z.infer<typeof eventsQuery>

// ---------------------------------------------------------------------------
// nodes
// ---------------------------------------------------------------------------

export const registerNodeRequest = z
  .strictObject({
    node_id: nodeId,
    hostname: z.string().min(1),
    version: z.string().min(1),
    capabilities: z
      .array(capability)
      .meta({ description: '节点能力，含执行器贡献的 executor:<type>' }),
    executors: z.array(executorInfo).default([]),
    concurrency: z.number().int().min(1).default(1),
  })
  .meta({ title: 'POST /v1/nodes' })
export type RegisterNodeRequest = z.infer<typeof registerNodeRequest>

export const nodeView = z
  .object({
    node_id: nodeId,
    hostname: z.string(),
    version: z.string(),
    capabilities: z.array(capability),
    executors: z.array(executorInfo),
    concurrency: z.number().int().min(1),
    registered_at: timestamp,
    last_seen_at: timestamp
      .nullable()
      .meta({ description: '最近一次活动；非事件派生，重建后为 null' }),
    active_leases: z.number().int().min(0),
  })
  .meta({ title: 'Flow node' })
export type NodeView = z.infer<typeof nodeView>

export const registerNodeData = z.object({ node: nodeView }).meta({ title: 'POST /v1/nodes 响应' })
export const listNodesData = z.object({ nodes: z.array(nodeView) }).meta({ title: 'GET /v1/nodes' })

// ---------------------------------------------------------------------------
// leases
// ---------------------------------------------------------------------------

export const acquireLeaseRequest = z
  .strictObject({
    node_id: nodeId,
    capabilities: z.array(capability),
    wait_s: z
      .number()
      .int()
      .min(0)
      .max(300)
      .default(30)
      .meta({ description: 'long-poll 最长等待秒数；中枢按 lease_wait_max_s 截断' }),
  })
  .meta({ title: 'POST /v1/leases' })
export type AcquireLeaseRequest = z.infer<typeof acquireLeaseRequest>

export const leaseGrant = z
  .object({
    lease_id: leaseId,
    lease_token: z.string().min(16).meta({ description: '租约令牌；续约与提交时必须携带' }),
    task_id: taskId,
    workspace: workspaceRef,
    contract: taskContract,
    attempt: z.number().int().min(1),
    ttl_s: z.number().int().positive(),
    expires_at: timestamp,
    resume: taskResume
      .optional()
      .meta({ description: '任务带着回复重新排队时，本次执行要带上的回复与会话 id' }),
  })
  .meta({ title: 'Lease grant' })
export type LeaseGrant = z.infer<typeof leaseGrant>

export const acquireLeaseData = z
  .object({ lease: leaseGrant.nullable().meta({ description: '等待结束仍无可领取任务时为 null' }) })
  .meta({ title: 'POST /v1/leases 响应' })
export type AcquireLeaseData = z.infer<typeof acquireLeaseData>

export const renewLeaseRequest = z
  .strictObject({
    lease_token: z.string().min(16),
    activity: z.array(activity).max(500).default([]).meta({ description: '自上次续约以来的活动' }),
    phase: z
      .literal('verifying')
      .optional()
      .meta({ description: '开始执行验收命令时带上，中枢写入 task.verifying' }),
    blocked: z
      .strictObject({
        reason: blockedReason,
        message: blockedMessage,
        tail: blockedTail,
        session: z
          .string()
          .min(1)
          .max(512)
          .optional()
          .meta({ description: '执行器会话 id；重新排队时随 resume 带给下一次执行' }),
      })
      .optional()
      .meta({
        description:
          'worker 卡住但仍活着（交互式执行器）：中枢写入 task.blocked(lease_held=true)，租约照常续约',
      }),
    resumed: z
      .strictObject({ note: z.string().optional() })
      .optional()
      .meta({ description: 'worker 未经回复自行恢复（或即将结束）：中枢写入 task.unblocked' }),
  })
  .refine((r) => r.blocked === undefined || r.resumed === undefined, {
    message: 'blocked 与 resumed 不能同时出现',
    path: ['resumed'],
  })
  .meta({ title: 'POST /v1/leases/:id/renew' })
export type RenewLeaseRequest = z.infer<typeof renewLeaseRequest>

export const renewLeaseData = z
  .object({
    lease_id: leaseId,
    expires_at: timestamp,
    cancel_requested: z
      .boolean()
      .meta({ description: '为 true 时节点应停止执行器并提交 cancelled' }),
    reply: deliveredReply.nullable().default(null).meta({
      description:
        '任务处于 blocked 时最早一条未送达的回复；节点交给执行器后用 ack-reply 确认，确认前每次续约都会返回它',
    }),
  })
  .meta({ title: 'POST /v1/leases/:id/renew 响应' })
export type RenewLeaseData = z.infer<typeof renewLeaseData>

const token = { lease_token: z.string().min(16) }
export const completeLeaseRequest = z
  .discriminatedUnion('outcome', [
    z.strictObject({ ...token, outcome: z.literal('done'), result: taskResult }),
    z.strictObject({ ...token, outcome: z.literal('failed'), result: taskResult }),
    z.strictObject({
      ...token,
      outcome: z.literal('blocked'),
      blocked_reason: blockedReason,
      message: blockedMessage,
      tail: blockedTail,
      session: z
        .string()
        .min(1)
        .max(512)
        .optional()
        .meta({ description: '执行器会话 id，回复后下一次执行据此恢复' }),
    }),
    z.strictObject({
      ...token,
      outcome: z.literal('cancelled'),
      message: z.string().max(PROTOCOL_MESSAGE_MAX).optional(),
      result: taskResult.optional().meta({ description: '取消时已执行的验收命令结果' }),
    }),
  ])
  .meta({
    title: 'POST /v1/leases/:id/complete',
    description: '结束租约；cancelled 仅用于确认续约响应中的取消指令',
  })
export type CompleteLeaseRequest = z.infer<typeof completeLeaseRequest>

export const completeLeaseData = z
  .object({ task: taskView })
  .meta({ title: 'POST /v1/leases/:id/complete 响应' })
export type CompleteLeaseData = z.infer<typeof completeLeaseData>

/**
 * `POST /v1/leases/:id/ack-reply`：节点报告回复的送达结果（node-protocol "续约携带待送达的回复"）。
 * - delivered：中枢在同一事务中写入 `task.unblocked`（带 reply_id），回复标记为已送达；
 * - not_running：worker 已不在运行，中枢写入 `task.requeued_with_reply`，任务带着回复重新排队。
 * 对已确认过的回复重复确认是幂等的。
 */
export const ackReplyRequest = z
  .strictObject({
    lease_token: z.string().min(16),
    reply_id: replyId,
    outcome: z.enum(['delivered', 'not_running']).default('delivered'),
  })
  .meta({ title: 'POST /v1/leases/:id/ack-reply' })
export type AckReplyRequest = z.infer<typeof ackReplyRequest>
export const ackReplyData = z
  .object({ task: taskView })
  .meta({ title: 'POST /v1/leases/:id/ack-reply 响应' })
export type AckReplyData = z.infer<typeof ackReplyData>

// ---------------------------------------------------------------------------
// 端点清单（导出 JSON Schema 与文档用）
// ---------------------------------------------------------------------------

export interface EndpointDef {
  method: 'GET' | 'POST'
  path: string
  auth: boolean
  /** 请求体（POST）或查询参数（GET）。 */
  request?: z.ZodType
  /** 成功响应的 data；SSE 端点为单条消息的 data。 */
  response: z.ZodType
  stream?: 'sse'
}

export const ENDPOINTS = {
  'inbox-list': {
    method: 'GET',
    path: '/v1/inbox',
    auth: true,
    request: inboxListQuery,
    response: inboxListData,
  },
  'inbox-act': {
    method: 'POST',
    path: '/v1/inbox/:id/act',
    auth: true,
    request: inboxActRequest,
    response: inboxActData,
  },
  'policy-check': {
    method: 'POST',
    path: '/v1/policy/check',
    auth: true,
    request: policyCheckRequest,
    response: policyCheckData,
  },
  health: { method: 'GET', path: '/v1/health', auth: false, response: healthData },
  'hub-status': { method: 'GET', path: '/v1/hub/status', auth: true, response: hubStatusData },
  'hub-rebuild': { method: 'POST', path: '/v1/hub/rebuild', auth: true, response: rebuildData },
  'hub-tokens-issue': {
    method: 'POST',
    path: '/v1/hub/tokens',
    auth: true,
    request: issueTokenRequest,
    response: issueTokenData,
  },
  'hub-tokens-list': {
    method: 'GET',
    path: '/v1/hub/tokens',
    auth: true,
    response: listTokensData,
  },
  'hub-tokens-revoke': {
    method: 'POST',
    path: '/v1/hub/tokens/:id/revoke',
    auth: true,
    response: revokeTokenData,
  },
  'ui-login-code': {
    method: 'POST',
    path: '/v1/ui/login-code',
    auth: true,
    response: uiLoginCodeData,
  },
  'telegram-link-code': {
    method: 'POST',
    path: '/v1/telegram/link-code',
    auth: true,
    request: telegramLinkCodeRequest,
    response: telegramLinkCodeData,
  },
  'telegram-unlink': {
    method: 'POST',
    path: '/v1/telegram/unlink',
    auth: true,
    response: telegramUnlinkData,
  },
  'tasks-create': {
    method: 'POST',
    path: '/v1/tasks',
    auth: true,
    request: createTaskRequest,
    response: createTaskData,
  },
  'tasks-list': {
    method: 'GET',
    path: '/v1/tasks',
    auth: true,
    request: listTasksQuery,
    response: listTasksData,
  },
  'tasks-show': { method: 'GET', path: '/v1/tasks/:id', auth: true, response: showTaskData },
  'tasks-cancel': {
    method: 'POST',
    path: '/v1/tasks/:id/cancel',
    auth: true,
    request: cancelTaskRequest,
    response: cancelTaskData,
  },
  'tasks-reply': {
    method: 'POST',
    path: '/v1/tasks/:id/reply',
    auth: true,
    request: replyTaskRequest,
    response: replyTaskData,
  },
  events: {
    method: 'GET',
    path: '/v1/events',
    auth: true,
    request: eventsQuery,
    response: ledgerEvent,
    stream: 'sse',
  },
  'nodes-register': {
    method: 'POST',
    path: '/v1/nodes',
    auth: true,
    request: registerNodeRequest,
    response: registerNodeData,
  },
  'nodes-list': { method: 'GET', path: '/v1/nodes', auth: true, response: listNodesData },
  'leases-acquire': {
    method: 'POST',
    path: '/v1/leases',
    auth: true,
    request: acquireLeaseRequest,
    response: acquireLeaseData,
  },
  'leases-renew': {
    method: 'POST',
    path: '/v1/leases/:id/renew',
    auth: true,
    request: renewLeaseRequest,
    response: renewLeaseData,
  },
  'leases-complete': {
    method: 'POST',
    path: '/v1/leases/:id/complete',
    auth: true,
    request: completeLeaseRequest,
    response: completeLeaseData,
  },
  'leases-ack-reply': {
    method: 'POST',
    path: '/v1/leases/:id/ack-reply',
    auth: true,
    request: ackReplyRequest,
    response: ackReplyData,
  },
} as const satisfies Record<string, EndpointDef>
export type EndpointName = keyof typeof ENDPOINTS
