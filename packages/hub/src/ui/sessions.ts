import { createHash, randomBytes } from 'node:crypto'

/**
 * Web 页面的登录码与会话（add-m1-inbox 6.1，design D5；inbox-web "本机登录"）。
 *
 * - 登录码：32 字节随机数（256 位），60 秒内有效，只能使用一次；
 * - 会话：32 字节随机数，7 天有效，写进 HttpOnly cookie；
 * - 两者都只在内存中保存 sha256 摘要，明文只交给调用方一次。中枢重启后全部失效，需要重新运行 `flow ui`。
 *
 * 这是与 `/v1` Bearer 鉴权完全独立的一条路径：会话只能访问 `/ui` 下的路由。
 */

export const LOGIN_CODE_TTL_MS = 60_000
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 同时有效的登录码与会话的上限；超出时淘汰最早的，避免内存无界增长。 */
const MAX_CODES = 16
const MAX_SESSIONS = 32

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const secret = () => randomBytes(32).toString('base64url')
/** 明文的形状：43 个 base64url 字符。不符合的输入直接拒绝，不做摘要比较。 */
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/

export interface UiSessions {
  /** 申请一次性登录码（仅供 user 经 `/v1/ui/login-code` 调用）。 */
  issueCode(): { code: string; expires_at: string }
  /** 用登录码换会话；无论成功与否，登录码都被消耗。失败返回 null。 */
  redeem(code: string): { session: string; expires_at: string } | null
  /** 会话是否有效。 */
  valid(session: string | undefined): boolean
  /** 退出登录：立即撤销会话。 */
  revoke(session: string | undefined): void
}

export function createUiSessions(options: { now?: () => number } = {}): UiSessions {
  const now = options.now ?? Date.now
  const codes = new Map<string, number>()
  const sessions = new Map<string, number>()

  // Map 保留插入顺序，最早插入的在最前面。
  const prune = (map: Map<string, number>, max: number) => {
    const t = now()
    for (const [key, expires] of map) if (expires <= t) map.delete(key)
    while (map.size >= max) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }

  return {
    issueCode() {
      prune(codes, MAX_CODES)
      const code = secret()
      const expires = now() + LOGIN_CODE_TTL_MS
      codes.set(digest(code), expires)
      return { code, expires_at: new Date(expires).toISOString() }
    },
    redeem(code) {
      if (!SECRET_RE.test(code)) return null
      const key = digest(code)
      const expires = codes.get(key)
      codes.delete(key)
      if (expires === undefined || expires <= now()) return null
      prune(sessions, MAX_SESSIONS)
      const session = secret()
      const until = now() + SESSION_TTL_MS
      sessions.set(digest(session), until)
      return { session, expires_at: new Date(until).toISOString() }
    },
    valid(session) {
      if (!session || !SECRET_RE.test(session)) return false
      const key = digest(session)
      const expires = sessions.get(key)
      if (expires === undefined) return false
      if (expires <= now()) {
        sessions.delete(key)
        return false
      }
      return true
    },
    revoke(session) {
      if (session && SECRET_RE.test(session)) sessions.delete(digest(session))
    },
  }
}
