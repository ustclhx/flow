import type { Command } from '../command.ts'
import { doctorCommand } from './doctor.ts'
import { initCommand } from './init.ts'
import { kbValidateCommand } from './kb-validate.ts'

/**
 * 所有 CLI 命令的注册表。新增命令时在 `commands/` 下新建文件并在此追加一行，
 * 每组任务各自追加，合并冲突只会发生在这个列表里。
 */
export const commands: Command<never>[] = [
  initCommand,
  kbValidateCommand,
  doctorCommand,
] as Command<never>[]
