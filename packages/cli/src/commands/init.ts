import { formatInitReport, initRaindownHome, resolveRaindownHome } from '@raindown/core'
import { defineCommand } from '../command.ts'

export const initCommand = defineCommand({
  name: 'init',
  summary: '初始化 raindown-home（幂等：只补齐缺失项，不覆盖已有文件）',
  run: () => initRaindownHome(resolveRaindownHome(process.env)),
  human: formatInitReport,
})
