import type { FlowError, Result } from '@flow/core'

export interface OptionSpec {
  type: 'string' | 'boolean'
  short?: string
  multiple?: boolean
  description?: string
}

export interface CommandContext {
  /** 命令名之后的位置参数。 */
  args: string[]
  /** 已解析的选项（不含全局选项）。 */
  options: Record<string, string | boolean | string[] | undefined>
  /** 操作者标识；CLI 默认是 `user`（design D8）。 */
  actor: string
}

export interface Command<T = unknown> {
  /** 以空格分隔的命令路径，例如 `kb search`。 */
  name: string
  summary: string
  usage?: string
  options?: Record<string, OptionSpec>
  run(ctx: CommandContext): Promise<Result<T>>
  /** 人类可读输出；省略时以缩进 JSON 输出 data。 */
  human?(data: T): string
  /** 失败时的补充输出，例如批量操作已经完成的仓库报告。 */
  humanError?(error: FlowError): string
}

export const defineCommand = <T>(command: Command<T>): Command<T> => command
