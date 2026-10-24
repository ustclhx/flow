/**
 * 写入账本前的轻量脱敏与限长（PR #16 审查第 7 条）。
 *
 * 末尾输出（`task.blocked` 的 tail）来自 worker 的终端，可能夹带令牌或密钥。M0 的
 * `scanForSecrets` 依赖外部 gitleaks 进程且是异步的，不适合放在中枢同步的写事务里，
 * 所以这里用一组常见模式（参照 gitleaks 默认规则中最常见的几类）做替换：
 * 命中的部分换成 `[REDACTED:<规则>]`，其余文本保留，便于人判断 worker 卡在哪里。
 * 这是尽力而为的兜底，不是完整的密钥扫描。
 */

interface Rule {
  id: string
  re: RegExp
  /** 只替换某个捕获组（例如 `password=` 之后的值）；缺省替换整个匹配。 */
  group?: number
}

const RULES: readonly Rule[] = [
  {
    id: 'private-key',
    re: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END[A-Z ]*PRIVATE KEY-----|$)/g,
  },
  { id: 'aws-access-key', re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}\b/g },
  { id: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g },
  { id: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'stripe-key', re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'api-key', re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { id: 'bearer', re: /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{16,})/gi, group: 2 },
  {
    id: 'assignment',
    re: /\b((?:api[_-]?key|secret|token|passw(?:or)?d|pwd|access[_-]?key|client[_-]?secret)\w*["']?\s*[:=]\s*["']?)([^\s"',;]{8,})/gi,
    group: 2,
  },
  { id: 'url-credentials', re: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]{3,})(@)/gi, group: 2 },
]

/** 把文本中疑似密钥的部分替换为 `[REDACTED:<规则>]`。 */
export function redactSecrets(text: string): string {
  let out = text
  for (const rule of RULES) {
    out = out.replace(rule.re, (_match: string, ...rest: unknown[]) => {
      if (rule.group === undefined) return `[REDACTED:${rule.id}]`
      // 带 group 的规则，各捕获组首尾相接恰好覆盖整个匹配；rest 末尾两项是 offset 与原串。
      const groups = rest.slice(0, -2) as (string | undefined)[]
      return groups
        .map((g, i) => (i + 1 === rule.group ? `[REDACTED:${rule.id}]` : (g ?? '')))
        .join('')
    })
  }
  return out
}

/** 末尾输出的单行长度上限（字符）。 */
export const TAIL_LINE_MAX = 2000
/** 末尾输出的总量上限（UTF-8 字节）。 */
export const TAIL_TOTAL_MAX_BYTES = 16 * 1024
/** 卡住说明的长度上限（字符）。 */
export const BLOCKED_MESSAGE_MAX = 2000

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s)

/**
 * 末尾输出入账前的处理：逐行脱敏 → 单行截断到 2000 字符 → 从末尾往前保留，
 * 总量不超过 16KB（保留最近的输出）。
 */
export function sanitizeTail(lines: readonly string[]): string[] {
  const kept: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = clip(redactSecrets(lines[i] ?? ''), TAIL_LINE_MAX)
    const size = Buffer.byteLength(line, 'utf8') + 1
    if (bytes + size > TAIL_TOTAL_MAX_BYTES) break
    bytes += size
    kept.push(line)
  }
  return kept.reverse()
}

/** 卡住说明入账前的处理：脱敏并截断。 */
export function sanitizeMessage(message: string): string {
  return clip(redactSecrets(message), BLOCKED_MESSAGE_MAX)
}
