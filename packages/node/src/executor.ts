import type { Activity, BlockedReason, Result, TaskContract, TaskResult } from '@flow/core'
import { executorCapability } from '@flow/core'

/**
 * 执行器插件接口（design D6；node-protocol "执行器插件接口"）与注册表。
 * 真实执行器在变更 ② 实现；本变更只提供 fake 执行器（`fake.ts`）。
 */

export interface ExecutorContext {
  taskId: string
  /** 第几次尝试，从 1 开始。 */
  attempt: number
  /** 工作目录：合同的 cwd，缺省时由节点决定。 */
  cwd: string
  /** 节点 id，写入结果的 node_id。 */
  nodeId: string
  /** 取消信号：节点在续约响应中得知取消、超时、租约丢失或节点停止时触发。 */
  signal: AbortSignal
}

/** 执行器的最终结果：done / failed 附带结果，blocked 附带原因与说明。 */
export type ExecutorOutcome =
  | { outcome: 'done'; result: TaskResult }
  | { outcome: 'failed'; result: TaskResult }
  | { outcome: 'blocked'; reason: BlockedReason; message: string; tail?: string[] }
  | { outcome: 'cancelled'; message?: string }

export interface ExecutorRun {
  /** 活动事件流；节点负责批量随续约上报。执行结束时执行器应结束这个流。 */
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

export interface ExecutorRegistry {
  get(type: string): ExecutorPlugin | undefined
  list(): ExecutorPlugin[]
  /** 执行器贡献的能力：每个插件一个 `executor:<type>`。 */
  capabilities(): string[]
  /** 注册时上报的执行器信息。 */
  info(): Array<{ type: string; mode?: 'interactive' | 'headless' }>
}

/** 执行器注册表；同一类型重复注册时抛出。 */
export function createExecutorRegistry(plugins: readonly ExecutorPlugin[]): ExecutorRegistry {
  const byType = new Map<string, ExecutorPlugin>()
  for (const p of plugins) {
    if (byType.has(p.type)) throw new Error(`执行器 ${p.type} 重复注册`)
    byType.set(p.type, p)
  }
  return {
    get: (type) => byType.get(type),
    list: () => [...byType.values()],
    capabilities: () => [...byType.keys()].map(executorCapability).sort(),
    info: () =>
      [...byType.values()].map((p) => ({ type: p.type, ...(p.mode ? { mode: p.mode } : {}) })),
  }
}

/** 简单的异步队列：执行器 push 活动，节点 for-await 消费；close 后迭代结束。 */
export class ActivityQueue implements AsyncIterable<Activity> {
  private items: Activity[] = []
  private waiting: ((r: IteratorResult<Activity>) => void) | undefined
  private closed = false

  push(item: Activity) {
    if (this.closed) return
    if (this.waiting) {
      const w = this.waiting
      this.waiting = undefined
      w({ value: item, done: false })
    } else this.items.push(item)
  }

  close() {
    this.closed = true
    if (this.waiting) {
      const w = this.waiting
      this.waiting = undefined
      w({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Activity> {
    return {
      next: () => {
        const item = this.items.shift()
        if (item !== undefined) return Promise.resolve({ value: item, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => {
          this.waiting = resolve
        })
      },
    }
  }
}
