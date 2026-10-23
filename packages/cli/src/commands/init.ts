import { formatInitReport, initFlowHome, resolveFlowHome } from '@flow/core'
import { defineCommand } from '../command.ts'

export const initCommand = defineCommand({
  name: 'init',
  summary: '初始化 flow-home（幂等：只补齐缺失项，不覆盖已有文件）',
  run: () => initFlowHome(resolveFlowHome(process.env)),
  human: formatInitReport,
})
