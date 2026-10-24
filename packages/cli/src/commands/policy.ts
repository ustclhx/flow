import { fail, HubClient, policyCheckRequest, resolveFlowHome } from '@flow/core'
import { defineCommand } from '../command.ts'

/** 策略预检属于管理调试命令，不是知识访问操作。 */
export const policyCheckCommand = defineCommand({
  name: 'policy check',
  summary: '通过中枢调试请求策略，默认不入账；--record 写入审计事件',
  usage: 'policy check --task <id> --tool <工具名> [--command <命令>] [--path <路径>…] [--record]',
  options: {
    task: { type: 'string', description: '任务 id' },
    tool: { type: 'string', description: '工具名，例如 Bash' },
    command: { type: 'string', description: '完整命令' },
    path: { type: 'string', multiple: true, description: '请求涉及的路径，可重复' },
    record: { type: 'boolean', description: '记录 policy.decided 审计事件（默认只判定）' },
  },
  async run({ args, options, actor }) {
    const request = policyCheckRequest.safeParse({
      task_id: options.task,
      tool: options.tool,
      command: options.command,
      paths: options.path,
      dry_run: options.record !== true,
    })
    if (args.length || !request.success) {
      return fail(
        'usage',
        'invalid_arguments',
        '用法：flow policy check --task <id> --tool <工具名> [--command <命令>] [--path <路径>…] [--record]',
      )
    }
    return new HubClient({ home: resolveFlowHome(process.env), actor }).checkPolicy(request.data)
  },
})
