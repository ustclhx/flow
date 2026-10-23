import { exitCodeOf, type Result } from '@flow/core'

export interface Rendered {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * 把 core 的结果渲染为 CLI 输出。`--json` 模式下 stdout 只有一个 JSON 文档，
 * 成功与失败共用 `{ ok, data | error }` 形态，与 MCP 工具返回值一致（spec: 机器可读输出）。
 */
export function render<T>(
  result: Result<T>,
  opts: { json: boolean; human?: (data: T) => string },
): Rendered {
  const exitCode = exitCodeOf(result)
  if (opts.json) {
    const body = result.ok
      ? { ok: true, data: result.data }
      : { ok: false, error: { ...result.error, retryable: result.error.kind === 'retryable' } }
    return { stdout: `${JSON.stringify(body)}\n`, stderr: '', exitCode }
  }
  if (result.ok) {
    const text = opts.human ? opts.human(result.data) : JSON.stringify(result.data, null, 2)
    return { stdout: text.endsWith('\n') || text === '' ? text : `${text}\n`, stderr: '', exitCode }
  }
  const hint = result.error.kind === 'retryable' ? '（可重试）' : ''
  return {
    stdout: '',
    stderr: `error[${result.error.code}]${hint}: ${result.error.message}\n`,
    exitCode,
  }
}
