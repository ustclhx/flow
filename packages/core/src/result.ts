/**
 * 所有 core 操作的统一返回形态。CLI 与 MCP 都只做这层结果的适配，
 * 保证两种接口的输出与错误语义一致（design D1、D12）。
 */

/** 错误类别，决定 CLI 退出码：failure→1，usage→2，retryable→3。 */
export type ErrorKind = 'failure' | 'usage' | 'retryable'

export interface FlowError {
  kind: ErrorKind
  /** 稳定的机器可读错误码，例如 `lock_timeout`、`validation_failed`。 */
  code: string
  message: string
  details?: unknown
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: FlowError }

export const ok = <T>(data: T): Result<T> => ({ ok: true, data })

export const fail = (
  kind: ErrorKind,
  code: string,
  message: string,
  details?: unknown,
): Result<never> => ({
  ok: false,
  error: details === undefined ? { kind, code, message } : { kind, code, message, details },
})

/** CLI 退出码约定：0 成功，1 失败或校验未通过，2 用法错误，3 可重试。 */
export const EXIT_CODES = { ok: 0, failure: 1, usage: 2, retryable: 3 } as const

export const exitCodeOf = (result: Result<unknown>): number =>
  result.ok ? EXIT_CODES.ok : EXIT_CODES[result.error.kind]
