import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { hostname as osHostname } from 'node:os'
import { dirname } from 'node:path'
import {
  type Activity,
  type CompleteLeaseRequest,
  fail,
  flowPaths,
  LEDGER_ID_RE,
  type LeaseGrant,
  loadHubConfig,
  loadNodeConfig,
  ok,
  type Result,
  resolveHubUrl,
  VERSION,
} from '@flow/core'
import { createNodeHubClient, type FetchLike, type NodeHubClient } from './client.ts'
import { type NodeClock, sleep, systemClock } from './clock.ts'
import {
  createExecutorRegistry,
  type ExecutorOutcome,
  type ExecutorPlugin,
  type ExecutorRegistry,
  type ExecutorRun,
} from './executor.ts'
import { createFakeExecutor } from './fake.ts'

/**
 * `flow node` 执行节点（tasks.md 4.3；design D6；node-protocol spec）。
 *
 * - 身份：`state/node-id`，首次启动时生成；
 * - 注册 → 领取循环（long-poll）→ 每个租约一个 LeaseRunner：执行器 + 续约循环（TTL/3）
 *   + 活动批量随续约上报 + 取消处理 + 提交结束；
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
}

/** 一个租约的生命周期：执行器、续约循环、提交。 */
class LeaseRunner {
  private buffer: Activity[] = []
  private abort = new AbortController()
  private cancelRenew = () => {}
  private cancelTimeout = () => {}
  private renewing: Promise<void> | undefined
  private renewAgain = false
  private run: ExecutorRun | undefined
  /** 中枢在续约响应中要求取消。 */
  private cancelRequested = false
  private timedOut = false
  /** 租约已不属于本节点（过期、被处理、令牌不符）或节点停止：不再续约，也不提交。 */
  private released = false
  readonly finished: Promise<void>

  constructor(
    private readonly env: Env,
    readonly grant: LeaseGrant,
  ) {
    this.finished = this.execute()
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
    this.abort.abort()
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
    const r = await this.env.client.renew(this.grant.lease_id, {
      lease_token: this.grant.lease_token,
      activity: batch,
    })
    if (this.released) return
    if (!r.ok) {
      if (r.error.kind === 'retryable') {
        this.buffer.unshift(...batch)
        this.scheduleRenew(Math.min(this.intervalMs, this.env.retryMs))
        return
      }
      this.env.logger.warn(`租约 ${this.grant.lease_id} 续约被拒绝，放弃任务`, r.error.code)
      this.release()
      await this.run?.cancel().catch(() => {})
      return
    }
    if (this.buffer.length > 0) this.renewAgain = true
    if (r.data.cancel_requested && !this.cancelRequested) {
      this.cancelRequested = true
      this.abort.abort()
      await this.run?.cancel().catch(() => {})
    }
    this.scheduleRenew()
  }

  private async execute() {
    const { grant, env } = this
    const executor = env.registry.get(grant.contract.executor)
    let outcome: Result<ExecutorOutcome>
    this.scheduleRenew()
    if (!executor) {
      outcome = fail('failure', 'unknown_executor', `节点没有执行器 ${grant.contract.executor}`)
    } else {
      this.cancelTimeout = env.clock.setTimeout(() => {
        this.timedOut = true
        this.abort.abort()
        void this.run?.cancel().catch(() => {})
      }, grant.contract.timeout_s * 1000)
      try {
        this.run = executor.run(grant.contract, {
          taskId: grant.task_id,
          attempt: grant.attempt,
          cwd: grant.contract.cwd ?? env.defaultCwd,
          nodeId: env.nodeId,
          signal: this.abort.signal,
        })
        const pump = (async () => {
          for await (const a of this.run?.activity ?? []) {
            this.buffer.push(a)
            if (this.buffer.length > ACTIVITY_BUFFER_MAX) this.buffer.shift()
          }
        })().catch(() => {})
        outcome = await this.run.done
        // 等执行器把剩余活动交出来（执行器结束时应关闭活动流），最多等一个续约周期。
        await Promise.race([pump, sleep(env.clock, this.intervalMs)])
      } catch (err) {
        outcome = fail('failure', 'executor_error', (err as Error).message)
      }
      this.cancelTimeout()
    }
    if (this.released) return
    // 最后一批活动随一次续约送达，再提交结束。
    if (this.buffer.length > 0) await this.renewNow()
    if (this.released) return
    await this.submit(this.completion(outcome))
  }

  private completion(outcome: Result<ExecutorOutcome>): CompleteLeaseRequest {
    const token = { lease_token: this.grant.lease_token }
    const failed = (summary: string): CompleteLeaseRequest => ({
      ...token,
      outcome: 'failed',
      result: {
        summary,
        artifacts: [],
        verify: [],
        executor: this.grant.contract.executor,
        node_id: this.env.nodeId,
      },
    })
    if (!outcome.ok) {
      return {
        ...token,
        outcome: 'blocked',
        blocked_reason: 'crashed',
        message: outcome.error.message,
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
          ...(o.tail ? { tail: o.tail.slice(-200) } : {}),
        }
      case 'cancelled':
        if (this.cancelRequested) {
          return { ...token, outcome: 'cancelled', ...(o.message ? { message: o.message } : {}) }
        }
        if (this.timedOut) {
          return failed(`执行超时（timeout_s=${this.grant.contract.timeout_s}）`)
        }
        return {
          ...token,
          outcome: 'blocked',
          blocked_reason: 'crashed',
          message: o.message ?? '执行器自行中止',
        }
    }
  }

  /** 提交结束：可重试的错误持续重试（期间续约照常），其他错误放弃。 */
  private async submit(req: CompleteLeaseRequest) {
    for (;;) {
      if (this.released) return
      const r = await this.env.client.complete(this.grant.lease_id, req)
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

  let token = options.token
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
    actor: `node:${nodeId}`,
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
  }

  const runners = new Set<LeaseRunner>()
  const stopper = new AbortController()
  let slotWake: (() => void) | undefined
  let acquireAbort: AbortController | undefined
  let cancelJump = () => {}

  const startRunner = (grant: LeaseGrant) => {
    const runner = new LeaseRunner(env, grant)
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
      if (r.data.lease) startRunner(r.data.lease)
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
