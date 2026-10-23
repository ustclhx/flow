import { exitCodeOf, type FlowError, type Result, toJsonDocument } from '@flow/core'

export interface Rendered {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * 把 core 的结果渲染为 CLI 输出。`--json` 模式下 stdout 只有一个 JSON 文档，
 * 成功与失败共用 `{ ok, data | error }` 形态，与 MCP 工具返回值一致（spec: 机器可读输出）；
 * JSON 形态由 core 的 `toJsonDocument` 统一生成，MCP 适配层共用同一个函数。
 */
export function render<T>(
  result: Result<T>,
  opts: { json: boolean; human?: (data: T) => string; humanError?: (error: FlowError) => string },
): Rendered {
  const exitCode = exitCodeOf(result)
  if (opts.json) {
    return { stdout: `${JSON.stringify(toJsonDocument(result))}\n`, stderr: '', exitCode }
  }
  if (result.ok) {
    const text = opts.human ? opts.human(result.data) : JSON.stringify(result.data, null, 2)
    return { stdout: text.endsWith('\n') || text === '' ? text : `${text}\n`, stderr: '', exitCode }
  }
  const hint = result.error.kind === 'retryable' ? '（可重试）' : ''
  const text = opts.humanError?.(result.error) ?? ''
  return {
    stdout: text.endsWith('\n') || text === '' ? text : `${text}\n`,
    stderr: `error[${result.error.code}]${hint}: ${result.error.message}\n`,
    exitCode,
  }
}
