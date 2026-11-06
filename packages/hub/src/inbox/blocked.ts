import type { EventOf } from '@raindown/core'

/** 各展示渠道共用上报字段，避免再从终端片段提取问题或选项。 */
export function blockedText(payload: EventOf<'task.blocked'>['payload']): string {
  const basis = payload.basis === 'reported' ? 'worker 上报' : '从终端推断'
  const question = payload.reason === 'question' ? payload.question : undefined
  if (!question) return `来源：${basis}\n${payload.message}`
  return [
    `来源：${basis}`,
    question.text,
    ...question.options.map(
      (option) =>
        `${option.label}${option.label === question.recommended ? '（推荐）' : ''}：${option.description}`,
    ),
  ].join('\n')
}
