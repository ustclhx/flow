import type {
  Activity,
  BlockedReason,
  DeliveredReply,
  Result,
  TaskContract,
  TaskResult,
  TaskResume,
} from '@flow/core'
import { executorCapability } from '@flow/core'
import type { Precheck } from './precheck.ts'

/**
 * 执行器插件接口（add-m1-ledger-daemon D6；add-m1-executors D1）与注册表。
 *
 * 节点的通用循环只调用四个方法：`run`、`cancel`、`deliver`（送达回复）、`classify`（判定卡住原因），
 * 再加上一个活动流。执行器经活动流向节点报告两种状态信号（status 活动的 `data`）：
 * - `data.idle === true`：worker 停下了（例如终端连续两次没有忙碌标记、SDK 在等审批）。
 *   节点随即用 `classify` 判定原因并上报 `blocked`，租约继续持有（D7a）；可附 `data.hint` 交给 classify。
 * - `data.resumed === true`：worker 未经回复自行恢复（例如用户直接在终端里答复了），节点上报 `task.unblocked`。
 * 其余卡住情形由节点统一判定：长时间无活动（no_progress）、进程意外退出（crashed）、超时（failed/timeout）。
 */

export interface ExecutorContext {
  taskId: string
  /** 第几次尝试，从 1 开始。 */
  attempt: number
  /** 工作目录：合同 cwd，其次 inputs.repo，缺省时取 workspace 唯一仓库。 */
  cwd: string
  /** 节点 id，写入结果的 node_id。 */
  nodeId: string
  /**
   * 启动 worker 子进程时使用的环境变量，已去掉中枢凭证（`FLOW_HUB_TOKEN`）。执行器 spawn 时
   * 必须用它（或 `executorEnv()`），不要直接传 `process.env`。
   */
  env?: NodeJS.ProcessEnv
  /** 取消信号：节点在续约响应中得知取消、超时、租约丢失或节点停止时触发。 */
  signal: AbortSignal
  /** 任务带着回复重新排队后的这一次执行：上一轮的会话 id 与回复（D6、D7）。 */
  resume?: TaskResume
  /**
   * 策略预检（add-m1-inbox 2.3）：执行器把审批请求交给用户之前先调用，`allow` 时在本地放行。
   * 节点为每个租约绑定任务 id；缺省（例如单元测试直接运行执行器）时执行器一律交给用户。
   */
  precheck?: Precheck
  /**
   * claude-sdk `read_scope: cwd` 的附加参数（add-m1-supervisor D6）：任务私有目录（审查 diff 等），
   * 以及是否允许读 cwd 根下的 `.github/`（审查 worktree）。缺省只允许 cwd，`.github/` 不可读。
   */
  readScope?: {
    privateDir?: string
    allowDotGithub?: boolean
    /** 会话配置了结构化输出（审查任务）：只有这时 `StructuredOutput` 才可用。 */
    structuredOutput?: boolean
  }
}

/** 节点交给 `classify` 的快照。 */
export interface StuckSnapshot {
  /** idle：执行器报告 worker 停下；no_progress：超过无进展阈值没有任何活动。 */
  trigger: 'idle' | 'no_progress'
  /** 最近的输出（末尾 40 行）。 */
  tail: string[]
  /** 距最近一次活动的毫秒数。 */
  idle_ms: number
  /** idle 信号附带的 `data.hint`。 */
  hint?: Record<string, unknown>
  contract: TaskContract
}

/** `classify` 的判定：卡住原因与一句话说明。 */
export interface StuckVerdict {
  reason: BlockedReason
  message: string
  /** 执行器会话 id；任务之后重新排队时随 resume 带给下一次执行。也可放在 idle 信号的 hint.session。 */
  session?: string
}

/** 回复送达结果：worker 已不在运行时返回 not_running，中枢会让任务带着回复重新排队。 */
export type DeliverResult = 'delivered' | 'not_running'

/** 执行器的最终结果：done / failed 附带结果，blocked 附带原因与说明。 */
export type ExecutorOutcome =
  | {
      outcome: 'done'
      result: TaskResult
      /** worker 实际工作的目录（例如 codex-orca 的 Orca worktree）；验收命令在这里运行，缺省为节点解析的合同目录。 */
      workdir?: string
    }
  | { outcome: 'failed'; result: TaskResult }
  | {
      outcome: 'blocked'
      reason: BlockedReason
      message: string
      tail?: string[]
      /** 会话 id：回复后下一次执行据此恢复（无头执行器，D6）。 */
      session?: string
    }
  /** `result`：取消前已产生的结果（例如 pr-merge 已合并后被取消），随 cancelled 一起提交。 */
  | { outcome: 'cancelled'; message?: string; result?: TaskResult }
  /** worker 进程意外退出：节点上报 blocked(crashed)，附退出码与末尾输出。 */
  | { outcome: 'exited'; exit_code: number | null; signal?: string; message?: string }

export interface ExecutorRun {
  /** 活动事件流；节点负责批量随续约上报。执行结束时执行器应结束这个流。 */
  activity: AsyncIterable<Activity>
  /** 最终结果；执行器自身的意外错误以 `fail` 返回。 */
  done: Promise<Result<ExecutorOutcome>>
  /** 请求停止；之后 done 应尽快以 cancelled 结束。 */
  cancel(): Promise<void>
  /**
   * 把回复送给正在运行的 worker；没有实现时视为 not_running。
   * 应当按 `reply_id` 幂等：同一个 reply_id 再次送达时不得让 worker 收到第二次
   * （节点在 deliver 抛异常后会重送，网络重试也可能导致重复调用）。
   * 返回 not_running 只用于确认 worker 已不在；临时失败请抛出异常。
   */
  deliver?(reply: DeliveredReply): Promise<DeliverResult>
}

export interface ExecutorPlugin {
  /** 执行器类型，与合同的 executor 一致；节点据此自动贡献能力 `executor:<type>`。 */
  type: string
  /** 交互式或无头（变更 ② 使用）。 */
  mode?: 'interactive' | 'headless'
  /** 执行器额外要求节点具备的能力（例如 `browser`）。 */
  requires?: readonly string[]
  run(contract: TaskContract, ctx: ExecutorContext): ExecutorRun
  /** 执行器自己的卡住识别规则；无法识别时返回 null（节点归为 other 或 no_progress）。 */
  classify?(snapshot: StuckSnapshot): StuckVerdict | null
  /**
   * 节点启动时（领取任务之前）调用一次：清理上一次运行留下的残留（例如 claude-sdk 的审查 worktree）。
   * 失败只记警告，不阻止节点启动。
   */
  prepare?(info: { nodeId: string }): Promise<void>
}

/** 活动是否为"worker 停下了"的信号。 */
export const isIdleSignal = (a: Activity): boolean => a.kind === 'status' && a.data?.idle === true
/** 活动是否为"worker 自行恢复"的信号。 */
export const isResumedSignal = (a: Activity): boolean =>
  a.kind === 'status' && a.data?.resumed === true

/** 构造 idle 信号。 */
export function idleSignal(ts: string, text: string, hint?: Record<string, unknown>): Activity {
  return { ts, kind: 'status', text, data: { idle: true, ...(hint ? { hint } : {}) } }
}

/** 构造 resumed 信号。 */
export function resumedSignal(ts: string, text: string): Activity {
  return { ts, kind: 'status', text, data: { resumed: true } }
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
