import { LEASE_TOKEN_FILE_ENV, ok, readRaindownEnv } from '@raindown/core'
import {
  checkMcpActor,
  RaindownMcpConfigError,
  resolveMcpBinding,
  startStdioServer,
} from '@raindown/mcp'
import { defineCommand } from '../command.ts'

/**
 * `raindown mcp --actor <name>`：以 stdio 传输启动 MCP 服务（knowledge-access "两种接口等价"）。
 * 服务运行期间 stdout 只能输出协议消息，因此日志一律改走 stderr；客户端断开后正常退出。
 */
export const mcpCommand = defineCommand({
  name: 'mcp',
  summary: '以 stdio 传输启动 MCP 服务，按派工或唤醒绑定暴露工具（需要 --actor）',
  usage: 'mcp --actor <name> [--task <id>] [--workspace <ws>] [--reply-only]',
  options: {
    workspace: {
      type: 'string',
      description: '绑定 workspace：写类操作只能作用于它（supervisor 会话，由节点注入）',
    },
    task: {
      type: 'string',
      description: '核对派工绑定任务；唤醒会话中作为 task_create 的默认 parent',
    },
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
    // worker 的 --task 可以单独给出，workspace 由中枢按派工凭证核定。
    if (!readRaindownEnv(LEASE_TOKEN_FILE_ENV)) {
      const bound = resolveMcpBinding(bindingOptions)
      if (!bound.ok) return { ok: false, error: bound.error }
    }
    // 防御：任何误用 console.log 的代码都不能污染协议通道。
    console.log = console.error
    console.info = console.error
    console.debug = console.error
    try {
      const { closed } = await startStdioServer({ actor, binding: bindingOptions })
      await closed
      return ok(null)
    } catch (err) {
      if (err instanceof RaindownMcpConfigError) return { ok: false, error: err.error }
      throw err
    }
  },
  human: () => '',
})
