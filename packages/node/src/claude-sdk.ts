import type {
  CanUseTool,
  EffortLevel,
  McpStdioServerConfig,
  Options,
  PermissionMode,
  PermissionResult,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import {
  BLOCKED_REASONS,
  type BlockedReason,
  clipText,
  type DeliveredReply,
  fail,
  loadRoles,
  ok,
  type Result,
  type Role,
  redactSecrets,
  type TaskContract,
  type TaskCost,
  type TaskResult,
} from '@flow/core'
import { z } from 'zod'
import { type NodeClock, systemClock } from './clock.ts'
import {
  ActivityQueue,
  type DeliverResult,
  type ExecutorContext,
  type ExecutorOutcome,
  type ExecutorPlugin,
  type ExecutorRun,
  idleSignal,
  resumedSignal,
  type StuckSnapshot,
  type StuckVerdict,
} from './executor.ts'

/**
 * claude-sdk 执行器（add-m1-executors 3.1 / 3.2；design D5；executor-claude-sdk spec）。
 *
 * 通过 Claude Agent SDK 无头运行 Claude Code：
 * - 流式输入：首条用户消息是任务说明，运行中的文字回复再作为用户消息推入；
 * - 角色提示词追加在 `claude_code` 预设之后，只加载项目级设置（`settingSources: ['project']`）；
 * - 注入 `flow mcp --actor <角色名>`（stdio），worker 可以检索知识库、写 journal、提交提案；
 * - 工具审批：`canUseTool` 被调用时挂起，经 idle 信号上报 `blocked(awaiting_approval)`，
 *   approve / deny 经 `deliver` 送达后 resolve 对应的 Promise；超过角色设定的时限则任务失败；
 * - 结果：摘要取最后一条助手文本，记录会话 id 与费用；SDK 报错或轮次耗尽时以 failed 结束；
 * - 取消：`abortController.abort()` 加 `close()`。
 *
 * SDK 只在真正运行时才动态加载；测试注入模拟的 `query`，绝不调用真实的 Claude。
 */

export const CLAUDE_SDK_EXECUTOR = 'claude-sdk'
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5'
/** 审批等待的默认时限：24 小时。 */
export const DEFAULT_APPROVAL_TIMEOUT_MINUTES = 24 * 60

const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
] as const satisfies readonly PermissionMode[]
const EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly EffortLevel[]

/** 角色 `permissions` 在 claude-sdk 执行器下的形态（内核只校验它是对象，这里细化）。 */
export const claudeSdkPermissions = z.strictObject({
  permissionMode: z.enum(PERMISSION_MODES).default('auto'),
  allowedTools: z.array(z.string().min(1)).default([]),
  disallowedTools: z.array(z.string().min(1)).default([]),
  maxTurns: z.number().int().positive().optional(),
  approval_timeout_minutes: z
    .number()
    .positive()
    .max(10 * 24 * 60)
    .default(DEFAULT_APPROVAL_TIMEOUT_MINUTES),
})
export type ClaudeSdkPermissions = z.infer<typeof claudeSdkPermissions>

/** SDK `query()` 的返回值中本执行器用到的部分（真实的 `Query` 满足它）。 */
export interface ClaudeQueryHandle extends AsyncIterable<SDKMessage> {
  close(): void
}
/** 与 SDK `query()` 同签名的函数；测试注入模拟实现。 */
export type ClaudeQueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>
  options: Options
}) => ClaudeQueryHandle

/** 一次待决的工具审批（交给策略预检钩子的信息）。 */
export interface ApprovalRequest {
  taskId: string
  role: string
  toolName: string
  input: Record<string, unknown>
  /** 已脱敏、限长的输入摘要。 */
  summary: string
}

/**
 * 策略预检钩子（变更 ③ 2.3 将在这里接入策略引擎）：返回 PermissionResult 即直接作答，
 * 返回 null 表示交给用户审批。本变更不实现，缺省一律交给用户。
 */
export type ApprovalPrecheck = (req: ApprovalRequest) => Promise<PermissionResult | null>

export interface ClaudeSdkExecutorOptions {
  /** flow-home：读取角色，并作为 flow MCP 的 FLOW_HOME。 */
  home: string
  clock?: NodeClock
  /** 注入的 `query`；缺省时动态加载 `@anthropic-ai/claude-agent-sdk`。 */
  query?: ClaudeQueryFn
  /** 按名字解析角色；缺省读取 `config/roles/`。 */
  resolveRole?: (name: string) => Promise<Result<Role>>
  /** 启动 flow 的命令（argv 前缀），缺省 `['flow']`。 */
  flowCommand?: readonly string[]
  /** 审批策略预检（变更 ③），缺省不预检。 */
  precheck?: ApprovalPrecheck
  /** 待审批请求重新上报的初始间隔（之后指数退避到 10 分钟），缺省 1 秒。 */
  reannounceMs?: number
  /** 两条 SDK 消息间隔超过这么久时附带 resumed 信号（让 no_progress 之后恢复），缺省 60 秒。 */
  resumeGapMs?: number
}

const REANNOUNCE_MAX_MS = 10 * 60_000
const ACTIVITY_TEXT_MAX = 16_000
const SUMMARY_MAX = 16_000
const INPUT_SUMMARY_MAX = 500
const STDERR_KEEP = 20

/** 截断后脱敏，再截断到 max（与 sanitizeMessage 同序）。 */
const safe = (text: string, max: number) =>
  clipText(redactSecrets(clipText(text, Math.max(max * 4, 4000))), max)

/** 工具输入的一句话摘要：常见工具取关键字段，其余取 JSON。已脱敏、限长。 */
export function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  const pick = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined)
  let raw: string | undefined
  if (toolName === 'Bash') raw = pick('command')
  else if (['Read', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit'].includes(toolName))
    raw = pick('file_path') ?? pick('notebook_path')
  else if (toolName === 'WebFetch') raw = pick('url')
  else if (toolName === 'Glob' || toolName === 'Grep') raw = pick('pattern')
  if (raw === undefined) {
    try {
      raw = JSON.stringify(input) ?? ''
    } catch {
      raw = '（无法序列化的输入）'
    }
  }
  return safe(raw.replace(/\s+/g, ' ').trim(), INPUT_SUMMARY_MAX)
}

/** 卡住识别：idle 信号的 hint 中带有合法原因时照用（审批挂起即 awaiting_approval）。 */
export function classifyClaudeSdk(snapshot: StuckSnapshot): StuckVerdict | null {
  const reason = snapshot.hint?.reason
  if (typeof reason !== 'string' || !(BLOCKED_REASONS as readonly string[]).includes(reason)) {
    return null
  }
  const message = snapshot.hint?.message
  const session = snapshot.hint?.session
  return {
    reason: reason as BlockedReason,
    message: typeof message === 'string' && message ? message : `Claude 已停下（${reason}）`,
    ...(typeof session === 'string' && session ? { session } : {}),
  }
}

/** 首条用户消息：任务说明。 */
export function renderTaskPrompt(contract: TaskContract, cwd: string): string {
  const lines = ['# 任务', '', contract.goal.trim(), '', `工作目录：${cwd}`]
  if (contract.context?.length) {
    lines.push('', '## 上下文引用', ...contract.context.map((c) => `- ${c}`))
    lines.push('（brain 条目可以通过 flow MCP 的 kb 工具检索。）')
  }
  if (contract.verify?.length) {
    lines.push(
      '',
      '## 验收命令',
      '你结束后 Flow 会依次运行：',
      ...contract.verify.map((v) => `- \`${v.cmd.join(' ')}\`${v.cwd ? `（目录 ${v.cwd}）` : ''}`),
    )
  }
  lines.push(
    '',
    '## 约定',
    '- 需要的工具权限会由 Flow 转给用户审批，被拒绝时请按理由调整做法。',
    '- 完成后用简短的文字总结结果，最后一段文字会作为任务结果摘要。',
  )
  return lines.join('\n')
}

/** 把一条回复写成给 Claude 的用户消息。 */
export function renderReply(reply: DeliveredReply): string {
  const text = reply.text?.trim()
  switch (reply.kind) {
    case 'approve':
      return `用户（${reply.by}）批准了你上一次请求的操作，请继续。${text ? `\n附言：${text}` : ''}`
    case 'deny':
      return `用户（${reply.by}）拒绝了你上一次请求的操作${text ? `，理由：${text}` : '。'}\n请调整做法后继续。`
    case 'text':
      return `用户（${reply.by}）回复：\n${text ?? ''}`
  }
}

const userMessage = (text: string): SDKUserMessage => ({
  type: 'user',
  message: { role: 'user', content: text },
  parent_tool_use_id: null,
})

/** 简单的异步队列：作为 SDK 的流式输入。 */
class InputStream implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private waiting: ((r: IteratorResult<SDKUserMessage>) => void) | undefined
  closed = false

  push(item: SDKUserMessage) {
    if (this.closed) return
    const w = this.waiting
    this.waiting = undefined
    if (w) w({ value: item, done: false })
    else this.items.push(item)
  }

  close() {
    this.closed = true
    const w = this.waiting
    this.waiting = undefined
    w?.({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift()
        if (item !== undefined) return Promise.resolve({ value: item, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => {
          this.waiting = resolve
        })
      },
      return: () => {
        this.close()
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }
}

interface PendingApproval {
  toolUseID: string
  toolName: string
  input: Record<string, unknown>
  message: string
  resolve(r: PermissionResult): void
  cancelTimer(): void
}

/** 结果消息的费用与用量（字段以 SDK 的 SDKResultMessage 为准）。 */
export function costOf(r: SDKResultMessage): TaskCost {
  let input = 0
  let output = 0
  for (const u of Object.values(r.modelUsage ?? {})) {
    input += u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens
    output += u.outputTokens
  }
  const int = (n: number) => Math.max(0, Math.round(n))
  return {
    usd: Math.max(0, r.total_cost_usd),
    turns: int(r.num_turns),
    duration_ms: int(r.duration_ms),
    input_tokens: int(input),
    output_tokens: int(output),
  }
}

async function defaultResolveRole(home: string, name: string): Promise<Result<Role>> {
  const loaded = await loadRoles(home)
  if (!loaded.ok) return loaded
  const role = loaded.data.roles.find((r) => r.name === name)
  if (role) return ok(role)
  const issue = loaded.data.errors.find((e) => e.file.endsWith(`${name}.yaml`))
  return fail(
    'failure',
    'unknown_role',
    issue ? `角色 ${name} 不合法：${issue.message}` : `没有角色 ${name}`,
  )
}

let sdkQuery: ClaudeQueryFn | undefined
/** 动态加载真实 SDK（只在真正运行任务时发生）。 */
async function loadSdkQuery(): Promise<ClaudeQueryFn> {
  if (!sdkQuery) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    sdkQuery = sdk.query
  }
  return sdkQuery
}

export function createClaudeSdkExecutor(options: ClaudeSdkExecutorOptions): ExecutorPlugin {
  const clock = options.clock ?? systemClock
  const resolveRole = options.resolveRole ?? ((name) => defaultResolveRole(options.home, name))
  const flowCommand = options.flowCommand ?? ['flow']
  const reannounceMs = options.reannounceMs ?? 1000
  const resumeGapMs = options.resumeGapMs ?? 60_000

  return {
    type: CLAUDE_SDK_EXECUTOR,
    mode: 'interactive',
    classify: classifyClaudeSdk,
    run(contract: TaskContract, ctx: ExecutorContext): ExecutorRun {
      const queue = new ActivityQueue()
      const input = new InputStream()
      const abortController = new AbortController()
      const pending: PendingApproval[] = []
      const seenReplies = new Set<string>()
      const stderrTail: string[] = []
      let q: ClaudeQueryHandle | undefined
      let finished = false
      let session = ctx.resume?.session
      let lastText: string | undefined
      let lastMessageAt = clock.now()
      let cancelAnnounce = () => {}
      let announceDelay = reannounceMs
      let settle: (r: Result<ExecutorOutcome>) => void = () => {}
      const done = new Promise<Result<ExecutorOutcome>>((resolve) => {
        settle = resolve
      })

      const iso = () => new Date(clock.now()).toISOString()
      const output = (text: string) =>
        queue.push({ ts: iso(), kind: 'output', text: clipText(text, ACTIVITY_TEXT_MAX) })
      const status = (text: string, data?: Record<string, unknown>) =>
        queue.push({
          ts: iso(),
          kind: 'status',
          text: clipText(text, ACTIVITY_TEXT_MAX),
          ...(data ? { data } : {}),
        })
      const result = (summary: string, extra: Partial<TaskResult> = {}): TaskResult => ({
        summary: safe(summary.trim() || '（没有输出）', SUMMARY_MAX),
        artifacts: [],
        verify: [],
        executor: CLAUDE_SDK_EXECUTOR,
        node_id: ctx.nodeId,
        ...(session ? { session } : {}),
        ...extra,
      })

      /** 结束：拒绝全部待决审批、关闭输入与查询、结束活动流。 */
      const finish = (r: Result<ExecutorOutcome>) => {
        if (finished) return
        finished = true
        cancelAnnounce()
        for (const p of pending.splice(0)) {
          p.cancelTimer()
          p.resolve({ behavior: 'deny', message: '任务已结束', interrupt: true })
        }
        input.close()
        abortController.abort()
        try {
          q?.close()
        } catch {
          // 已经结束的查询再 close 可能抛出，忽略。
        }
        ctx.signal.removeEventListener('abort', onAbort)
        queue.close()
        settle(r)
      }
      const onAbort = () => {
        finish(ok({ outcome: 'cancelled', message: 'claude-sdk 执行器已取消' }))
      }

      /** 上报队首的待审批请求（idle 信号）；节点在 blocked 期间会忽略，所以退避重报。 */
      const announce = () => {
        cancelAnnounce()
        const head = pending[0]
        if (!head || finished) return
        queue.push(
          idleSignal(iso(), head.message, {
            reason: 'awaiting_approval',
            message: head.message,
            tool: head.toolName,
            tool_use_id: head.toolUseID,
            ...(session ? { session } : {}),
          }),
        )
        cancelAnnounce = clock.setTimeout(announce, announceDelay)
        announceDelay = Math.min(announceDelay * 2, REANNOUNCE_MAX_MS)
      }
      const resetAnnounce = () => {
        announceDelay = reannounceMs
        cancelAnnounce()
        if (pending.length > 0) cancelAnnounce = clock.setTimeout(announce, announceDelay)
      }

      /** 解决队首审批，并安排下一条的上报。 */
      const settleHead = (r: PermissionResult) => {
        const head = pending.shift()
        if (!head) return
        head.cancelTimer()
        head.resolve(r)
        resetAnnounce()
      }

      const makeCanUseTool =
        (role: Role, perms: ClaudeSdkPermissions): CanUseTool =>
        async (toolName, toolInput, opts) => {
          if (finished) return { behavior: 'deny', message: '任务已结束', interrupt: true }
          const summary = summarizeToolInput(toolName, toolInput)
          // ---- 策略预检钩子（变更 ③ 2.3）：在交给用户之前先问策略引擎。当前未接入。 ----
          if (options.precheck) {
            const decided = await options.precheck({
              taskId: ctx.taskId,
              role: role.name,
              toolName,
              input: toolInput,
              summary,
            })
            if (decided) return decided
          }
          // ---- 交给用户审批：挂起直到 deliver 送达 approve / deny，或超时。 ----
          const title = opts.title ? safe(opts.title, 300) : toolName
          const message = safe(`等待授权：${title}：${summary}`, 1000)
          return new Promise<PermissionResult>((resolve) => {
            const approval: PendingApproval = {
              toolUseID: opts.toolUseID,
              toolName,
              input: toolInput,
              message,
              resolve,
              cancelTimer: () => {},
            }
            approval.cancelTimer = clock.setTimeout(() => {
              const i = pending.indexOf(approval)
              if (i < 0) return
              pending.splice(i, 1)
              resolve({ behavior: 'deny', message: '审批超时', interrupt: true })
              const minutes = perms.approval_timeout_minutes
              finish(
                ok({
                  outcome: 'failed',
                  result: result(
                    `工具 ${toolName} 的审批等待超过 ${minutes} 分钟未获答复：${summary}`,
                    { reason: 'approval_timeout' },
                  ),
                }),
              )
            }, perms.approval_timeout_minutes * 60_000)
            opts.signal.addEventListener(
              'abort',
              () => {
                const i = pending.indexOf(approval)
                if (i < 0) return
                pending.splice(i, 1)
                approval.cancelTimer()
                resolve({ behavior: 'deny', message: '已中止', interrupt: true })
                if (i === 0) resetAnnounce()
              },
              { once: true },
            )
            pending.push(approval)
            output(`[审批] ${message}`)
            if (pending.length === 1) {
              announceDelay = reannounceMs
              announce()
            }
          })
        }

      /** 处理一条 SDK 消息：上报活动，遇到结果消息时返回它。 */
      const onMessage = (m: SDKMessage): SDKResultMessage | undefined => {
        const sid = (m as { session_id?: unknown }).session_id
        if (typeof sid === 'string' && sid) session = sid
        const now = clock.now()
        // 长时间静默后又有消息：worker 自行恢复（节点只在 blocked 时据此回到 running）。
        if (now - lastMessageAt >= resumeGapMs && pending.length === 0) {
          queue.push(resumedSignal(iso(), 'Claude 恢复了输出'))
        }
        lastMessageAt = now
        switch (m.type) {
          case 'system':
            if (m.subtype === 'init') {
              status(
                `Claude 会话 ${m.session_id} 已启动（模型 ${m.model}，权限 ${m.permissionMode}）`,
              )
            }
            return undefined
          case 'assistant': {
            const content = Array.isArray(m.message?.content) ? m.message.content : []
            for (const block of content) {
              if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
                if (m.parent_tool_use_id === null) lastText = block.text
                output(safe(block.text, ACTIVITY_TEXT_MAX))
              } else if (block.type === 'tool_use') {
                const toolInput =
                  block.input && typeof block.input === 'object'
                    ? (block.input as Record<string, unknown>)
                    : {}
                output(`→ ${block.name}：${summarizeToolInput(block.name, toolInput)}`)
              }
            }
            return undefined
          }
          case 'result':
            return m
          default:
            return undefined
        }
      }

      const outcomeOf = (r: SDKResultMessage): ExecutorOutcome => {
        const cost = costOf(r)
        if (r.subtype === 'success') {
          if (!r.is_error) {
            return { outcome: 'done', result: result(lastText ?? r.result, { cost }) }
          }
          return {
            outcome: 'failed',
            result: result(`Claude 报告错误：${r.result || '（无说明）'}`, {
              reason: 'sdk_error',
              cost,
            }),
          }
        }
        switch (r.subtype) {
          case 'error_max_turns':
            return {
              outcome: 'failed',
              result: result(`达到最大轮次上限（${r.num_turns} 轮），运行未完成`, {
                reason: 'max_turns',
                cost,
              }),
            }
          case 'error_max_budget_usd':
            return {
              outcome: 'failed',
              result: result(`达到费用上限（${r.total_cost_usd} 美元），运行未完成`, {
                reason: 'max_budget',
                cost,
              }),
            }
          default: {
            const errors = (r.errors ?? []).join('；')
            return {
              outcome: 'failed',
              result: result(`Claude 执行出错（${r.subtype}）${errors ? `：${errors}` : ''}`, {
                reason: 'sdk_error',
                cost,
              }),
            }
          }
        }
      }

      const main = async () => {
        const role = await resolveRole(contract.role)
        if (finished) return
        if (!role.ok) {
          finish(
            ok({
              outcome: 'failed',
              result: result(role.error.message, { reason: 'unknown_role' }),
            }),
          )
          return
        }
        const perms = claudeSdkPermissions.safeParse(role.data.permissions ?? {})
        if (!perms.success) {
          finish(
            ok({
              outcome: 'failed',
              result: result(
                `角色 ${role.data.name} 的 permissions 不合法：${perms.error.message}`,
                {
                  reason: 'invalid_role',
                },
              ),
            }),
          )
          return
        }
        const effort = role.data.effort
        if (effort !== undefined && !(EFFORT_LEVELS as readonly string[]).includes(effort)) {
          finish(
            ok({
              outcome: 'failed',
              result: result(`角色 ${role.data.name} 的 effort 不合法：${effort}`, {
                reason: 'invalid_role',
              }),
            }),
          )
          return
        }
        const query = options.query ?? (await loadSdkQuery())
        if (finished) return
        const options_ = buildOptions({
          role: role.data,
          perms: perms.data,
          ctx,
          home: options.home,
          flowCommand,
          canUseTool: makeCanUseTool(role.data, perms.data),
          abortController,
          stderr: (data) => {
            for (const line of data.split('\n')) if (line.trim()) stderrTail.push(line)
            if (stderrTail.length > STDERR_KEEP)
              stderrTail.splice(0, stderrTail.length - STDERR_KEEP)
          },
        })
        // 首条用户消息：恢复会话时是回复本身，否则是任务说明（无会话可恢复时把回复附在后面）。
        const resume = ctx.resume
        const first = resume?.session
          ? renderReply(resume.reply)
          : [
              renderTaskPrompt(contract, ctx.cwd),
              ...(resume ? ['', renderReply(resume.reply)] : []),
            ].join('\n')
        if (resume) seenReplies.add(resume.reply.reply_id)
        input.push(userMessage(first))
        status(
          resume?.session
            ? `恢复 Claude 会话 ${resume.session}（${role.data.name}，模型 ${options_.model}）`
            : `启动 Claude（${role.data.name}，模型 ${options_.model}）`,
        )
        q = query({ prompt: input, options: options_ })
        let last: SDKResultMessage | undefined
        try {
          for await (const m of q) {
            if (finished) return
            const r = onMessage(m)
            if (!r) continue
            last = r
            // 运行中推入的回复还在排队：等它的那一轮结束。
            if ((r.queued_turn_count ?? 0) > 0) continue
            break
          }
        } catch (err) {
          if (finished) return
          for (const line of stderrTail) output(line)
          finish(
            ok({
              outcome: 'exited',
              exit_code: null,
              message: `Claude 进程异常：${safe((err as Error)?.message ?? String(err), 1000)}`,
            }),
          )
          return
        }
        if (finished) return
        if (!last) {
          for (const line of stderrTail) output(line)
          finish(
            ok({ outcome: 'exited', exit_code: null, message: 'Claude 在给出结果之前结束了输出' }),
          )
          return
        }
        finish(ok(outcomeOf(last)))
      }

      if (ctx.signal.aborted) onAbort()
      else {
        ctx.signal.addEventListener('abort', onAbort, { once: true })
        main().catch((err) => {
          finish(fail('failure', 'claude_sdk_error', String((err as Error)?.message ?? err)))
        })
      }

      return {
        activity: queue,
        done,
        cancel: async () => {
          if (!finished) onAbort()
        },
        deliver: async (reply): Promise<DeliverResult> => {
          if (finished) return 'not_running'
          // 按 reply_id 幂等：同一条回复只交给 Claude 一次。
          if (seenReplies.has(reply.reply_id)) return 'delivered'
          seenReplies.add(reply.reply_id)
          const text = reply.text?.trim()
          const head = pending[0]
          if (head) {
            if (reply.kind === 'approve') {
              status(`已批准 ${head.toolName}（${reply.by}）`)
              settleHead({ behavior: 'allow', updatedInput: head.input })
            } else if (reply.kind === 'deny') {
              status(`已拒绝 ${head.toolName}（${reply.by}）`)
              settleHead({
                behavior: 'deny',
                message: text ? `用户拒绝了这次调用，理由：${text}` : '用户拒绝了这次调用',
              })
            } else {
              // 审批挂起时的文字回复：拒绝这次调用，把文字作为理由交给 Claude。
              status(`以文字回复代替审批 ${head.toolName}（${reply.by}）`)
              settleHead({
                behavior: 'deny',
                message: `用户没有批准这次调用，而是回复：${text ?? ''}`,
              })
            }
            return 'delivered'
          }
          if (reply.kind === 'text' || text) {
            // 运行中的回复：作为用户消息推入流式输入。
            input.push(userMessage(renderReply(reply)))
            status(`已把 ${reply.by} 的回复推给 Claude`)
          } else {
            status(`没有待审批的请求，忽略 ${reply.kind}（${reply.by}）`)
          }
          return 'delivered'
        },
      }
    },
  }
}

interface BuildOptionsInput {
  role: Role
  perms: ClaudeSdkPermissions
  ctx: ExecutorContext
  home: string
  flowCommand: readonly string[]
  canUseTool: CanUseTool
  abortController: AbortController
  stderr: (data: string) => void
}

/** 由角色与任务上下文拼出 SDK 的 `query()` 选项。 */
export function buildOptions(i: BuildOptionsInput): Options & { model: string } {
  const [command = 'flow', ...prefix] = i.flowCommand
  const flowMcp: McpStdioServerConfig = {
    type: 'stdio',
    command,
    args: [...prefix, 'mcp', '--actor', i.role.name],
    env: { FLOW_HOME: i.home },
  }
  // flow MCP 的工具总是放行：写入受 Flow 自己的 AI 写入边界约束。
  const allowedTools = [...new Set([...i.perms.allowedTools, 'mcp__flow'])]
  return {
    cwd: i.ctx.cwd,
    model: i.role.model ?? DEFAULT_CLAUDE_MODEL,
    ...(i.role.effort ? { effort: i.role.effort as EffortLevel } : {}),
    systemPrompt: { type: 'preset', preset: 'claude_code', append: i.role.prompt },
    settingSources: ['project'],
    mcpServers: { flow: flowMcp },
    permissionMode: i.perms.permissionMode,
    ...(i.perms.permissionMode === 'bypassPermissions'
      ? { allowDangerouslySkipPermissions: true }
      : {}),
    allowedTools,
    disallowedTools: i.perms.disallowedTools,
    ...(i.perms.maxTurns ? { maxTurns: i.perms.maxTurns } : {}),
    canUseTool: i.canUseTool,
    abortController: i.abortController,
    ...(i.ctx.resume?.session ? { resume: i.ctx.resume.session } : {}),
    stderr: i.stderr,
  }
}
