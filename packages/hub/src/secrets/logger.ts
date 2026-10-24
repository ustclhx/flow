import type { HubLogger } from '../server/maintenance.ts'
import { redactDeep } from './redactor.ts'

/**
 * 日志输出前的脱敏（design D7）：消息与 details 中的字符串都经过 redact。
 * Error 先转成字符串再替换（它的 message / stack 可能带着密钥值）。
 */
export function redactingLogger(logger: HubLogger, redact: (text: string) => string): HubLogger {
  const clean = (details: unknown): unknown => {
    if (details instanceof Error) return redact(String(details))
    return redactDeep(details, redact)
  }
  const wrap =
    (fn: HubLogger['info']) =>
    (message: string, details?: unknown): void => {
      if (details === undefined) fn(redact(message))
      else fn(redact(message), clean(details))
    }
  return { info: wrap(logger.info.bind(logger)), warn: wrap(logger.warn.bind(logger)) }
}
