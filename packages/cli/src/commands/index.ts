import { operations } from '@flow/core'
import type { Command } from '../command.ts'
import { commandFromOperation } from '../from-operation.ts'
import agentsSync from './agents-sync.ts'
import { daemonCommands } from './daemon.ts'
import { doctorCommand } from './doctor.ts'
import {
  hubRebuildCommand,
  hubStartCommand,
  hubStatusCommand,
  hubTokenIssueCommand,
  hubTokenListCommand,
  hubTokenRevokeCommand,
} from './hub.ts'
import { initCommand } from './init.ts'
import { kbValidateCommand } from './kb-validate.ts'
import { mcpCommand } from './mcp.ts'
import { nodeListCommand, nodeStartCommand } from './node.ts'
import { policyCheckCommand } from './policy.ts'
import { secretsCommands } from './secrets.ts'
import { supervisorCommands } from './supervisor.ts'
import { telegramLinkCommand, telegramUnlinkCommand } from './telegram.ts'
import { uiCommand } from './ui.ts'

/**
 * 所有 CLI 命令的注册表。知识访问操作定义在 `@flow/core` 的 `ops/` 中并自动生成命令；
 * 只有不属于知识访问的命令（init、doctor 等）才在 `commands/` 下单独写。
 */
export const commands = [
  initCommand,
  ...secretsCommands,
  ...daemonCommands,
  hubStartCommand,
  hubStatusCommand,
  hubRebuildCommand,
  hubTokenIssueCommand,
  hubTokenListCommand,
  hubTokenRevokeCommand,
  kbValidateCommand,
  doctorCommand,
  agentsSync,
  mcpCommand,
  nodeStartCommand,
  nodeListCommand,
  policyCheckCommand,
  uiCommand,
  telegramLinkCommand,
  telegramUnlinkCommand,
  ...supervisorCommands,
  ...operations.flatMap((op) =>
    [op.cli, ...(op.cliAliases ?? [])].map((cli) => commandFromOperation({ ...op, cli })),
  ),
] as Command<unknown>[]
