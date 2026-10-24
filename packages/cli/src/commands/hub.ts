import { join } from 'node:path'
import {
  fail,
  flowPaths,
  HubClient,
  type HubStatus,
  type HubTokenView,
  ok,
  renderTable,
  resolveFlowHome,
  rotateLog,
} from '@flow/core'
import { runHub } from '@flow/hub'
import { defineCommand } from '../command.ts'

export const hubStartCommand = defineCommand({
  name: 'hub start',
  summary: '在前台运行中枢，收到 SIGINT 或 SIGTERM 后退出',
  run: async () => {
    const home = resolveFlowHome(process.env)
    const rotated = await rotateLog(join(flowPaths(home).logs, 'hub.log'))
    if (!rotated.ok) return rotated
    // launchd 已在启动前打开标准流；轮转后退出一次，让 KeepAlive 重新打开新的日志。
    if (rotated.data && process.env.XPC_SERVICE_NAME === 'dev.flow.hub') {
      return fail('retryable', 'log_rotated', '日志已轮转，等待 launchd 重新启动中枢')
    }
    const started = await runHub({
      home,
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

const CHANNEL_STATE: Record<string, string> = {
  running: '正常',
  backoff: '重试中',
  disabled: '未启动',
  stopped: '已停止',
}

/** 渠道状态一行：缺少密钥的渠道列出缺少的路径（secret-provider "token 未配置"）。 */
function channelSummary(channels: NonNullable<HubStatus['channels']>): string {
  if (channels.length === 0) return '（未配置）'
  return channels
    .map((c) => {
      const extra =
        c.missing_secrets.length > 0
          ? `，缺少 ${c.missing_secrets.map((p) => `secret://${p}`).join('、')}`
          : c.state === 'backoff'
            ? `，已连续失败 ${c.failures} 次，${c.next_retry_at ?? ''} 重试`
            : c.state === 'disabled' && c.last_error
              ? `，${c.last_error}`
              : ''
      const failed = c.failed_items > 0 ? `，推送失败 ${c.failed_items} 条` : ''
      const ignored = c.ignored_inbound > 0 ? `，已忽略 ${c.ignored_inbound} 次陌生访问` : ''
      return `${c.id}：${CHANNEL_STATE[c.state] ?? c.state}${extra}${failed}${ignored}`
    })
    .join('；')
}

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
        ['策略规则错误', status.policies?.errors.map((e) => e.message).join('；') || '（无）'],
        [
          '最近一次备份',
          status.last_backup ? `${status.last_backup.at} ${status.last_backup.path}` : '（无）',
        ],
        ['已解析的密钥', String(status.secrets?.loaded ?? 0)],
        [
          '缺少的密钥',
          status.secrets?.missing.map((m) => `secret://${m.path}（${m.file}）`).join('；') ||
            '（无）',
        ],
        ...(status.secrets?.error ? [['密钥解析错误', status.secrets.error]] : []),
        ['推送渠道', channelSummary(status.channels ?? [])],
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

// FLOW_ACTOR 的降级规则已在 runCli 中统一处理（resolveActor）。
const hubClient = (actor: string) => new HubClient({ home: resolveFlowHome(process.env), actor })

const tokenRows = (tokens: HubTokenView[]) =>
  renderTable(tokens, [
    { header: 'ID', value: (t) => t.id },
    { header: '身份', value: (t) => t.actor },
    { header: '状态', value: (t) => (t.revoked_at ? `已撤销 ${t.revoked_at}` : '有效') },
    { header: '签发时间', value: (t) => t.issued_at },
    { header: '最近使用', value: (t) => t.last_used_at ?? '（从未）' },
    { header: '备注', value: (t) => `${t.note ?? ''}${t.remote ? '（远程）' : ''}`, max: 40 },
  ])

export const hubTokenIssueCommand = defineCommand({
  name: 'hub token issue',
  usage: 'hub token issue <actor> [--note <备注>] [--remote]',
  summary: '签发绑定身份的中枢 token（仅 user；token 只输出这一次）',
  options: {
    note: { type: 'string', description: '备注，例如用途' },
    remote: { type: 'boolean', description: '标注为远程调用方使用（远程入口见变更 ⑤）' },
  },
  run: ({ args, options, actor }) => {
    if (args.length !== 1)
      return Promise.resolve(
        fail('usage', 'invalid_arguments', '用法：flow hub token issue <actor> [--note <备注>]'),
      )
    return hubClient(actor).issueToken({
      actor: args[0] as string,
      ...(typeof options.note === 'string' ? { note: options.note } : {}),
      ...(options.remote === true ? { remote: true } : {}),
    })
  },
  human: ({ token, secret }) =>
    [
      `已签发 ${token.id}（身份 ${token.actor}）。token 只显示这一次，请立即妥善保存：`,
      secret,
      '使用方式：设置环境变量 FLOW_HUB_TOKEN，或作为 Authorization: Bearer 头。',
    ].join('\n'),
})

export const hubTokenListCommand = defineCommand({
  name: 'hub token list',
  summary: '列出绑定 token（不显示 token 本身；仅 user）',
  run: ({ args, actor }) =>
    args.length
      ? Promise.resolve(fail('usage', 'invalid_arguments', 'hub token list 不接受位置参数'))
      : hubClient(actor).listTokens(),
  human: ({ tokens }) => tokenRows(tokens),
})

export const hubTokenRevokeCommand = defineCommand({
  name: 'hub token revoke',
  usage: 'hub token revoke <id>',
  summary: '撤销一个绑定 token，立即生效（仅 user）',
  run: ({ args, actor }) =>
    args.length !== 1
      ? Promise.resolve(fail('usage', 'invalid_arguments', '用法：flow hub token revoke <id>'))
      : hubClient(actor).revokeToken(args[0] as string),
  human: ({ token }) => `已撤销 ${token.id}（身份 ${token.actor}）`,
})
