import {
  type DoctorOptions,
  formatDoctorReport,
  raindownHomeSource,
  resolveRaindownHome,
  runDoctor,
} from '@raindown/core'
import { defineCommand } from '../command.ts'

export const createDoctorCommand = (options: DoctorOptions = {}) =>
  defineCommand({
    name: 'doctor',
    summary: '检查 raindown-home、git 仓库、密钥扫描钩子与外部工具',
    run: () =>
      runDoctor(resolveRaindownHome(process.env), raindownHomeSource(process.env), options),
    human: formatDoctorReport,
  })

export const doctorCommand = createDoctorCommand()
