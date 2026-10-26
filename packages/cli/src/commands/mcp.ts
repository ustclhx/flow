import { ok } from '@flow/core'
import { checkMcpActor, resolveMcpBinding, startStdioServer } from '@flow/mcp'
import { defineCommand } from '../command.ts'

/**
 * `flow mcp --actor <name>`：以 stdio 传输启动 MCP 服务（knowledge-access "两种接口等价"）。
 * 服务运行期间 stdout 只能输出协议消息，因此日志一律改走 stderr；客户端断开后正常退出。
 */
export const mcpCommand = defineCommand({
  name: 'mcp',
  summary: '以 stdio 传输启动 MCP 服务，把全部知识访问操作暴露为工具（需要 --actor）',
  usage: 'mcp --actor <name> [--workspace <ws> [--task <id>] [--reply-only]]',
  options: {
    workspace: {
      type: 'string',
      description: '绑定 workspace：写类操作只能作用于它（supervisor 会话，由节点注入）',
    },
    task: { type: 'string', description: '绑定任务：task_create 未写 parent 时以它为 parent' },
    'reply-only': {
      type: 'boolean',
      description: 'reply 唤醒：只放行只读操作（中枢仍是最终裁决）',
    },
  },
  run: async ({ actor, actorGiven, options }) => {
    const bad = checkMcpActor(actorGiven ? actor : undefined)
    if (bad) return { ok: false, error: bad }
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
    const bindingOptions = {
      workspace: str(options.workspace),
      task: str(options.task),
      replyOnly: options['reply-only'] === true,
    }
    const bound = resolveMcpBinding(bindingOptions)
    if (!bound.ok) return { ok: false, error: bound.error }
    // 防御：任何误用 console.log 的代码都不能污染协议通道。
    console.log = console.error
    console.info = console.error
    console.debug = console.error
    const { closed } = await startStdioServer({ actor, binding: bindingOptions })
    await closed
    return ok(null)
  },
  human: () => '',
})
