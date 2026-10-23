import type { z } from 'zod'
import type { Result } from '../result.ts'

/**
 * 知识访问操作的唯一定义处（design D1）。CLI 子命令与 MCP 工具都由这里的定义自动生成，
 * 输入 schema、权限规则与输出因此天然一致（knowledge-access "两种接口等价"）。
 */

export interface OpContext {
  home: string
  /** 操作者标识；CLI 默认 `user`，MCP 由 `--actor` 指定（design D8）。 */
  actor: string
  /** 调用入口，用于记录来源，例如随手记的 `source`。 */
  via: 'cli' | 'mcp'
}

export interface Operation<I = Record<string, unknown>, O = unknown> {
  /** MCP 工具名，snake_case，例如 `kb_journal`。 */
  name: string
  /** CLI 命令路径，例如 `kb journal`。 */
  cli: string
  summary: string
  /** 输入 schema，必须是 z.object；字段名即 MCP 参数名，CLI 选项名为其 kebab-case。 */
  input: z.ZodObject
  /**
   * CLI 位置参数依次映射到的字段。最后一个字段若为数组则吸收全部剩余参数；
   * 若为字符串则把剩余参数以空格连接（便于 `flow capture 一句话不用加引号`）。
   */
  positional?: readonly string[]
  /** CLI 可从 --file 读取完整 JSON 输入；不改变 MCP 输入合同。 */
  fileInput?: boolean
  run(input: I, ctx: OpContext): Promise<Result<O>>
  /** CLI 人类可读输出；省略时输出缩进 JSON。 */
  human?(output: O): string
}

export const defineOperation = <I, O>(op: Operation<I, O>): Operation<I, O> => op
