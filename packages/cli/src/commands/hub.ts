import { HubClient, ok, renderTable, resolveFlowHome } from '@flow/core'
import { runHub } from '@flow/hub'
import { defineCommand } from '../command.ts'

export const hubStartCommand = defineCommand({
  name: 'hub start',
  summary: '在前台运行中枢，收到 SIGINT 或 SIGTERM 后退出',
  run: async () => {
    const started = await runHub({
      home: resolveFlowHome(process.env),
      logger: { info: console.error, warn: console.error },
    })
    if (!started.ok) return started
    const hub = started.data
    // main.ts 会在命令返回后退出，因此必须等待信号及完整的优雅关闭。
    await new Promise<void>((resolve, reject) => {
      const stop = () => {
        process.off('SIGINT', stop)
        process.off('SIGTERM', stop)
        void hub.stop().then(resolve, reject)
      }
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
      process.stderr.write(`中枢监听于 ${hub.url}\n`)
    })
    return ok({ url: hub.url })
  },
  human: () => '中枢已停止',
})

export const hubStatusCommand = defineCommand({
  name: 'hub status',
  summary: '查看中枢版本、运行时长、账本与备份状态',
  run: ({ actor }) => new HubClient({ home: resolveFlowHome(process.env), actor }).status(),
  human: (status) =>
    renderTable(
      [
        ['版本', status.version],
        ['PID', String(status.pid ?? '未知')],
        ['运行时长', `${status.uptime.toFixed(1)} 秒`],
        ['账本序号', String(status.ledger_seq)],
        [
          '定时规则错误',
          status.schedules.errors.map((e) => `${e.rule_id ?? ''} ${e.message}`.trim()).join('；') ||
            '（无）',
        ],
        [
          '最近一次备份',
          status.last_backup ? `${status.last_backup.at} ${status.last_backup.path}` : '（无）',
        ],
      ],
      [
        { header: '项目', value: (row) => row[0] ?? '' },
        { header: '值', value: (row) => row[1] ?? '' },
      ],
    ),
})

export const hubRebuildCommand = defineCommand({
  name: 'hub rebuild',
  summary: '请求中枢重放事件并重建投影',
  run: ({ actor }) => new HubClient({ home: resolveFlowHome(process.env), actor }).rebuild(),
  human: (data) =>
    `已重放 ${data.events_replayed} 条事件，耗时 ${data.duration_ms} 毫秒（账本序号 ${data.ledger_seq}）`,
})
