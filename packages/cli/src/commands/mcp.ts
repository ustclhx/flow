import { ok } from '@flow/core'
import { checkMcpActor, startStdioServer } from '@flow/mcp'
import { defineCommand } from '../command.ts'

/**
 * `flow mcp --actor <name>`：以 stdio 传输启动 MCP 服务（knowledge-access "两种接口等价"）。
 * 服务运行期间 stdout 只能输出协议消息，因此日志一律改走 stderr；客户端断开后正常退出。
 */
export const mcpCommand = defineCommand({
  name: 'mcp',
  summary: '以 stdio 传输启动 MCP 服务，把全部知识访问操作暴露为工具（需要 --actor）',
  usage: 'mcp --actor <name>',
  run: async ({ actor, actorGiven }) => {
    const bad = checkMcpActor(actorGiven ? actor : undefined)
    if (bad) return { ok: false, error: bad }
    // 防御：任何误用 console.log 的代码都不能污染协议通道。
    console.log = console.error
    console.info = console.error
    console.debug = console.error
    const { closed } = await startStdioServer({ actor })
    await closed
    return ok(null)
  },
  human: () => '',
})
