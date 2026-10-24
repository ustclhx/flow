import { createHash, randomInt } from 'node:crypto'

/**
 * Telegram 绑定码（add-m1-inbox 5.1，design D4；telegram-channel "绑定用户本人"）：
 * - `flow telegram link` 经 `/v1/telegram/link-code`（仅 user）申请；已绑定时必须加 `--rebind`；
 * - 16 个字符，取自去掉易混字符的 31 个小写字母与数字，约 79 位随机（≥ 64 位）；
 * - 只在中枢内存中保存 sha256 摘要，10 分钟内有效，只能使用一次；中枢重启后全部失效；
 * - **按 chat 限流**：同一个 chat 每分钟最多 5 次错误尝试，超出后忽略该 chat 10 分钟。
 *   错误尝试不会影响别的 chat，也不会清掉已发出的码（不能靠刷错误码让用户永远绑定不上）；
 *   格式不合法的码（例如路人点开旧链接、随手发的 `/start`）不计数，直接忽略。
 */

export const LINK_CODE_TTL_MS = 10 * 60_000
export const LINK_CODE_LENGTH = 16
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const CODE_RE = new RegExp(`^[${ALPHABET}]{${LINK_CODE_LENGTH}}$`)
/** 同时有效的码的上限；超出时淘汰最早的。 */
const MAX_CODES = 8
/** 每个 chat 在窗口内允许的错误尝试次数。 */
export const LINK_ATTEMPT_LIMIT = 5
export const LINK_ATTEMPT_WINDOW_MS = 60_000
/** 超限后忽略该 chat 的时长。 */
export const LINK_BLOCK_MS = 10 * 60_000
/** 记录尝试的 chat 数上限（防止内存无界增长）。 */
const MAX_TRACKED_CHATS = 1000

const digest = (code: string) => createHash('sha256').update(code).digest('hex')

/**
 * - `ok`：码正确，已消耗；
 * - `invalid`：格式正确但不是有效的码（错误、过期或已用过），计入该 chat 的错误次数；
 * - `malformed`：格式不合法，不计数；
 * - `limited`：该 chat 错误次数过多，暂时忽略（不校验码）。
 */
export type RedeemResult = 'ok' | 'invalid' | 'malformed' | 'limited'

export interface TelegramLinks {
  issue(): { code: string; expires_at: string }
  /** 校验并消耗绑定码。`chat` 是发码的 chat id，用于限流。 */
  redeem(code: string, chat: number): RedeemResult
  /** bot 的用户名（插件启动时由 getMe 填入），用于生成 t.me 深链接。 */
  botUsername: string | null
  /** 解除绑定后通知插件立即停止接受原 chat（插件启动时设置）。 */
  onUnlinked: (() => void) | null
}

export function createTelegramLinks(options: { now?: () => number } = {}): TelegramLinks {
  const now = options.now ?? Date.now
  const codes = new Map<string, number>()
  /** chat → 窗口内错误尝试的时间、忽略到何时。 */
  const attempts = new Map<number, { times: number[]; blockedUntil: number }>()

  const prune = () => {
    const t = now()
    for (const [key, expires] of codes) if (expires <= t) codes.delete(key)
    for (const [chat, a] of attempts) {
      if (a.blockedUntil <= t && a.times.every((x) => t - x >= LINK_ATTEMPT_WINDOW_MS)) {
        attempts.delete(chat)
      }
    }
  }

  return {
    botUsername: null,
    onUnlinked: null,
    issue() {
      prune()
      while (codes.size >= MAX_CODES) {
        const oldest = codes.keys().next().value
        if (oldest === undefined) break
        codes.delete(oldest)
      }
      let code = ''
      for (let i = 0; i < LINK_CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)]
      const expires = now() + LINK_CODE_TTL_MS
      codes.set(digest(code), expires)
      return { code, expires_at: new Date(expires).toISOString() }
    },
    redeem(raw, chat) {
      prune()
      const t = now()
      const record = attempts.get(chat)
      if (record && record.blockedUntil > t) return 'limited'
      const code = raw.trim().toLowerCase()
      if (!CODE_RE.test(code)) return 'malformed'
      const key = digest(code)
      const expires = codes.get(key)
      if (expires !== undefined && expires > t) {
        codes.delete(key)
        return 'ok'
      }
      // 记一次错误尝试（只影响这个 chat）
      const a = record ?? { times: [], blockedUntil: 0 }
      a.times = [...a.times.filter((x) => t - x < LINK_ATTEMPT_WINDOW_MS), t]
      if (a.times.length >= LINK_ATTEMPT_LIMIT) {
        a.blockedUntil = t + LINK_BLOCK_MS
        a.times = []
      }
      if (!record) {
        if (attempts.size >= MAX_TRACKED_CHATS) {
          const oldest = attempts.keys().next().value
          if (oldest !== undefined) attempts.delete(oldest)
        }
        attempts.set(chat, a)
      }
      return 'invalid'
    },
  }
}
