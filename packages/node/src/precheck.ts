import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { type PolicyCheckData, type PolicyDecisionLevel, redactSecrets } from '@flow/core'
import type { NodeHubClient } from './client.ts'
import { type NodeClock, systemClock } from './clock.ts'

/**
 * 节点侧的策略预检（add-m1-inbox 2.3；design D2、D3；policy-engine spec）。
 *
 * 执行器在把审批请求交给用户之前，先经节点调用中枢的 `POST /v1/policy/check`：
 * - 结果为 `auto` / `auto-report`：执行器在本地直接放行，任务不进入 blocked；
 *   审计以中枢写入的 `policy.decided`（操作者 `policy`）为准，执行器的活动只是补充；
 * - 其余结果（`draft-approve` / `notify` / `user`）：照常上报 `blocked(awaiting_approval)`；
 * - **调用失败一律按需要用户处理**：网络错误、5xx、超时、401/403、响应不符合 schema、
 *   结果与逐动作明细不一致，都不会被当作放行。
 *
 * 安全底线：只有一个明确、合法的 `auto` / `auto-report` 响应才返回 allow；任何不确定都返回 user。
 */

/** 交给中枢判定的请求：工具名，以及可选的命令文本与路径。 */
export interface PrecheckRequest {
  tool: string
  command?: string
  paths?: string[]
}

/** 预检结论：allow 表示可在本地放行；否则交给用户。 */
export type PrecheckVerdict =
  | { allow: true; level: 'auto' | 'auto-report'; actions: string[] }
  | {
      allow: false
      /** 中枢给出的档位；调用失败时没有。 */
      level?: PolicyDecisionLevel
      /** 调用失败的原因（错误码与说明），用于活动与日志。 */
      error?: string
    }

/** 绑定了任务 id 的预检函数，经执行器上下文交给执行器。 */
export type Precheck = (req: PrecheckRequest) => Promise<PrecheckVerdict>

/** 预检的默认超时：5 秒。超时按需要用户处理。 */
export const PRECHECK_TIMEOUT_MS = 5_000

const AUTO_LEVELS: ReadonlySet<string> = new Set(['auto', 'auto-report'])

/**
 * 判定结果是否可以放行：汇总档位为自动档位，且每个参与判定的动作明细也都是自动档位
 * （`skipped` 的工具兜底动作除外），并且至少有一个参与判定的动作。
 * 中枢的 decide 本身就取最保守档位，这里再核对一次，防止响应自相矛盾时被误放行。
 */
export function isAutoDecision(d: PolicyCheckData): d is PolicyCheckData & {
  level: 'auto' | 'auto-report'
} {
  if (!AUTO_LEVELS.has(d.level)) return false
  const decided = d.actions.filter((a) => a.level !== 'skipped')
  if (decided.length === 0) return false
  return decided.every((a) => AUTO_LEVELS.has(a.level))
}

/**
 * 解析路径的真实位置（符号链接、`..`、`~`）：相对路径按 cwd 解析；文件不存在时对最近的已存在
 * 祖先目录做 realpath 再拼回其余部分。解析失败时只保留原路径。
 */
export async function realPolicyPath(path: string, cwd: string): Promise<string | undefined> {
  const expanded = path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path
  let current = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded)
  const rest: string[] = []
  for (;;) {
    try {
      const real = await realpath(current)
      return rest.length ? join(real, ...rest.reverse()) : real
    } catch {
      const parent = dirname(current)
      if (parent === current) return undefined
      rest.push(basename(current))
      current = parent
    }
  }
}

/** 原路径与解析后的路径都送去判定（去重、保持顺序）。 */
export async function expandPolicyPaths(paths: readonly string[], cwd: string): Promise<string[]> {
  const out = new Set<string>()
  for (const p of paths) {
    out.add(p)
    const real = await realPolicyPath(p, cwd)
    if (real) out.add(real)
  }
  return [...out]
}

export interface PolicyPrecheckOptions {
  client: Pick<NodeHubClient, 'policyCheck'>
  taskId: string
  /** 超时毫秒，默认 5 秒。 */
  timeoutMs?: number
  /** 计时用的时钟（测试注入虚拟时钟）。 */
  clock?: NodeClock
  /** 任务被取消时中止预检（结果按需要用户处理）。 */
  signal?: AbortSignal
  /** 解析相对路径的目录（任务的工作目录），缺省为进程 cwd。 */
  cwd?: string
}

/** 构造绑定到一个任务的预检函数。永不抛出：异常同样按需要用户处理。 */
export function createPolicyPrecheck(o: PolicyPrecheckOptions): Precheck {
  const clock = o.clock ?? systemClock
  const timeoutMs = o.timeoutMs ?? PRECHECK_TIMEOUT_MS
  return async (req) => {
    if (o.signal?.aborted) return { allow: false, error: 'aborted：任务已取消' }
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    o.signal?.addEventListener('abort', onAbort, { once: true })
    let cancelTimer = () => {}
    // 自己再计一次时：即使底层 fetch 不响应中止信号，也不会无限等待。
    const timedOut = new Promise<PrecheckVerdict>((resolve) => {
      cancelTimer = clock.setTimeout(() => {
        controller.abort()
        resolve({ allow: false, error: `timeout：策略预检超过 ${timeoutMs} 毫秒未返回` })
      }, timeoutMs)
    })
    const checked = (async (): Promise<PrecheckVerdict> => {
      try {
        // 符号链接与大小写变体由中枢的识别处理，节点负责把真实路径一并送去（不信任原路径的字面）。
        const paths =
          req.paths === undefined
            ? undefined
            : await expandPolicyPaths(req.paths, o.cwd ?? process.cwd())
        const r = await o.client.policyCheck(
          {
            task_id: o.taskId,
            tool: req.tool,
            ...(req.command === undefined ? {} : { command: req.command }),
            ...(paths === undefined ? {} : { paths }),
          },
          { signal: controller.signal, timeoutMs },
        )
        if (!r.ok) return { allow: false, error: `${r.error.code}：${r.error.message}` }
        if (!isAutoDecision(r.data)) return { allow: false, level: r.data.level }
        return {
          allow: true,
          level: r.data.level,
          actions: r.data.actions.filter((a) => a.level !== 'skipped').map((a) => a.action),
        }
      } catch (err) {
        return { allow: false, error: `precheck_error：${(err as Error).message}` }
      }
    })()
    try {
      return await Promise.race([checked, timedOut])
    } finally {
      cancelTimer()
      o.signal?.removeEventListener('abort', onAbort)
    }
  }
}

/** 预检放行时写进活动的一句话。 */
export function autoApprovedText(what: string, v: { level: string; actions: string[] }): string {
  return redactSecrets(`策略自动放行：${what}（档位 ${v.level}，动作 ${v.actions.join(', ')}）`)
}

/** 预检未放行时写进活动的一句话。 */
export function needsUserText(v: { level?: string; error?: string }): string {
  if (v.error) return redactSecrets(`策略预检失败，按需要用户处理：${v.error}`)
  return `策略判定为 ${v.level ?? 'user'}，交给用户审批`
}
