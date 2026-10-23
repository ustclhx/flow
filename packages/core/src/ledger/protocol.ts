import { z } from 'zod'
import { workspaceRef } from '../schema/common.ts'
import { capability, leaseId, nodeId, taskId, timestamp } from './common.ts'
import { executorInfo, ledgerEvent } from './events.ts'
import { activity, blockedReason, taskContract, taskResult, taskStatus, taskView } from './task.ts'

/**
 * 中枢 HTTP 协议（hub-daemon、node-protocol spec；design D3、D4）。
 *
 * 约定：
 * - 全部路径以 `/v1` 开头，只监听 127.0.0.1。
 * - 除 `GET /v1/health` 外都需要 `Authorization: Bearer <token>`；操作者经 `X-Flow-Actor` 传递。
 * - 成功响应：`{ ok: true, data }`；失败响应与 CLI `--json` 一致：
 *   `{ ok: false, error: { kind, code, message, details?, retryable } }`（见 `toJsonDocument`）。
 * - 请求体与响应 `data` 都用这里的 zod 定义校验，并导出到 `schemas/protocol/`。
 */

export const PROTOCOL_VERSION = 'v1'
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
  invalid_transition: { status: 409, kind: 'failure' },
  lease_expired: { status: 409, kind: 'failure' },
  lease_not_found: { status: 404, kind: 'failure' },
  invalid_lease_token: { status: 403, kind: 'failure' },
  node_not_registered: { status: 409, kind: 'failure' },
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

export const hubStatusData = healthData
  .extend({
    pid: z.number().int().positive(),
    started_at: timestamp,
    runtime: z.enum(['bun', 'node']),
    schedules: z.object({
      loaded: z.number().int().min(0),
      errors: z.array(
        z.object({
          rule_id: z.string().optional(),
          field: z.string().optional(),
          message: z.string(),
        }),
      ),
    }),
    last_backup: z.object({ path: z.string(), at: timestamp }).nullable(),
  })
  .meta({ title: 'GET /v1/hub/status' })
export type HubStatusData = z.infer<typeof hubStatusData>

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

/** `POST /v1/tasks` 请求体即任务合同（调用方形态）。 */
export const createTaskRequest = taskContract
export const createTaskData = z
  .object({
    task: taskView,
    created: z.boolean().meta({ description: 'false 表示命中幂等键，返回的是已有任务' }),
  })
  .meta({ title: 'POST /v1/tasks' })
export type CreateTaskData = z.infer<typeof createTaskData>

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
      message: z.string().min(1),
      tail: z.array(z.string()).max(200).optional(),
    }),
    z.strictObject({
      ...token,
      outcome: z.literal('cancelled'),
      message: z.string().optional(),
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
  health: { method: 'GET', path: '/v1/health', auth: false, response: healthData },
  'hub-status': { method: 'GET', path: '/v1/hub/status', auth: true, response: hubStatusData },
  'hub-rebuild': { method: 'POST', path: '/v1/hub/rebuild', auth: true, response: rebuildData },
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
} as const satisfies Record<string, EndpointDef>
export type EndpointName = keyof typeof ENDPOINTS
