import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isMap, parseDocument } from 'yaml'
import { z } from 'zod'
import { flowAuthor, git, gitCommit } from '../git.ts'
import { flowPaths } from '../home.ts'
import { fail, ok, type Result } from '../result.ts'
import { withWriteLock } from '../write/lock.ts'

/**
 * `config/channels.yaml`：推送渠道配置（add-m1-inbox 5.1，design D4）。
 *
 * ```yaml
 * telegram:
 *   bot_token: secret://telegram/bot-token   # 缺省即为这个引用；只接受 secret:// 引用
 *   proxy: http://127.0.0.1:7890             # 可选；缺省时取 HTTPS_PROXY 环境变量
 *   chat_id: 123456789                       # 由 `flow telegram link` 绑定时写入
 *   user_id: 123456789                       # 同上：绑定时记录的 Telegram 用户 id
 *   # enabled: false                         # 完全停用 Telegram 渠道（重启中枢后生效）
 * ```
 *
 * chat_id 与 user_id 不是密钥，但也不必公开；config 仓库本身是私有的（design D4）。
 * 删除 `chat_id`（或整个 telegram 段）后，bot 不再向任何 chat 推送，也不再接受任何 chat 的操作，
 * 只接受新的绑定码。
 */

export const DEFAULT_TELEGRAM_TOKEN_REF = 'secret://telegram/bot-token'

/** Telegram 的 chat id 与用户 id：私聊的 chat id 等于用户 id，都是正整数。 */
const telegramId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)

export const telegramChannelConfigSchema = z
  .strictObject({
    enabled: z
      .boolean()
      .default(true)
      .meta({ description: 'false 时不启动 Telegram 渠道（重启中枢后生效）' }),
    bot_token: z
      .string()
      .regex(/^secret:\/\/\S+$/, 'bot_token 只能写 secret:// 引用，不能写明文 token')
      .default(DEFAULT_TELEGRAM_TOKEN_REF)
      .meta({ description: 'bot token 的密钥引用，默认 secret://telegram/bot-token' }),
    proxy: z
      .url({ protocol: /^https?$/ })
      .optional()
      .meta({
        description: '访问 api.telegram.org 的 HTTP(S) 代理；缺省时使用 HTTPS_PROXY 环境变量',
      }),
    chat_id: telegramId.optional().meta({ description: '已绑定的私聊 chat id（绑定时写入）' }),
    user_id: telegramId
      .optional()
      .meta({ description: '绑定时记录的 Telegram 用户 id；只接受该用户的消息和按钮' }),
  })
  .meta({ title: 'Telegram channel', description: 'Telegram Bot 渠道' })
export type TelegramChannelConfig = z.infer<typeof telegramChannelConfigSchema>

export const channelsConfigSchema = z
  .strictObject({
    telegram: telegramChannelConfigSchema.optional(),
  })
  .meta({ title: 'Flow channels config', description: 'config/channels.yaml：推送渠道配置' })
export type ChannelsConfig = z.infer<typeof channelsConfigSchema>

const FILE = 'config/channels.yaml'

/** Telegram 渠道的默认配置（channels.yaml 不存在或没有 telegram 段时）。 */
export const defaultTelegramConfig = (): TelegramChannelConfig =>
  telegramChannelConfigSchema.parse({})

/** 解析已读出的配置对象；空文件等同空配置。 */
export function parseChannelsConfig(input: unknown): Result<ChannelsConfig> {
  if (input === null || input === undefined) return ok({})
  const parsed = channelsConfigSchema.safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue?.path.length ? `${issue.path.join('.')}：` : ''
    return fail('failure', 'invalid_config', `${FILE} 不合法：${where}${issue?.message ?? ''}`)
  }
  return ok(parsed.data)
}

/** 读取 `config/channels.yaml`；文件不存在等同空配置。 */
export async function loadChannelsConfig(home: string): Promise<Result<ChannelsConfig>> {
  let text: string
  try {
    text = await readFile(flowPaths(home).channelsConfig, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ok({})
    return fail('failure', 'read_failed', `无法读取 ${FILE}`)
  }
  let input: unknown
  try {
    input = parseDocument(text).toJS()
  } catch {
    return fail('failure', 'invalid_config', `${FILE} 不是合法的 YAML`)
  }
  return parseChannelsConfig(input)
}

/** Telegram 的绑定：只接受这个私聊、这个用户。 */
export interface TelegramBinding {
  chat_id: number
  user_id: number
}

/**
 * 把绑定写进 YAML 文本（纯函数）：保留文件中其他字段与注释，只改 `telegram.chat_id` 与
 * `telegram.user_id`。写入后的内容必须仍然通过 schema 校验。
 */
export function applyTelegramBinding(
  text: string | null,
  binding: TelegramBinding | null,
): Result<string> {
  const doc = parseDocument(text ?? '')
  if (doc.errors.length > 0) return fail('failure', 'invalid_config', `${FILE} 不是合法的 YAML`)
  if (doc.contents !== null && !isMap(doc.contents)) {
    return fail('failure', 'invalid_config', `${FILE} 顶层必须是对象`)
  }
  const telegram = doc.get('telegram')
  if (telegram !== undefined && telegram !== null && !isMap(telegram)) {
    return fail('failure', 'invalid_config', `${FILE} 的 telegram 必须是对象`)
  }
  if (binding) {
    doc.setIn(['telegram', 'chat_id'], binding.chat_id)
    doc.setIn(['telegram', 'user_id'], binding.user_id)
  } else if (isMap(telegram)) {
    // 解除绑定：只删这两个字段，保留代理等其他配置。
    telegram.delete('chat_id')
    telegram.delete('user_id')
  }
  const out = doc.toString()
  const check = parseChannelsConfig(parseDocument(out).toJS())
  if (!check.ok) return check
  return ok(out)
}

/**
 * 把 Telegram 绑定写入 `config/channels.yaml`（`null` 表示解除绑定）并在 config 仓库提交（作者 `Flow (user)`：
 * 绑定由用户本人用 `flow telegram link` 申请的一次性码完成）。持有写锁；提交失败时恢复原文件。
 */
export async function saveTelegramBinding(
  home: string,
  binding: TelegramBinding | null,
): Promise<Result<void>> {
  const dir = flowPaths(home).config
  const abs = flowPaths(home).channelsConfig
  return withWriteLock(home, async () => {
    let before: string | null
    try {
      before = await readFile(abs, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        return fail('failure', 'read_failed', `无法读取 ${FILE}`)
      }
      before = null
    }
    if (binding === null && before === null) return ok(undefined)
    const next = applyTelegramBinding(before, binding)
    if (!next.ok) return next
    if (next.data === before) return ok(undefined)
    const tmp = join(dir, `.channels.yaml.flow-${randomUUID()}.tmp`)
    try {
      await writeFile(tmp, next.data, { flag: 'wx' })
      await rename(tmp, abs)
      const committed = await gitCommit(dir, {
        paths: ['channels.yaml'],
        author: flowAuthor('user'),
        message: binding ? 'channels: 绑定 Telegram chat' : 'channels: 解除 Telegram 绑定',
      })
      if (committed.ok) return ok(undefined)
    } catch {
      /* 下面统一恢复 */
    } finally {
      await unlink(tmp).catch(() => {})
    }
    if (before === null) await rm(abs, { force: true })
    else await writeFile(abs, before)
    await git(dir, ['reset', '-q', '--', 'channels.yaml'])
    return fail('failure', 'config_commit_failed', `写入 ${FILE} 失败，已恢复原文件`)
  })
}
