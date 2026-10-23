import { operations } from '@flow/core'
import type { Command } from '../command.ts'
import { commandFromOperation } from '../from-operation.ts'
import agentsSync from './agents-sync.ts'
import { doctorCommand } from './doctor.ts'
import { initCommand } from './init.ts'
import { kbValidateCommand } from './kb-validate.ts'

/**
 * 所有 CLI 命令的注册表。知识访问操作定义在 `@flow/core` 的 `ops/` 中并自动生成命令；
 * 只有不属于知识访问的命令（init、doctor 等）才在 `commands/` 下单独写。
 */
export const commands = [
  initCommand,
  kbValidateCommand,
  doctorCommand,
  agentsSync,
  ...operations.map(commandFromOperation),
] as Command<unknown>[]
