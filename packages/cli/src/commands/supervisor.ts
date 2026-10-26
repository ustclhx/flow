import {
  fail,
  HubClient,
  resolveFlowHome,
  SUPERVISOR_QUEUES,
  type SupervisorStatusData,
  type SupervisorWakeData,
  type WakeSummary,
} from '@flow/core'
import { defineCommand } from '../command.ts'

/**
 * supervisor 唤醒的用户命令（add-m1-supervisor D3；tasks 3.4）。不属于知识访问，所以在这里单独定义；
 * 全部经中枢的 user-only 路由，AI 身份调用返回 `user_only`。
 */

/** `product-res` 与 `ws/product-res` 都接受。 */
const wsRef = (s: string) => (s.startsWith('ws/') ? s : `ws/${s}`)

const usage = (message: string) => fail('usage', 'invalid_arguments', message)

const wakeLine = (w: WakeSummary) =>
  `${w.task_id}（${w.origin}，第 ${w.generation} 代，${w.events} 个事件，${w.status}）`

const humanWake = (d: SupervisorWakeData) =>
  d.state === 'started' && d.wake ? `已唤醒 supervisor：${wakeLine(d.wake)}` : d.message

/** `flow ask <ws> <说明>`：下达指令（写 `user.instruction`，via cli），输出唤醒任务 id 或排队说明。 */
export const askCommand = defineCommand<SupervisorWakeData>({
  name: 'ask',
  usage: 'ask <workspace> <说明>',
  summary: '给 supervisor 下指令：输出唤醒任务 id 或"已排队"（仅 user）',
  run: async ({ args, actor }) => {
    const [ws, ...rest] = args
    const text = rest.join(' ').trim()
    if (!ws || !text) return usage('用法：flow ask <workspace> <说明>')
    const home = resolveFlowHome(process.env)
    return new HubClient({ home, actor }).supervisorWake({ workspace: wsRef(ws), text, via: 'cli' })
  },
  human: humanWake,
})

/** `flow supervisor wake <ws> [<说明>] [--release <instruction|autonomous>]`。 */
export const supervisorWakeCommand = defineCommand<SupervisorWakeData>({
  name: 'supervisor wake',
  usage: 'supervisor wake <workspace> [<说明>] [--release <instruction|autonomous>]',
  summary: '手动唤醒 supervisor，或放行一条暂停 / 达到上限的队列（仅 user）',
  options: {
    release: {
      type: 'string',
      description:
        '放行队列 instruction 或 autonomous：立刻用该队列现有事件唤醒一次，不计入每日上限',
    },
  },
  run: async ({ args, options, actor }) => {
    const [ws, ...rest] = args
    if (!ws) return usage('用法：flow supervisor wake <workspace> [<说明>] [--release <queue>]')
    const text = rest.join(' ').trim()
    const release = options.release
    if (release !== undefined) {
      if (
        typeof release !== 'string' ||
        !(SUPERVISOR_QUEUES as readonly string[]).includes(release)
      ) {
        return usage(`--release 只能是 ${SUPERVISOR_QUEUES.join(' 或 ')}`)
      }
      if (text) return usage('--release 不能与说明同时给出')
    }
    const home = resolveFlowHome(process.env)
    return new HubClient({ home, actor }).supervisorWake({
      workspace: wsRef(ws),
      ...(text ? { text } : {}),
      ...(release === undefined ? {} : { release: release as (typeof SUPERVISOR_QUEUES)[number] }),
      via: 'cli',
    })
  },
  human: humanWake,
})

/** `flow supervisor status [<ws>]`：当前唤醒、各队列长度、今日唤醒次数与最近一次结果。 */
export const supervisorStatusCommand = defineCommand<SupervisorStatusData>({
  name: 'supervisor status',
  usage: 'supervisor status [<workspace>]',
  summary: '查看 supervisor 的当前唤醒、队列、今日次数与最近一次结果（仅 user）',
  run: async ({ args, actor }) => {
    const home = resolveFlowHome(process.env)
    const ws = args[0]
    return new HubClient({ home, actor }).supervisorStatus(ws ? { workspace: wsRef(ws) } : {})
  },
  human: ({ workspaces }) => {
    if (workspaces.length === 0) return '没有 workspace'
    return workspaces
      .map((w) => {
        const lines = [`${w.workspace}：${w.enabled ? '已启用' : `未启用（${w.reason ?? ''}）`}`]
        lines.push(`  当前唤醒：${w.current ? wakeLine(w.current) : '无'}`)
        if (w.reply) lines.push(`  代回复唤醒：${wakeLine(w.reply)}`)
        lines.push(
          `  队列：instruction ${w.queues.instruction}，autonomous ${w.queues.autonomous}，reply ${w.queues.reply}`,
        )
        for (const q of SUPERVISOR_QUEUES) {
          const p = w.paused[q]
          if (p) {
            lines.push(
              `  ${q} 队列暂停（连续失败 ${p.failures} 次），${new Date(p.until).toLocaleString()} 自动恢复`,
            )
          }
        }
        if (w.release_pending.length)
          lines.push(`  已放行、等待处理：${w.release_pending.join('、')}`)
        const t = w.today
        lines.push(
          `  今日（${t.date}）：普通唤醒 ${t.wakes}/${t.wakes_per_day}，其中 autonomous ${t.autonomous}/${t.autonomous_wakes_per_day}，代回复 ${t.reply}/${t.reply_wakes_per_day}`,
        )
        lines.push(`  最近一次：${w.last ? wakeLine(w.last) : '无'}`)
        return lines.join('\n')
      })
      .join('\n\n')
  },
})

export const supervisorCommands = [askCommand, supervisorWakeCommand, supervisorStatusCommand]
