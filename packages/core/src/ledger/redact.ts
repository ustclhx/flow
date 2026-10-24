/**
 * 写入账本前的轻量脱敏与限长（PR #16 审查第 7 条、复核第 1、3 条）。
 *
 * 末尾输出（`task.blocked` 的 tail）来自 worker 的终端，可能夹带令牌或密钥。M0 的
 * `scanForSecrets` 依赖外部 gitleaks 进程且是异步的，不适合放在中枢同步的写事务里，
 * 所以这里用一组常见模式（参照 gitleaks 默认规则中最常见的几类）做替换：
 * 命中的部分换成 `[REDACTED:<规则>]`，其余文本保留，便于人判断 worker 卡在哪里。
 * 这是尽力而为的兜底，不是完整的密钥扫描。
 *
 * **性能约束**：这些正则在中枢的同步写事务里执行，必须对任意输入都是近似线性的：
 * - 每个可变长度的量词都有上界（`{m,n}`），不出现无界的 `*` / `+`；
 * - 相邻的可变部分字符集不重叠，避免回溯爆炸；
 * - 调用方先截断再脱敏（`sanitizeTail` / `sanitizeMessage`），脱敏的输入最多十几 KB。
 */

interface Rule {
  id: string
  re: RegExp
  /** 只替换某个捕获组（例如 `password=` 之后的值）；缺省替换整个匹配。 */
  group?: number
}

/** 敏感的键名片段：`DB_PASSWORD`、`GITHUB_TOKEN`、`OPENAI_API_KEY`、`AWS_SECRET_ACCESS_KEY` 等都含有其一。 */
const KEY_WORDS = 'api[_-]?key|secret|token|passw(?:or)?d|pwd|access[_-]?key|private[_-]?key'

const RULES: readonly Rule[] = [
  {
    id: 'private-key',
    re: /-----BEGIN[A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,8192}?(?:-----END[A-Z ]{0,40}PRIVATE KEY-----|$)/g,
  },
  { id: 'aws-access-key', re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}\b/g },
  {
    id: 'github-token',
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{30,255})/g,
  },
  { id: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{20,255}/g },
  { id: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,255}/g },
  { id: 'stripe-key', re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,255}/g },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { id: 'npm-token', re: /\bnpm_[A-Za-z0-9]{30,255}/g },
  { id: 'huggingface-token', re: /\bhf_[A-Za-z0-9]{30,255}/g },
  { id: 'api-key', re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,512}/g },
  {
    id: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{8,1024}\.eyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,1024}/g,
  },
  { id: 'bearer', re: /(Bearer[ \t]{1,5})([A-Za-z0-9._~+/=-]{16,1024})/gi, group: 2 },
  {
    id: 'basic-auth',
    re: /(Authorization:[ \t]{0,5}Basic[ \t]{1,5})([A-Za-z0-9+/]{8,1024}={0,2})/gi,
    group: 2,
  },
  {
    id: 'cli-flag',
    re: /(--(?:password|passwd|token|secret|api-key|access-key)(?:=|[ \t]{1,5}))([^\s"']{3,512})/gi,
    group: 2,
  },
  {
    // 不用 \b 开头：`DB_PASSWORD` 中 `_` 与 `P` 之间没有单词边界。键名片段之后最多再跟 40 个键名字符。
    id: 'assignment',
    re: new RegExp(
      `((?:${KEY_WORDS})[A-Za-z0-9_]{0,40}["']?[ \\t]{0,5}[:=][ \\t]{0,5}["']?)([^\\s"',;]{8,512})`,
      'gi',
    ),
    group: 2,
  },
  {
    // scheme 限长，避免 `a.a.a…` 这类输入的平方级回溯（复核第 1 条）。
    id: 'url-credentials',
    re: /(\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@]{1,128}:)([^\s@/]{3,256})(@)/gi,
    group: 2,
  },
]

/** 把文本中疑似密钥的部分替换为 `[REDACTED:<规则>]`。调用方应先截断输入。 */
export function redactSecrets(text: string): string {
  let out = text
  for (const rule of RULES) {
    out = out.replace(rule.re, (match: string, ...rest: unknown[]) => {
      if (rule.group === undefined) return `[REDACTED:${rule.id}]`
      // 带 group 的规则，各捕获组首尾相接恰好覆盖整个匹配；rest 末尾两项是 offset 与原串。
      const groups = rest.slice(0, -2) as (string | undefined)[]
      // 值已被前面的规则替换过（例如 `--token=[REDACTED:cli-flag]`）：保持原样，不重复标注。
      if (groups[rule.group - 1]?.startsWith('[REDACTED:')) return match
      return groups
        .map((g, i) => (i + 1 === rule.group ? `[REDACTED:${rule.id}]` : (g ?? '')))
        .join('')
    })
  }
  return out
}

/** 末尾输出的单行长度上限（字符），协议 schema 也按它拒绝超长行。 */
export const TAIL_LINE_MAX = 2000
/** 末尾输出的总量上限（UTF-8 字节）。 */
export const TAIL_TOTAL_MAX_BYTES = 16 * 1024
/** 卡住说明入账时的长度上限（字符）。 */
export const BLOCKED_MESSAGE_MAX = 2000
/** 协议中卡住说明的长度上限（字符）：超过时请求直接被拒绝。 */
export const PROTOCOL_MESSAGE_MAX = 8192

/** 截断到 max 个字符，超出时以 `…` 结尾（结果最多 max 个字符）。 */
export const clipText = (s: string, max: number) =>
  s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s

/** 只截断不脱敏：节点上报前用，保证不超过协议上限。 */
export function clipTail(lines: readonly string[]): string[] {
  const kept: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && kept.length < 200; i--) {
    const line = clipText(lines[i] ?? '', TAIL_LINE_MAX)
    const size = Buffer.byteLength(line, 'utf8') + 1
    if (bytes + size > TAIL_TOTAL_MAX_BYTES) break
    bytes += size
    kept.push(line)
  }
  return kept.reverse()
}

/**
 * 末尾输出入账前的处理：先截断（单行 2000 字符、从末尾往前保留不超过 16KB、最多 200 行），
 * 再把保留下来的部分整体脱敏（跨行的私钥块也能识别）。
 */
export function sanitizeTail(lines: readonly string[]): string[] {
  const kept = clipTail(lines)
  if (kept.length === 0) return []
  return redactSecrets(kept.join('\n'))
    .split('\n')
    .map((l) => clipText(l, TAIL_LINE_MAX))
}

/** 卡住说明入账前的处理：先截断，再脱敏。 */
export function sanitizeMessage(message: string): string {
  return clipText(redactSecrets(clipText(message, BLOCKED_MESSAGE_MAX)), BLOCKED_MESSAGE_MAX)
}
