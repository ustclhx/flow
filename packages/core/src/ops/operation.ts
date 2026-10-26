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
  /**
   * MCP 会话绑定（add-m1-supervisor D6；tasks 4.1）：`flow mcp --workspace <ws> --task <id>`。
   * 只是本地预检，经中枢的写操作最终以中枢的唤醒绑定 token 为准；见 `applyBinding`。
   */
  binding?: OpBinding
}

/** MCP 会话绑定的 workspace 与任务。 */
export interface OpBinding {
  /** 绑定的 workspace，完整引用 `ws/<id>`。 */
  workspace: string
  /** 绑定的任务（supervisor 唤醒任务）；`task_create` 未写 parent 时以它为 parent。 */
  task?: string
  /** reply 唤醒（origin reply）：本地只放行只读操作与 `replyAllowed` 的操作（D15）。 */
  replyOnly?: boolean
}

export interface Operation<I = Record<string, unknown>, O = unknown> {
  /** MCP 工具名，snake_case，例如 `kb_journal`。 */
  name: string
  /** CLI 命令路径，例如 `kb journal`。 */
  cli: string
  /** CLI 的等价入口，由相同操作生成命令。 */
  cliAliases?: readonly string[]
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
  /**
   * 读写类别（tasks 4.1）：`read` 不受 MCP 绑定的写限制；缺省视为写类。
   * 绑定为 reply 唤醒时，写类操作一律 `reply_only_wake`（`replyAllowed` 的除外）。
   */
  access?: 'read' | 'write'
  /** reply 唤醒也可调用的写类操作（例如以后的 `task_respond`）。 */
  replyAllowed?: boolean
  /**
   * 会话绑定 workspace 时对输入的本地检查与改写（输入已通过 schema 校验）：
   * 例如写别的 workspace 返回 `workspace_mismatch`、`task_create` 自动填 parent。
   * 没有它的写类操作在本地不做 workspace 检查，由中枢按 token 裁决。
   */
  bind?(input: I, binding: OpBinding): Result<I>
  run(input: I, ctx: OpContext): Promise<Result<O>>
  /** CLI 人类可读输出；省略时输出缩进 JSON。 */
  human?(output: O): string
}

export const defineOperation = <I, O>(op: Operation<I, O>): Operation<I, O> => op
