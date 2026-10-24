import { createHash, randomInt } from 'node:crypto'

/**
 * Telegram 绑定码（add-m1-inbox 5.1，design D4；telegram-channel "绑定用户本人"）：
 * - `flow telegram link` 经 `/v1/telegram/link-code`（仅 user）申请；
 * - 16 个字符，取自去掉易混字符的 31 个小写字母与数字，约 79 位随机（≥ 64 位）；
 * - 只在中枢内存中保存 sha256 摘要，10 分钟内有效，只能使用一次；中枢重启后全部失效；
 * - 错误的码累计 10 次后清空所有未使用的码（防止猜码），需要重新申请。
 */

export const LINK_CODE_TTL_MS = 10 * 60_000
export const LINK_CODE_LENGTH = 16
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const CODE_RE = new RegExp(`^[${ALPHABET}]{${LINK_CODE_LENGTH}}$`)
/** 同时有效的码的上限；超出时淘汰最早的。 */
const MAX_CODES = 8
/** 错误尝试达到这个次数后清空全部未使用的码。 */
export const LINK_FAILURE_LIMIT = 10

const digest = (code: string) => createHash('sha256').update(code).digest('hex')

export interface TelegramLinks {
  issue(): { code: string; expires_at: string }
  /** 校验并消耗绑定码；成功返回 true。 */
  redeem(code: string): boolean
  /** bot 的用户名（插件启动时由 getMe 填入），用于生成 t.me 深链接。 */
  botUsername: string | null
}

export function createTelegramLinks(options: { now?: () => number } = {}): TelegramLinks {
  const now = options.now ?? Date.now
  const codes = new Map<string, number>()
  let failures = 0

  const prune = () => {
    const t = now()
    for (const [key, expires] of codes) if (expires <= t) codes.delete(key)
  }

  return {
    botUsername: null,
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
    redeem(raw) {
      prune()
      const code = raw.trim().toLowerCase()
      const key = CODE_RE.test(code) ? digest(code) : null
      const expires = key ? codes.get(key) : undefined
      if (key && expires !== undefined && expires > now()) {
        codes.delete(key)
        failures = 0
        return true
      }
      failures += 1
      if (failures >= LINK_FAILURE_LIMIT) {
        codes.clear()
        failures = 0
      }
      return false
    },
  }
}
