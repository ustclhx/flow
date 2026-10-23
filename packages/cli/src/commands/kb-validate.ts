import {
  DEFAULT_STALE_DAYS,
  fail,
  formatValidationReport,
  ok,
  resolveFlowHome,
  validateBrain,
} from '@flow/core'
import { defineCommand } from '../command.ts'

export const kbValidateCommand = defineCommand({
  name: 'kb validate',
  summary: '校验 brain 中的条目与 workspace 定义',
  usage: 'kb validate [--stale-days <n>] [--json]',
  options: {
    'stale-days': {
      type: 'string',
      description: `超过多少天未核实视为可能过时，默认 ${DEFAULT_STALE_DAYS}`,
    },
  },
  run: async ({ options }) => {
    const raw = options['stale-days']
    let staleDays = DEFAULT_STALE_DAYS
    if (raw !== undefined) {
      if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
        return fail('usage', 'invalid_stale_days', '--stale-days 必须是非负整数')
      }
      staleDays = Number.parseInt(raw, 10)
    }
    const result = await validateBrain(resolveFlowHome(process.env), { staleDays })
    if (!result.ok) return result
    const report = result.data
    // 有错误时以失败返回（退出码 1），完整报告放在 details 中。
    if (report.errors.length > 0) {
      return fail('failure', 'validation_failed', formatValidationReport(report), report)
    }
    return ok(report)
  },
  human: formatValidationReport,
})
