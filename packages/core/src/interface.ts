import type { OpContext, Operation } from './ops/operation.ts'
import { fail, type Result } from './result.ts'

/**
 * CLI 与 MCP 两个适配层共用的"操作调用"与"结果渲染"（knowledge-access "两种接口等价"、
 * "机器可读输出"）。两边都只调用这里的函数，输入校验、错误码与 JSON 形态因此不会漂移。
 */

/** `--json` 输出与 MCP 工具返回内容的统一 JSON 文档形态。 */
export type JsonDocument =
  | { ok: true; data: unknown }
  | {
      ok: false
      error: { kind: string; code: string; message: string; details?: unknown; retryable: boolean }
    }

/** 把 core 的结果转为 JSON 文档；失败时附 `retryable`（对应退出码 3）。 */
export function toJsonDocument(result: Result<unknown>): JsonDocument {
  return result.ok
    ? { ok: true, data: result.data }
    : { ok: false, error: { ...result.error, retryable: result.error.kind === 'retryable' } }
}

/** 用操作的 zod schema 校验原始输入；不通过时返回用法错误 `invalid_arguments`。 */
export function parseOperationInput<I>(
  op: Pick<Operation<I, unknown>, 'input'>,
  raw: unknown,
): Result<I> {
  const parsed = op.input.safeParse(raw)
  if (parsed.success) return { ok: true, data: parsed.data as I }
  const detail = parsed.error.issues
    .map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`)
    .join('；')
  return fail('usage', 'invalid_arguments', `参数不合法：${detail}`, parsed.error.issues)
}

/** 校验输入并执行操作；操作抛出的异常转为 `internal_error`，与 CLI 的处理一致。 */
export async function invokeOperation<I, O>(
  op: Operation<I, O>,
  raw: unknown,
  ctx: OpContext,
): Promise<Result<O>> {
  const input = parseOperationInput<I>(op, raw)
  if (!input.ok) return input
  try {
    return await op.run(input.data, ctx)
  } catch (err) {
    return fail('failure', 'internal_error', (err as Error).message)
  }
}
