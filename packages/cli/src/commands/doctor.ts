import { flowHomeSource, formatDoctorReport, resolveFlowHome, runDoctor } from '@flow/core'
import { defineCommand } from '../command.ts'

export const doctorCommand = defineCommand({
  name: 'doctor',
  summary: '检查 flow-home、git 仓库、密钥扫描钩子与外部工具',
  run: () => runDoctor(resolveFlowHome(process.env), flowHomeSource(process.env)),
  human: formatDoctorReport,
})
