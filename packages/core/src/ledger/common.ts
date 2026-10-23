import { z } from 'zod'

/**
 * 任务账本、事件与节点协议共用的基础类型（add-m1-ledger-daemon 1.1）。
 * 这些定义导出为 `schemas/{tasks,events,protocol}/` 下的 JSON Schema，
 * 供其他语言（例如用 Rust 重写的节点）直接复用，因此命名与格式要保持稳定。
 */

/** 账本内对象标识（任务、节点、租约）的通用格式：字母数字开头，最长 128 个字符。 */
export const LEDGER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/

export const taskId = z
  .string()
  .regex(LEDGER_ID_RE, '任务 id 只能包含字母、数字、`_`、`.`、`-`')
  .meta({ description: '任务 id，由中枢在创建时分配' })

export const nodeId = z
  .string()
  .regex(LEDGER_ID_RE, '节点 id 只能包含字母、数字、`_`、`.`、`-`')
  .meta({ description: '节点 id，节点首次启动时生成并保存在 state/node-id' })

export const leaseId = z
  .string()
  .regex(LEDGER_ID_RE, '租约 id 只能包含字母、数字、`_`、`.`、`-`')
  .meta({ description: '租约 id，由中枢在分配任务时生成' })

/** 与提案的 actor 格式一致：`user`、`agent:claude`、`node:<id>`、`hub`、`scheduler` 等。 */
export const ACTOR_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/

export const actor = z
  .string()
  .regex(ACTOR_RE, '操作者标识格式不合法')
  .meta({ description: '操作者标识，例如 user、agent:claude、node:<id>、hub、scheduler' })

/** ISO 8601 时间（带时区偏移，账本内统一写 UTC 的 `Z`）。 */
export const timestamp = z.iso
  .datetime({ offset: true })
  .meta({ description: 'ISO 8601 时间，例如 2026-10-24T08:00:00.000Z' })

/** 执行器类型，例如 `fake`、`codex-orca`、`claude-sdk`、`codex-exec`。 */
export const EXECUTOR_TYPE_RE = /^[a-z][a-z0-9-]{0,63}$/

export const executorType = z
  .string()
  .regex(EXECUTOR_TYPE_RE, '执行器类型只能包含小写字母、数字和连字符')
  .meta({ description: '执行器类型，例如 fake、codex-orca、claude-sdk、codex-exec' })

/**
 * 节点能力：`<名称>` 或 `<名称>:<值>`，例如 `browser`、`executor:codex-orca`、
 * `repo:/Users/hxlee/workspace/product-res`。匹配时按整串精确比较。
 */
export const CAPABILITY_RE = /^[a-z][a-z0-9_-]*(:.+)?$/

export const capability = z
  .string()
  .max(512)
  .regex(CAPABILITY_RE, '能力应形如 <名称> 或 <名称>:<值>，名称为小写字母开头')
  .meta({ description: '节点能力，例如 browser、executor:fake、repo:/path/to/repo' })

/** 执行器自动贡献、任务按执行器隐含要求的能力。 */
export const executorCapability = (executor: string): string => `executor:${executor}`
