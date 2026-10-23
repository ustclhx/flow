import {
  operations as allOperations,
  type FlowError,
  fail,
  invokeOperation,
  isValidActor,
  type Operation,
  resolveFlowHome,
  toJsonDocument,
  USER_ACTOR,
  VERSION,
} from '@flow/core'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

/**
 * `flow mcp` 的 MCP 适配层（design D1）：遍历 core 的 `operations`，每个操作生成一个工具。
 * 这里不允许出现任何针对具体操作的分支；输入校验、执行与 JSON 渲染都交给 core 的共享函数，
 * 与 CLI `--json` 的输出逐字节一致。
 */

export interface FlowMcpServerOptions {
  /** 操作者标识，写入提交记录并用于 AI 写入边界判断；不允许为 `user`（design D8）。 */
  actor: string
  /** flow-home 路径；省略时每次调用按 `FLOW_HOME` / `~/flow-home` 解析。 */
  home?: string
  /** 暴露的操作列表，默认是 core 的全部 `operations`（测试可传入 fixture）。 */
  operations?: readonly Operation<never, unknown>[]
}

/** MCP 启动参数错误；CLI 据此以用法错误（退出码 2）退出。 */
export class FlowMcpConfigError extends Error {
  constructor(readonly error: FlowError) {
    super(error.message)
    this.name = 'FlowMcpConfigError'
  }
}

/** 校验 MCP 的 actor：必须提供、格式合法，且不能是 `user`（MCP 调用方一定是 AI harness）。 */
export function checkMcpActor(actor: string | undefined): FlowError | null {
  if (actor === undefined || actor === '') {
    return {
      kind: 'usage',
      code: 'actor_required',
      message: 'flow mcp 需要 --actor <name>（例如 claude、codex、pi）',
    }
  }
  if (!isValidActor(actor)) {
    return {
      kind: 'usage',
      code: 'invalid_actor',
      message: `不合法的 actor：${JSON.stringify(actor)}（只能包含字母、数字与 . _ : @ -，最长 64 个字符）`,
    }
  }
  if (actor === USER_ACTOR) {
    return {
      kind: 'usage',
      code: 'invalid_actor',
      message: 'flow mcp 的 actor 不能是 user：MCP 调用方是 AI harness，须遵守 AI 写入边界',
    }
  }
  return null
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

/** 创建 MCP 服务（尚未连接传输）。actor 不合法时抛出 `FlowMcpConfigError`。 */
export function createFlowMcpServer(opts: FlowMcpServerOptions): Server {
  const bad = checkMcpActor(opts.actor)
  if (bad) throw new FlowMcpConfigError(bad)
  const ops = opts.operations ?? allOperations
  const byName = new Map(ops.map((op) => [op.name, op]))
  if (byName.size !== ops.length) {
    throw new Error('operations 中存在重名的操作')
  }
  const tools = ops.map(toolFromOperation)

  // 这里需要直接给出由 zod 生成的 JSON Schema，因此使用低层 Server 而不是 McpServer。
  const server = new Server(
    { name: 'flow', version: VERSION },
    { capabilities: { tools: { listChanged: false } } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const op = byName.get(req.params.name)
    const result = op
      ? await invokeOperation(op, req.params.arguments ?? {}, {
          home: opts.home ?? resolveFlowHome(process.env),
          actor: opts.actor,
          via: 'mcp',
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
export async function startStdioServer(opts: FlowMcpServerOptions): Promise<StdioServerHandle> {
  const server = createFlowMcpServer(opts)
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
