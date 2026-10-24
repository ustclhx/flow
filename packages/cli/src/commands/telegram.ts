import { HubClient, resolveFlowHome, type TelegramLinkCodeData } from '@flow/core'
import { defineCommand } from '../command.ts'

/**
 * `flow telegram link`（add-m1-inbox 5.1；telegram-channel "绑定用户本人"）：向中枢申请一次性绑定码
 * （仅 user），提示用户在 Telegram 中给 bot 发送 `/link <绑定码>`。绑定码 10 分钟内有效，只能使用一次；
 * 中枢收到后把该私聊的 chat id 与用户 id 写入 `config/channels.yaml` 并提交。
 */
export const telegramLinkCommand = defineCommand<TelegramLinkCodeData>({
  name: 'telegram link',
  usage: 'telegram link',
  summary: '绑定 Telegram：生成一次性绑定码（10 分钟内有效，仅 user）',
  run: async ({ actor }) => {
    const home = resolveFlowHome(process.env)
    return new HubClient({ home, actor }).telegramLinkCode()
  },
  human: ({ command, link_url, expires_at }) =>
    [
      '在 Telegram 中给你的 bot 发送下面这条消息完成绑定：',
      '',
      `    ${command}`,
      '',
      ...(link_url ? ['或在手机上打开这个链接，然后点"开始"：', `    ${link_url}`, ''] : []),
      `绑定码在 ${new Date(expires_at).toLocaleString()} 之前有效，只能使用一次。`,
      '绑定后只有这个私聊里的你本人能操作 Flow；其他 chat 的消息一律忽略。',
    ].join('\n'),
})
