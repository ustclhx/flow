import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import {
  operations as allOperations,
  fail,
  HubClient,
  invokeOperation,
  isDeclarableActor,
  isValidActor,
  LEASE_TOKEN_FILE_ENV,
  normalizeBindingWorkspace,
  type OpBinding,
  type Operation,
  type RaindownError,
  readRaindownEnv,
  resolveRaindownHome,
  taskBindingAllows,
  taskId,
  toJsonDocument,
  USER_ACTOR,
  VERSION,
} from '@raindown/core'
import { z } from 'zod'

/**
 * `raindown mcp` 的 MCP 适配层（design D1）：遍历 core 的 `operations`，每个操作生成一个工具。
 * 按 core 的绑定策略筛选工具；输入校验、执行与 JSON 渲染都交给 core 的共享函数，
 * 与 CLI `--json` 的输出逐字节一致。
 */

export interface RaindownMcpServerOptions {
  /** 操作者标识，写入提交记录并用于 AI 写入边界判断；不允许为 `user`（design D8）。 */
  actor: string
  /** raindown-home 路径；省略时每次调用按 `RAINDOWN_HOME` / `~/raindown-home` 解析。 */
  home?: string
  /**
   * 会话绑定（add-m1-supervisor D6；tasks 4.1）：`--workspace`、`--task`、`--reply-only`。
   * 写类操作只能作用于该 workspace；`task_create` 自动以绑定的任务为 parent。
   */
  binding?: McpBindingOptions
  /** 暴露的操作列表，默认是 core 的全部 `operations`（测试可传入 fixture）。 */
  operations?: readonly Operation<never, unknown>[]
}

/** MCP 启动参数错误；CLI 据此以用法错误（退出码 2）退出。 */
export class RaindownMcpConfigError extends Error {
  constructor(readonly error: RaindownError) {
    super(error.message)
    this.name = 'RaindownMcpConfigError'
  }
}

/** 校验 MCP 的 actor：必须提供、格式合法，且不能是 `user`（MCP 调用方一定是 AI harness）。 */
export function checkMcpActor(actor: string | undefined): RaindownError | null {
  if (actor === undefined || actor === '') {
    return {
      kind: 'usage',
      code: 'actor_required',
      message: 'raindown mcp 需要 --actor <name>（例如 claude、codex、pi）',
    }
  }
  if (!isValidActor(actor)) {
    return {
      kind: 'usage',
      code: 'invalid_actor',
      message: `不合法的 actor：${JSON.stringify(actor)}（只能包含字母、数字与 . _ : @ -，最长 64 个字符）`,
    }
  }
  if (actor !== USER_ACTOR && !isDeclarableActor(actor)) {
    return {
      kind: 'usage',
      code: 'invalid_actor',
      message: `raindown mcp 的 actor 不能是保留身份 ${actor}（hub、scheduler、policy、unknown、node:*，不区分大小写）`,
    }
  }
  if (actor === USER_ACTOR) {
    return {
      kind: 'usage',
      code: 'invalid_actor',
      message: 'raindown mcp 的 actor 不能是 user：MCP 调用方是 AI harness，须遵守 AI 写入边界',
    }
  }
  return null
}

/** `raindown mcp` 的绑定参数（未规范化）。 */
export interface McpBindingOptions {
  kind?: 'task' | 'wake' | undefined
  workspace?: string | undefined
  task?: string | undefined
  replyOnly?: boolean | undefined
}

/**
 * 校验并规范化绑定参数：workspace 写成 `ws/<id>` 或 `<id>`；`--task`、`--reply-only` 必须与
 * `--workspace` 同时给出。都没给时返回 undefined（不绑定）。
 */
export function resolveMcpBinding(
  o: McpBindingOptions | undefined,
): { ok: true; binding: OpBinding | undefined } | { ok: false; error: RaindownError } {
  const usage = (message: string) =>
    ({ ok: false, error: { kind: 'usage', code: 'invalid_binding', message } }) as const
  const given = (v: string | undefined) => v !== undefined && v !== ''
  if (!o || (!given(o.workspace) && !given(o.task) && !o.replyOnly)) {
    return { ok: true, binding: undefined }
  }
  if (!given(o.workspace)) return usage('--task 与 --reply-only 需要同时给出 --workspace <ws>')
  const workspace = normalizeBindingWorkspace(o.workspace as string)
  if (!workspace)
    return usage(`不合法的 --workspace：${JSON.stringify(o.workspace)}（应为 ws/<id>）`)
  if (given(o.task) && !taskId.safeParse(o.task).success) {
    return usage(`不合法的 --task：${JSON.stringify(o.task)}`)
  }
  return {
    ok: true,
    binding: {
      workspace,
      ...(o.kind ? { kind: o.kind } : {}),
      ...(given(o.task) ? { task: o.task as string } : {}),
      ...(o.replyOnly ? { replyOnly: true } : {}),
    },
  }
}

/** 由操作的 zod schema 生成 MCP 工具的 inputSchema；字段的 `.describe()` 成为参数说明。 */
export function toolInputSchema(op: Pick<Operation<never, unknown>, 'input'>): Tool['inputSchema'] {
  const { $schema: _s, ...schema } = z.toJSONSchema(op.input, { io: 'input' }) as Record<
    string,
    unknown
  >
  return { ...schema, type: 'object' } as Tool['inputSchema']
}

/** 由操作生成工具清单项：名称 = `op.name`，描述 = `op.summary`。 */
export function toolFromOperation(op: Operation<never, unknown>): Tool {
  return { name: op.name, description: op.summary, inputSchema: toolInputSchema(op) }
}

const textResult = (doc: unknown, isError: boolean): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(doc) }],
  ...(isError ? { isError: true } : {}),
})

/** 创建 MCP 服务（尚未连接传输）。actor 不合法时抛出 `RaindownMcpConfigError`。 */
export function createRaindownMcpServer(opts: RaindownMcpServerOptions): Server {
  const bad = checkMcpActor(opts.actor)
  if (bad) throw new RaindownMcpConfigError(bad)
  const bound = resolveMcpBinding(opts.binding)
  if (!bound.ok) throw new RaindownMcpConfigError(bound.error)
  const binding = bound.binding
  const ops = (opts.operations ?? allOperations).filter((op) =>
    binding?.kind === 'task'
      ? taskBindingAllows(op)
      : op.name !== 'raindown_report' && (op.name !== 'event_get' || binding?.task !== undefined),
  )
  const byName = new Map(ops.map((op) => [op.name, op]))
  if (byName.size !== ops.length) {
    throw new Error('operations 中存在重名的操作')
  }
  const tools = ops.map(toolFromOperation)

  // 这里需要直接给出由 zod 生成的 JSON Schema，因此使用低层 Server 而不是 McpServer。
  const server = new Server(
    { name: 'raindown', version: VERSION },
    { capabilities: { tools: { listChanged: false } } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const op = byName.get(req.params.name)
    const result = op
      ? await invokeOperation(op, req.params.arguments ?? {}, {
          home: opts.home ?? resolveRaindownHome(process.env),
          actor: opts.actor,
          via: 'mcp',
          ...(binding ? { binding } : {}),
        })
      : fail('usage', 'unknown_tool', `未知工具：${req.params.name}`)
    return textResult(toJsonDocument(result), !result.ok)
  })
  return server
}

export interface StdioServerHandle {
  server: Server
  /** 客户端断开（stdin 结束）或服务关闭时 resolve。 */
  closed: Promise<void>
}

/**
 * 以 stdio 传输启动服务。stdout 只承载 MCP 协议消息，任何日志都必须写 stderr。
 */
export async function startStdioServer(opts: RaindownMcpServerOptions): Promise<StdioServerHandle> {
  const resolved = await resolveLeaseMcpOptions(opts)
  const server = createRaindownMcpServer(resolved)
  const transport = new StdioServerTransport()
  const closed = new Promise<void>((resolve) => {
    server.onclose = () => resolve()
  })
  const onEnd = () => {
    void server.close()
  }
  process.stdin.once('end', onEnd)
  process.stdin.once('close', onEnd)
  await server.connect(transport)
  return { server, closed }
}

/** MCP 启动时从中枢核定派工绑定；命令行 task/workspace 只用于核对。 */
export async function resolveLeaseMcpOptions(
  opts: RaindownMcpServerOptions,
): Promise<RaindownMcpServerOptions> {
  if (!readRaindownEnv(LEASE_TOKEN_FILE_ENV)) return opts
  const result = await new HubClient({
    home: opts.home ?? resolveRaindownHome(process.env),
    actor: opts.actor,
  }).request('session-binding')
  if (!result.ok) throw new RaindownMcpConfigError(result.error)
  if (result.data.kind !== 'task') {
    throw new RaindownMcpConfigError({
      kind: 'failure',
      code: 'forbidden',
      message: '派工令牌未绑定 worker 任务',
    })
  }
  const { task } = result.data
  if (
    (opts.binding?.task && opts.binding.task !== task.task_id) ||
    (opts.binding?.workspace &&
      normalizeBindingWorkspace(opts.binding.workspace) !== task.workspace)
  ) {
    throw new RaindownMcpConfigError({
      kind: 'failure',
      code: 'forbidden',
      message: '命令行绑定与派工令牌不一致',
    })
  }
  return {
    ...opts,
    binding: { kind: 'task', workspace: task.workspace, task: task.task_id },
  }
}
