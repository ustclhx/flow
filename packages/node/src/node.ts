import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { hostname as osHostname } from 'node:os'
import { dirname } from 'node:path'
import {
  type Activity,
  type BlockedReason,
  type CompleteLeaseRequest,
  clipTail,
  clipText,
  DEFAULT_NO_PROGRESS_MINUTES,
  type DeliveredReply,
  fail,
  flowPaths,
  HUB_TOKEN_ENV,
  LEDGER_ID_RE,
  type LeaseGrant,
  loadHubConfig,
  loadNodeConfig,
  loadRoles,
  ok,
  PROTOCOL_MESSAGE_MAX,
  type Result,
  redactLines,
  resolveHubUrl,
  type TaskContract,
  VERSION,
} from '@flow/core'
import { createNodeHubClient, type FetchLike, type NodeHubClient } from './client.ts'
import { type NodeClock, sleep, systemClock } from './clock.ts'
import { executorEnv } from './env.ts'
import {
  createExecutorRegistry,
  type DeliverResult,
  type ExecutorOutcome,
  type ExecutorPlugin,
  type ExecutorRegistry,
  type ExecutorRun,
  isIdleSignal,
  isResumedSignal,
  type StuckVerdict,
} from './executor.ts'
import { createFakeExecutor } from './fake.ts'
import { createPolicyPrecheck } from './precheck.ts'
import { verifyTask } from './verify.ts'

/**
 * `flow node` 执行节点（tasks.md 4.3；design D6；node-protocol spec）。
 *
 * - 身份：`state/node-id`，首次启动时生成；
 * - 注册 → 领取循环（long-poll）→ 每个租约一个 LeaseRunner：执行器 + 续约循环（TTL/3）
 *   + 活动批量随续约上报 + 取消处理 + 卡住检测与回复送达（add-m1-executors 1.2）+ 提交结束；
 * - 时钟跳变检测：墙钟比单调时钟多走超过 30 秒（睡眠唤醒）时立即续约全部租约（D5）；
 * - 并发上限：同时持有的租约数不超过 concurrency；
 * - `stop()` 不提交结果：停止续约并取消执行器，租约到期后由中枢按合同处理（与进程被杀一致）。
 */

export interface NodeLogger {
  info(message: string, details?: unknown): void
  warn(message: string, details?: unknown): void
}

const consoleLogger: NodeLogger = {
  info: (m, d) => console.error(m, d ?? ''),
  warn: (m, d) => console.error(m, d ?? ''),
}

export interface StartNodeOptions {
  home: string
  clock?: NodeClock
  /** 执行器插件；默认只有 fake。 */
  executors?: readonly ExecutorPlugin[]
  /** 中枢地址；默认按 node.yaml 的 hub_url 或 hub.yaml 的端口。 */
  hubUrl?: string
  /** 中枢 token；默认读取 `state/hub.token`。 */
  token?: string
  fetch?: FetchLike
  hostname?: string
  /** 覆盖 `state/node-id`（同一 flow-home 上运行多个节点的测试用）。 */
  nodeId?: string
  version?: string
  /** 额外能力（与 node.yaml 合并）。 */
  capabilities?: readonly string[]
  /** 覆盖 node.yaml 的 concurrency。 */
  concurrency?: number
  /** long-poll 等待秒数，默认 30（中枢按 lease_wait_max_s 截断）。 */
  waitS?: number
  /** 中枢不可用等错误后的重试间隔，默认 1000 毫秒。 */
  retryMs?: number
  /** 时钟跳变阈值，默认 30 秒。 */
  jumpThresholdMs?: number
  /** 合同没有 cwd 时的工作目录，默认 flow-home。 */
  defaultCwd?: string
  /**
   * 角色设定的无进展阈值（分钟）。合同的 `no_progress_minutes` 优先，缺省为 15 分钟。
   * 不传时按合同的角色读取 `config/roles/<role>.yaml` 的 `no_progress_minutes`。
   */
  noProgressMinutes?: NoProgressResolver
  /** 超时后等待执行器响应取消的毫秒数，默认 10 秒。 */
  timeoutGraceMs?: number
  /** deliver 超过多少毫秒记警告（不重送），默认 60 秒。 */
  deliverTimeoutMs?: number
  /** deliver 超过多少毫秒仍无结果就按 not_running 处理，默认 10 分钟。 */
  deliverGiveUpMs?: number
  /** 策略预检的超时毫秒（add-m1-inbox 2.3），默认 5 秒；超时按需要用户处理。 */
  precheckTimeoutMs?: number
  logger?: NodeLogger
}

export interface RunningNode {
  nodeId: string
  hubUrl: string
  capabilities: string[]
  /** 当前持有的租约数。 */
  active(): number
  /** 停止领取、取消执行器、不提交结果；可重复调用。 */
  stop(): Promise<void>
}

export const JUMP_THRESHOLD_MS = 30_000
const JUMP_CHECK_MS = 1_000
const ACTIVITY_PER_RENEW = 500
const ACTIVITY_BUFFER_MAX = 5_000

/** 由主机名派生的节点 id：`n-<主机名>-<6 位十六进制>`。 */
export function generateNodeId(host: string, random = () => randomBytes(3).toString('hex')) {
  const slug =
    host
      .toLowerCase()
      .replace(/\.local$/, '')
      .replace(/[^a-z0-9_.-]+/g, '-')
      .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
      .slice(0, 40) || 'node'
  return `n-${slug}-${random()}`
}

/** 读取 `state/node-id`；不存在时生成并保存。 */
export async function loadOrCreateNodeId(home: string, host: string): Promise<Result<string>> {
  const path = flowPaths(home).nodeId
  if (existsSync(path)) {
    const id = (await readFile(path, 'utf8')).trim()
    if (!LEDGER_ID_RE.test(id)) {
      return fail('failure', 'invalid_node_id', `${path} 中的节点 id 不合法：${id}`)
    }
    return ok(id)
  }
  const id = generateNodeId(host)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${id}\n`, { mode: 0o644 })
  return ok(id)
}

interface Env {
  nodeId: string
  client: NodeHubClient
  clock: NodeClock
  registry: ExecutorRegistry
  logger: NodeLogger
  retryMs: number
  defaultCwd: string
  /** 角色设定的无进展阈值（分钟），来自 `config/roles/`。 */
  roleNoProgressMinutes: NoProgressResolver | undefined
  timeoutGraceMs: number
  deliverTimeoutMs: number
  deliverGiveUpMs: number
  precheckTimeoutMs: number | undefined
}

/** 按合同（通常按角色）给出无进展阈值分钟数；返回 undefined 表示没有设定。 */
export type NoProgressResolver = (contract: TaskContract) => number | undefined

/**
 * 无进展阈值（stuck-detection "无进展超时"）：合同的 `no_progress_minutes` 优先，
 * 其次是角色设定（`resolver`，由角色配置提供），最后是默认的 15 分钟。返回毫秒。
 */
export function noProgressMs(contract: TaskContract, resolver?: NoProgressResolver): number {
  const minutes =
    contract.no_progress_minutes ?? resolver?.(contract) ?? DEFAULT_NO_PROGRESS_MINUTES
  return Math.max(1, Math.round(minutes * 60_000))
}

type RenewSignal =
  | { blocked: { reason: BlockedReason; message: string; tail?: string[]; session?: string } }
  | { resumed: { note: string } }
  | { phase: 'verifying' }

/** 节点上报 blocked 时附带的末尾输出行数（stuck-detection "卡住的原因分类"）。 */
export const STUCK_TAIL_LINES = 40
const TAIL_KEEP = 200
/** 超时后等待执行器响应取消的宽限时间；过后不再等待，直接提交 failed(timeout)。 */
export const TIMEOUT_GRACE_MS = 10_000
/** deliver 超过这个时长只记警告：不重送，继续等待结果（避免重复送达）。 */
export const DELIVER_TIMEOUT_MS = 60_000
/** deliver 超过这个时长仍无结果：按 not_running 处理，带着回复重新排队并取消当前 worker。 */
export const DELIVER_GIVE_UP_MS = 10 * 60_000

/** 上报前按协议上限截断说明与末尾输出（超长的请求会被中枢拒绝）。 */
function clipBlocked<T extends { message: string; tail?: string[] | undefined }>(b: T): T {
  return {
    ...b,
    message: clipText(b.message, PROTOCOL_MESSAGE_MAX),
    ...(b.tail ? { tail: clipTail(b.tail) } : {}),
  }
}

function clipCompletion(req: CompleteLeaseRequest): CompleteLeaseRequest {
  if (req.outcome === 'blocked') return clipBlocked(req)
  if (req.outcome === 'cancelled' && req.message !== undefined) {
    return { ...req, message: clipText(req.message, PROTOCOL_MESSAGE_MAX) }
  }
  return req
}

/**
 * 一个租约的生命周期：执行器、续约循环、卡住检测、回复送达、提交（add-m1-executors 1.2）。
 *
 * 卡住检测（stuck-detection spec）：
 * - 执行器在活动流中报告 idle：调用 `classify` 判定原因，无法识别时为 other；
 * - 超过无进展阈值没有任何活动：先问 `classify`，没有判定时为 no_progress；
 *   以上两种 worker 仍然活着，经续约上报 `blocked`（lease_held=true），租约继续持有（D7a）；
 * - 执行器进程意外退出（`exited` 或执行器错误）：提交 blocked(crashed)，附退出码与末尾输出；
 * - 运行时间超过 `timeout_s`（不含 blocked 等待回复的时间）：停止执行器，提交 failed（reason=timeout）；
 *   执行器在宽限时间内不响应取消也照样提交。
 *
 * 回复送达（task-interaction "送达与恢复"）：blocked 期间续约响应带回复时交给 `deliver`，
 * 再用 ack-reply 报告结果；同一条回复只交给执行器一次，确认失败时只重试确认。
 */
class LeaseRunner {
  private buffer: Activity[] = []
  private abort = new AbortController()
  private cancelRenew = () => {}
  private cancelTimeout = () => {}
  private cancelIdle = () => {}
  private cancelGrace = () => {}
  private renewing: Promise<void> | undefined
  private renewAgain = false
  private run: ExecutorRun | undefined
  private executor: ExecutorPlugin | undefined
  /** 中枢在续约响应中要求取消。 */
  private cancelRequested = false
  private timedOut = false
  /** 租约已不属于本节点（过期、被处理、令牌不符）或节点停止：不再续约，也不提交。 */
  private released = false
  /** 节点视角的阶段：blocked 表示已判定卡住、等待回复（worker 仍活着）。 */
  private phase: 'running' | 'blocked' | 'verifying' = 'running'
  /** 待随下一次续约上报的状态变化。 */
  private signal: RenewSignal | undefined
  /** 最近的输出行。 */
  private tail: string[] = []
  private lastActivityAt: number
  /** 已交给执行器的回复 id（保证只送达一次）。 */
  private delivered = new Set<string>()
  /** 已交给执行器、尚未被中枢确认的送达结果。 */
  private unacked: { reply_id: string; outcome: DeliverResult } | undefined
  /** 进行中的 deliver（后台执行，不阻塞续约）。 */
  private delivering: Promise<void> | undefined
  /** 执行器已结束：之后不再重新计时。 */
  private runEnded = false
  /** 剩余的超时预算（毫秒）与本段开始计时的单调时间。 */
  private timeoutLeftMs: number
  private timeoutArmedAt = 0
  private forceDone: ((r: Result<ExecutorOutcome>) => void) | undefined
  readonly finished: Promise<void>

  constructor(
    private readonly env: Env,
    readonly grant: LeaseGrant,
  ) {
    this.lastActivityAt = this.mono()
    this.timeoutLeftMs = grant.contract.timeout_s * 1000
    this.finished = this.execute()
  }

  private mono() {
    return this.env.clock.monotonic?.() ?? this.env.clock.now()
  }

  private get intervalMs() {
    return Math.max(100, Math.floor((this.grant.ttl_s * 1000) / 3))
  }

  /** 节点停止：放弃租约，不提交。 */
  async abandon() {
    this.release()
    await this.run?.cancel().catch(() => {})
    await this.finished
  }

  private release() {
    this.released = true
    this.cancelRenew()
    this.cancelTimeout()
    this.cancelIdle()
    this.abort.abort()
    // 不再等执行器：让 execute 尽快退出。
    this.forceDone?.(ok({ outcome: 'cancelled', message: '租约已释放' }))
  }

  private scheduleRenew(ms = this.intervalMs) {
    this.cancelRenew()
    if (this.released) return
    this.cancelRenew = this.env.clock.setTimeout(() => void this.renewNow(), ms)
  }

  /** 立即续约（串行；进行中时合并为下一次）。 */
  renewNow(): Promise<void> {
    if (this.released) return Promise.resolve()
    if (this.renewing) {
      this.renewAgain = true
      return this.renewing
    }
    this.renewing = (async () => {
      do {
        this.renewAgain = false
        await this.renewOnce()
      } while (this.renewAgain && !this.released)
    })().finally(() => {
      this.renewing = undefined
    })
    return this.renewing
  }

  private async renewOnce() {
    this.cancelRenew()
    const batch = this.buffer.splice(0, ACTIVITY_PER_RENEW)
    const signal = this.signal
    this.signal = undefined
    const r = await this.env.client.renew(this.grant.lease_id, {
      lease_token: this.grant.lease_token,
      activity: batch,
      ...(signal && 'blocked' in signal
        ? { blocked: clipBlocked(signal.blocked) }
        : (signal ?? {})),
    })
    if (this.released) return
    if (!r.ok) {
      if (r.error.kind === 'retryable') {
        this.buffer.unshift(...batch)
        // 续约期间产生了更新的状态变化时以新的为准。
        this.signal ??= signal
        this.scheduleRenew(Math.min(this.intervalMs, this.env.retryMs))
        return
      }
      this.env.logger.warn(`租约 ${this.grant.lease_id} 续约被拒绝，放弃任务`, r.error.code)
      this.release()
      await this.run?.cancel().catch(() => {})
      return
    }
    if (this.buffer.length > 0 || this.signal) this.renewAgain = true
    if (r.data.cancel_requested && !this.cancelRequested) {
      this.cancelRequested = true
      this.abort.abort()
      await this.run?.cancel().catch(() => {})
    }
    if (r.data.reply && !this.cancelRequested && !this.unacked) this.deliver(r.data.reply)
    if (this.unacked) await this.ack()
    this.scheduleRenew()
  }

  /**
   * 把回复交给执行器（每条只交一次），结果留待 ack。不阻塞续约循环：送达可能很慢
   * （例如往终端里输入），等它会让租约过期（PR #16 审查第 9 条）。
   * - 执行器明确返回 not_running，或根本不支持 deliver：确认 worker 不在；
   * - deliver 抛出异常：视为临时错误，不确认、不取消执行器，下一次续约再送（第 6 条）。
   */
  private deliver(reply: DeliveredReply) {
    // 执行器已结束就不再送达：交给提交结束的流程，回复随重新排队带到下一次执行。
    if (this.delivered.has(reply.reply_id) || this.released || this.runEnded) return
    this.delivered.add(reply.reply_id)
    const run = this.run
    const { clock, logger, deliverTimeoutMs, deliverGiveUpMs } = this.env
    let settled = false
    let cancelSoft = () => {}
    let cancelHard = () => {}
    const settle = () => {
      settled = true
      cancelSoft()
      cancelHard()
    }
    const record = (outcome: DeliverResult) => {
      if (settled) return
      settle()
      if (this.released) return
      this.unacked = { reply_id: reply.reply_id, outcome }
      void this.renewNow()
    }
    this.delivering = new Promise<void>((resolve) => {
      if (!run?.deliver) {
        record('not_running')
        return resolve()
      }
      // 超时只是不再阻塞：底层 deliver 可能仍在执行，重送会让 worker 收到两次（PR #16 第三轮复核第 2 条）。
      // 所以超时后不重送，回复保持在途，等迟到的结果。
      cancelSoft = clock.setTimeout(() => {
        logger.warn(
          `回复 ${reply.reply_id} 的送达超过 ${deliverTimeoutMs}ms 未返回，继续等待，不重送`,
        )
      }, deliverTimeoutMs)
      // 迟迟没有结果：按 not_running 处理——中枢带着回复重新排队，由下一次执行接收；
      // 确认后本节点取消当前 worker（见 ack），避免两边都收到同一条回复。迟到的结果随后被忽略。
      cancelHard = clock.setTimeout(() => {
        logger.warn(
          `回复 ${reply.reply_id} 的送达超过 ${deliverGiveUpMs}ms 仍无结果，按 not_running 处理`,
        )
        record('not_running')
        resolve()
      }, deliverGiveUpMs)
      run.deliver(reply).then(
        (outcome) => {
          record(outcome)
          resolve()
        },
        (err) => {
          // deliver 明确失败（抛异常）时它已经结束，重送是安全的：视为临时错误，
          // 不确认、不取消执行器，下一次续约重送。
          if (!settled) {
            settle()
            logger.warn(`回复 ${reply.reply_id} 送达失败，下一次续约重试`, String(err))
            this.delivered.delete(reply.reply_id)
          }
          resolve()
        },
      )
    }).finally(() => {
      this.delivering = undefined
    })
  }

  private async ack() {
    const u = this.unacked
    if (!u) return
    const r = await this.env.client.ackReply(this.grant.lease_id, {
      lease_token: this.grant.lease_token,
      reply_id: u.reply_id,
      outcome: u.outcome,
    })
    if (this.released) return
    if (!r.ok) {
      // 可重试的错误下一次续约时再确认；其他错误（例如任务已被取消）放弃确认。
      if (r.error.kind !== 'retryable') {
        this.env.logger.warn(`回复 ${u.reply_id} 的送达确认被拒绝`, r.error.code)
        this.unacked = undefined
        // 中枢若仍把它当作待送达，下一次续约会再次返回它，允许重新送达（PR #16 审查第 8 条）。
        this.delivered.delete(u.reply_id)
      }
      return
    }
    this.unacked = undefined
    if (u.outcome === 'delivered') {
      // 中枢已写入 task.unblocked：回到 running，重新开始计时。
      this.enterRunning()
    } else {
      // worker 已不在：中枢让任务带着回复重新排队，本租约随之结束。
      this.release()
      await this.run?.cancel().catch(() => {})
    }
  }

  private pushTail(text: string) {
    for (const line of text.split('\n')) this.tail.push(line)
    if (this.tail.length > TAIL_KEEP) this.tail.splice(0, this.tail.length - TAIL_KEEP)
  }

  /**
   * 最近的输出：先对完整的缓冲（最多 200 行）脱敏，再取末尾 40 行。
   * 否则截取窗口切掉 `-----BEGIN … PRIVATE KEY-----` 那一行后，私钥正文就认不出来了（第三轮复核第 1 条）。
   */
  private recentTail() {
    return redactLines(this.tail).slice(-STUCK_TAIL_LINES)
  }

  private onActivity(a: Activity) {
    this.buffer.push(a)
    if (this.buffer.length > ACTIVITY_BUFFER_MAX) this.buffer.shift()
    if (a.kind === 'output' && a.text !== undefined) this.pushTail(a.text)
    this.lastActivityAt = this.mono()
    if (isIdleSignal(a)) {
      const hint = a.data?.hint
      this.stuck(
        'idle',
        hint && typeof hint === 'object' ? (hint as Record<string, unknown>) : undefined,
        a.text,
      )
    } else if (isResumedSignal(a)) {
      if (this.phase === 'blocked' && !this.unacked) {
        this.signal = { resumed: { note: a.text ?? 'worker 自行恢复' } }
        this.enterRunning()
        void this.renewNow()
      }
    } else if (this.phase === 'running') this.armIdle()
  }

  /** 判定卡住并经续约上报（lease_held）。 */
  private stuck(trigger: 'idle' | 'no_progress', hint?: Record<string, unknown>, text?: string) {
    if (this.phase !== 'running' || this.released || this.cancelRequested || this.timedOut) return
    const tail = this.recentTail()
    let verdict: StuckVerdict | null = null
    try {
      verdict =
        this.executor?.classify?.({
          trigger,
          tail,
          idle_ms: Math.max(0, this.mono() - this.lastActivityAt),
          ...(hint ? { hint } : {}),
          contract: this.grant.contract,
        }) ?? null
    } catch (err) {
      this.env.logger.warn('执行器的 classify 抛出异常，按未识别处理', String(err))
    }
    const minutes = noProgressMs(this.grant.contract, this.env.roleNoProgressMinutes) / 60_000
    const v: StuckVerdict =
      verdict ??
      (trigger === 'idle'
        ? { reason: 'other', message: text?.trim() || '执行器报告 worker 已停下，未能识别原因' }
        : {
            reason: 'no_progress',
            message: `已经 ${Number(minutes.toFixed(2))} 分钟没有任何新活动`,
          })
    this.phase = 'blocked'
    this.cancelIdle()
    this.pauseTimeout()
    const session = v.session ?? (typeof hint?.session === 'string' ? hint.session : undefined)
    this.signal = {
      blocked: {
        reason: v.reason,
        message: v.message,
        ...(tail.length > 0 ? { tail } : {}),
        ...(session ? { session } : {}),
      },
    }
    void this.renewNow()
  }

  private enterRunning() {
    this.phase = 'running'
    if (this.runEnded) return
    this.lastActivityAt = this.mono()
    this.armIdle()
    this.armTimeout()
  }

  private armIdle() {
    this.cancelIdle()
    if (this.released || this.phase !== 'running') return
    this.cancelIdle = this.env.clock.setTimeout(
      () => this.stuck('no_progress'),
      noProgressMs(this.grant.contract, this.env.roleNoProgressMinutes),
    )
  }

  private armTimeout() {
    this.cancelTimeout()
    if (this.released || this.timedOut) return
    this.timeoutArmedAt = this.mono()
    this.cancelTimeout = this.env.clock.setTimeout(
      () => this.onTimeout(),
      Math.max(0, this.timeoutLeftMs),
    )
  }

  /** blocked 等待回复期间不计入运行时间。 */
  private pauseTimeout() {
    this.cancelTimeout()
    this.cancelTimeout = () => {}
    this.timeoutLeftMs -= Math.max(0, this.mono() - this.timeoutArmedAt)
  }

  private onTimeout() {
    if (this.released) return
    this.timedOut = true
    this.cancelIdle()
    this.abort.abort()
    void this.run?.cancel().catch(() => {})
    this.cancelGrace = this.env.clock.setTimeout(() => {
      this.env.logger.warn(`任务 ${this.grant.task_id} 超时后执行器未响应取消，强制结束`)
      this.forceDone?.(ok({ outcome: 'cancelled', message: '超时后强制结束' }))
    }, this.env.timeoutGraceMs)
  }

  private async execute() {
    const { grant, env } = this
    const executor = env.registry.get(grant.contract.executor)
    this.executor = executor
    let outcome: Result<ExecutorOutcome>
    this.scheduleRenew()
    if (!executor) {
      outcome = fail('failure', 'unknown_executor', `节点没有执行器 ${grant.contract.executor}`)
    } else {
      this.armTimeout()
      this.armIdle()
      try {
        this.run = executor.run(grant.contract, {
          taskId: grant.task_id,
          attempt: grant.attempt,
          cwd: grant.contract.cwd ?? env.defaultCwd,
          nodeId: env.nodeId,
          env: executorEnv(),
          signal: this.abort.signal,
          ...(grant.resume ? { resume: grant.resume } : {}),
          precheck: createPolicyPrecheck({
            client: env.client,
            taskId: grant.task_id,
            cwd: grant.contract.cwd ?? env.defaultCwd,
            clock: env.clock,
            signal: this.abort.signal,
            ...(env.precheckTimeoutMs === undefined ? {} : { timeoutMs: env.precheckTimeoutMs }),
          }),
        })
        const run = this.run
        const forced = new Promise<Result<ExecutorOutcome>>((resolve) => {
          this.forceDone = resolve
        })
        const pump = (async () => {
          for await (const a of run.activity) this.onActivity(a)
        })().catch(() => {})
        outcome = await Promise.race([run.done, forced])
        // 等执行器把剩余活动交出来（执行器结束时应关闭活动流），最多等一个续约周期。
        await Promise.race([pump, forced, sleep(env.clock, this.intervalMs)])
      } catch (err) {
        outcome = fail('failure', 'executor_error', (err as Error).message)
      }
      this.cancelTimeout()
      this.cancelIdle()
      this.cancelGrace()
    }
    this.runEnded = true
    // 回复已交给 worker、worker 随即结束：先把送达确认完（写 task.unblocked），回复才不会被当作丢弃。
    if (this.delivering) await this.delivering
    if (this.unacked && !this.released) await this.ack()
    if (this.released) return
    let req = this.completion(outcome)
    // 卡住期间执行器完成（例如用户直接在终端里答复后 worker 做完了）：blocked 不能直接转 done，
    // 先上报恢复为 running。崩溃或以 blocked 结束时不上报恢复：中枢写 blocked → blocked，
    // 有待送达的回复时带着回复重新排队（PR #16 审查第 5 条）。
    if (this.phase === 'blocked' && req.outcome === 'done') {
      this.phase = 'running'
      this.signal = { resumed: { note: '执行器已结束' } }
    }
    // 最后一批活动与状态变化随续约送达，再提交结束。
    while (!this.released && (this.buffer.length > 0 || this.signal)) {
      await this.renewNow()
      if (this.signal && !this.released) await sleep(env.clock, env.retryMs)
    }
    if (this.released) return
    if (req.outcome === 'done' && grant.contract.verify?.length && !this.cancelRequested) {
      this.phase = 'verifying'
      this.signal = { phase: 'verifying' }
      // 中枢确认阶段切换后才启动命令；可重试错误时保留 signal，期间继续续约。
      while (this.signal && !this.released && !this.cancelRequested) {
        await this.renewNow()
        if (this.signal && !this.released) await sleep(env.clock, env.retryMs)
      }
      if (this.released) return
      const verify = await verifyTask(
        grant.contract.verify,
        // 执行器给出的工作目录优先（codex-orca 在 Orca worktree 里工作，不在合同的 cwd）。
        (outcome.ok && outcome.data.outcome === 'done' ? outcome.data.workdir : undefined) ??
          grant.contract.cwd ??
          env.defaultCwd,
        env.clock,
        this.abort.signal,
      )
      if (this.released) return
      const failed = !this.cancelRequested && verify.some((v) => v.exit_code !== 0 || v.timed_out)
      req = {
        ...req,
        outcome: failed ? 'failed' : 'done',
        result: { ...req.result, verify, ...(failed ? { reason: 'verify_failed' } : {}) },
      }
    }
    if (this.cancelRequested) {
      req = {
        lease_token: grant.lease_token,
        outcome: 'cancelled',
        ...('result' in req ? { result: req.result } : {}),
      }
    }
    await this.submit(req)
  }

  private completion(outcome: Result<ExecutorOutcome>): CompleteLeaseRequest {
    const token = { lease_token: this.grant.lease_token }
    const tail = this.recentTail()
    const withTail = tail.length > 0 ? { tail } : {}
    const failed = (summary: string, reason: string): CompleteLeaseRequest => ({
      ...token,
      outcome: 'failed',
      result: {
        summary,
        artifacts: [],
        verify: [],
        executor: this.grant.contract.executor,
        node_id: this.env.nodeId,
        reason,
      },
    })
    // 超时优先：无论执行器以什么结果收尾，超时的任务都是 failed(timeout)。
    if (this.timedOut && !this.cancelRequested) {
      return failed(
        `执行超时（timeout_s=${this.grant.contract.timeout_s}），执行器已停止`,
        'timeout',
      )
    }
    if (!outcome.ok) {
      return {
        ...token,
        outcome: 'blocked',
        blocked_reason: 'crashed',
        message: `执行器出错（${outcome.error.code}）：${outcome.error.message}`,
        ...withTail,
      }
    }
    const o = outcome.data
    switch (o.outcome) {
      case 'done':
      case 'failed':
        return { ...token, outcome: o.outcome, result: o.result }
      case 'blocked':
        return {
          ...token,
          outcome: 'blocked',
          blocked_reason: o.reason,
          message: o.message,
          ...(o.tail ? { tail: o.tail.slice(-200) } : withTail),
          ...(o.session ? { session: o.session } : {}),
        }
      case 'exited': {
        const how = o.exit_code === null ? `信号 ${o.signal ?? '未知'}` : `退出码 ${o.exit_code}`
        return {
          ...token,
          outcome: 'blocked',
          blocked_reason: 'crashed',
          message: `执行器进程意外退出（${how}）${o.message ? `：${o.message}` : ''}`,
          ...withTail,
        }
      }
      case 'cancelled':
        if (this.cancelRequested) {
          return { ...token, outcome: 'cancelled', ...(o.message ? { message: o.message } : {}) }
        }
        return {
          ...token,
          outcome: 'blocked',
          blocked_reason: 'crashed',
          message: o.message ?? '执行器自行中止',
          ...withTail,
        }
    }
  }

  /** 提交结束：可重试的错误持续重试（期间续约照常），其他错误放弃。 */
  private async submit(req: CompleteLeaseRequest) {
    for (;;) {
      if (this.released) return
      const r = await this.env.client.complete(this.grant.lease_id, clipCompletion(req))
      if (r.ok) break
      if (r.error.kind !== 'retryable') {
        this.env.logger.warn(`租约 ${this.grant.lease_id} 提交被拒绝`, r.error.code)
        break
      }
      await sleep(this.env.clock, this.env.retryMs)
    }
    this.released = true
    this.cancelRenew()
  }
}

export async function startNode(options: StartNodeOptions): Promise<Result<RunningNode>> {
  const { home } = options
  const clock = options.clock ?? systemClock
  const logger = options.logger ?? consoleLogger
  const host = options.hostname ?? osHostname()

  const hubConfig = await loadHubConfig(home)
  if (!hubConfig.ok) return hubConfig
  const nodeConfig = await loadNodeConfig(home)
  if (!nodeConfig.ok) return nodeConfig

  // 本机节点用 user token（options.token 或 state/hub.token），不声明身份：中枢在注册与租约流程中
  // 按 node_id 记为 node:<id>（user token 不能声明 node:*）。设置了 FLOW_HUB_TOKEN 时它是签发给
  // node:<id> 的绑定 token，此时声明同一身份（design D9）。
  const envToken =
    options.token === undefined ? process.env[HUB_TOKEN_ENV]?.trim() || undefined : undefined
  let token = options.token ?? envToken
  if (token === undefined) {
    const path = flowPaths(home).hubToken
    if (!existsSync(path)) {
      return fail('retryable', 'hub_token_missing', `缺少 ${path}，请先启动中枢（flow hub start）`)
    }
    token = (await readFile(path, 'utf8')).trim()
  }

  const id =
    options.nodeId !== undefined ? ok(options.nodeId) : await loadOrCreateNodeId(home, host)
  if (!id.ok) return id
  const nodeId = id.data

  let registry: ExecutorRegistry
  try {
    registry = createExecutorRegistry(options.executors ?? [createFakeExecutor({ clock })])
  } catch (err) {
    return fail('usage', 'invalid_executors', (err as Error).message)
  }
  const capabilities = [
    ...new Set([
      ...nodeConfig.data.capabilities,
      ...(options.capabilities ?? []),
      ...registry.capabilities(),
    ]),
  ].sort()
  const concurrency = options.concurrency ?? nodeConfig.data.concurrency
  const hubUrl = options.hubUrl ?? resolveHubUrl(hubConfig.data, nodeConfig.data)
  const client = createNodeHubClient({
    url: hubUrl,
    token,
    ...(envToken ? { actor: `node:${nodeId}` } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
  const retryMs = options.retryMs ?? 1_000
  const env: Env = {
    nodeId,
    client,
    clock,
    registry,
    logger,
    retryMs,
    defaultCwd: options.defaultCwd ?? home,
    roleNoProgressMinutes: options.noProgressMinutes,
    timeoutGraceMs: options.timeoutGraceMs ?? TIMEOUT_GRACE_MS,
    deliverTimeoutMs: options.deliverTimeoutMs ?? DELIVER_TIMEOUT_MS,
    deliverGiveUpMs: options.deliverGiveUpMs ?? DELIVER_GIVE_UP_MS,
    precheckTimeoutMs: options.precheckTimeoutMs,
  }

  const runners = new Set<LeaseRunner>()
  const stopper = new AbortController()
  let slotWake: (() => void) | undefined
  let acquireAbort: AbortController | undefined
  let cancelJump = () => {}

  /**
   * 角色设定的无进展阈值：显式传入的 resolver 优先；否则每次领到租约时重新读取
   * `config/roles/`（改了角色无需重启节点），读取失败时用默认值。
   */
  const roleResolver = async (): Promise<NoProgressResolver | undefined> => {
    if (options.noProgressMinutes) return options.noProgressMinutes
    const loaded = await loadRoles(home)
    if (!loaded.ok) return undefined
    const minutes = new Map(loaded.data.roles.map((r) => [r.name, r.no_progress_minutes]))
    return (contract) => minutes.get(contract.role)
  }

  const startRunner = async (grant: LeaseGrant) => {
    const resolver = await roleResolver()
    // 读取角色期间节点被停止：不再启动，租约到期后由中枢按合同处理（与 stop 的语义一致）。
    if (stopper.signal.aborted) return
    const runner = new LeaseRunner({ ...env, roleNoProgressMinutes: resolver }, grant)
    runners.add(runner)
    void runner.finished.finally(() => {
      runners.delete(runner)
      slotWake?.()
    })
  }

  const register = () =>
    client.register({
      node_id: nodeId,
      hostname: host,
      version: options.version ?? VERSION,
      capabilities,
      executors: registry.info(),
      concurrency,
    })

  const loop = async () => {
    let registered = false
    while (!stopper.signal.aborted) {
      if (!registered) {
        const r = await register()
        if (r.ok) {
          registered = true
          logger.info(`节点 ${nodeId} 已注册到 ${hubUrl}`, { capabilities })
        } else {
          logger.warn('节点注册失败，稍后重试', r.error.code)
          await sleep(clock, retryMs, stopper.signal)
          continue
        }
      }
      if (runners.size >= concurrency) {
        await new Promise<void>((resolve) => {
          slotWake = resolve
          stopper.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        slotWake = undefined
        continue
      }
      acquireAbort = new AbortController()
      const r = await client.acquire(
        { node_id: nodeId, capabilities, wait_s: options.waitS ?? 30 },
        AbortSignal.any([acquireAbort.signal, stopper.signal]),
      )
      acquireAbort = undefined
      if (stopper.signal.aborted) break
      if (!r.ok) {
        if (r.error.code === 'node_not_registered') registered = false
        else logger.warn('领取任务失败，稍后重试', r.error.code)
        await sleep(clock, retryMs, stopper.signal)
        continue
      }
      if (r.data.lease) await startRunner(r.data.lease)
    }
  }

  // 时钟跳变（睡眠唤醒）：立即续约全部租约。
  const monotonic = clock.monotonic?.bind(clock)
  if (monotonic) {
    const threshold = options.jumpThresholdMs ?? JUMP_THRESHOLD_MS
    let lastWall = clock.now()
    let lastMono = monotonic()
    const check = () => {
      const wall = clock.now()
      const mono = monotonic()
      const jumped = wall - lastWall - (mono - lastMono)
      lastWall = wall
      lastMono = mono
      if (jumped > threshold) {
        logger.info(`检测到时钟跳变 ${Math.round(jumped)}ms（睡眠唤醒），立即续约`)
        for (const r of runners) void r.renewNow()
      }
      if (!stopper.signal.aborted) cancelJump = clock.setTimeout(check, JUMP_CHECK_MS)
    }
    cancelJump = clock.setTimeout(check, JUMP_CHECK_MS)
  }

  const looping = loop().catch((err) => logger.warn('节点循环异常退出', String(err)))

  let stopping: Promise<void> | undefined
  return ok({
    nodeId,
    hubUrl,
    capabilities,
    active: () => runners.size,
    stop() {
      stopping ??= (async () => {
        stopper.abort()
        acquireAbort?.abort()
        cancelJump()
        slotWake?.()
        await Promise.allSettled([...runners].map((r) => r.abandon()))
        await looping
      })()
      return stopping
    },
  })
}
