import {
  HubClient,
  resolveFlowHome,
  type TelegramLinkCodeData,
  type TelegramUnlinkData,
} from '@flow/core'
import { defineCommand } from '../command.ts'

/**
 * `flow telegram link`（add-m1-inbox 5.1；telegram-channel "绑定用户本人"）：向中枢申请一次性绑定码
 * （仅 user），提示用户在 Telegram 中给 bot 发送 `/link <绑定码>`。绑定码 10 分钟内有效，只能使用一次；
 * 中枢收到后把该私聊的 chat id 与用户 id 写入 `config/channels.yaml` 并提交。
 * 已绑定时必须加 `--rebind`；改绑成功前，原 chat 会收到通知。
 */
export const telegramLinkCommand = defineCommand<TelegramLinkCodeData>({
  name: 'telegram link',
  usage: 'telegram link [--rebind]',
  summary: '绑定 Telegram：生成一次性绑定码（10 分钟内有效，仅 user）',
  options: {
    rebind: {
      type: 'boolean',
      description: '已绑定时改绑到另一个 Telegram 账号（原账号会收到通知）',
    },
  },
  run: async ({ actor, options }) => {
    const home = resolveFlowHome(process.env)
    return new HubClient({ home, actor }).telegramLinkCode({ rebind: options.rebind === true })
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

/** `flow telegram unlink`：解除 Telegram 绑定（仅 user），之后 bot 不再推送、不再接受任何 chat 的操作。 */
export const telegramUnlinkCommand = defineCommand<TelegramUnlinkData>({
  name: 'telegram unlink',
  usage: 'telegram unlink',
  summary: '解除 Telegram 绑定（仅 user）',
  run: async ({ actor }) => {
    const home = resolveFlowHome(process.env)
    return new HubClient({ home, actor }).telegramUnlink()
  },
  human: ({ unlinked }) =>
    unlinked
      ? '已解除 Telegram 绑定。如果怀疑 bot token 泄露，请同时在 @BotFather 吊销 token。'
      : 'Telegram 原本就没有绑定。',
})
