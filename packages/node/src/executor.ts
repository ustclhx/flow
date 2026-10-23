import type { Activity, BlockedReason, Result, TaskContract, TaskResult } from '@flow/core'

/**
 * 执行器插件接口（design D6；node-protocol "执行器插件接口"）。
 * 本文件只定义契约；注册表、fake 执行器与节点循环在第 4 组（4.3）实现，
 * 真实执行器在变更 ② 实现。
 */

export interface ExecutorContext {
  taskId: string
  /** 第几次尝试，从 1 开始。 */
  attempt: number
  /** 工作目录：合同的 cwd，缺省时由节点决定。 */
  cwd: string
  /** 节点 id，写入结果的 node_id。 */
  nodeId: string
  /** 取消信号：节点在续约响应中得知取消，或超时后触发。 */
  signal: AbortSignal
}

/** 执行器的最终结果：done / failed 附带结果，blocked 附带原因与说明。 */
export type ExecutorOutcome =
  | { outcome: 'done'; result: TaskResult }
  | { outcome: 'failed'; result: TaskResult }
  | { outcome: 'blocked'; reason: BlockedReason; message: string; tail?: string[] }
  | { outcome: 'cancelled'; message?: string }

export interface ExecutorRun {
  /** 活动事件流；节点负责批量随续约上报。 */
  activity: AsyncIterable<Activity>
  /** 最终结果；执行器自身的意外错误以 `fail` 返回。 */
  done: Promise<Result<ExecutorOutcome>>
  /** 请求停止；之后 done 应尽快以 cancelled 结束。 */
  cancel(): Promise<void>
}

export interface ExecutorPlugin {
  /** 执行器类型，与合同的 executor 一致；节点据此自动贡献能力 `executor:<type>`。 */
  type: string
  /** 交互式或无头（变更 ② 使用）。 */
  mode?: 'interactive' | 'headless'
  /** 执行器额外要求节点具备的能力（例如 `browser`）。 */
  requires?: readonly string[]
  run(contract: TaskContract, ctx: ExecutorContext): ExecutorRun
}
