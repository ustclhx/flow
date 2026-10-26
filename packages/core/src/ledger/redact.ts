import { fail, type Result } from '../result.ts'

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
  /**
   * high：带厂商前缀、格式明确，几乎不会误报，可用于拒绝创建任务（`findHighConfidenceSecrets`）；
   * low：按键名、参数名或通用前缀猜测，只用于自由文本的脱敏。
   */
  confidence: 'high' | 'low'
  /** 检测用的正则（缺省同 re）；例如私钥检测要求完整的 BEGIN…END 块。 */
  detect?: RegExp
}

/** 敏感的键名片段：`DB_PASSWORD`、`GITHUB_TOKEN`、`OPENAI_API_KEY`、`AWS_SECRET_ACCESS_KEY` 等都含有其一。 */
const KEY_WORDS = 'api[_-]?key|secret|token|passw(?:or)?d|pwd|access[_-]?key|private[_-]?key'

/**
 * 规则按替换顺序排列。同一类凭证可能拆成 high / low 两条（例如 ghp_ 与 ghu_），标签相同。
 * 替换（redactSecrets）使用全部规则；拒绝（findHighConfidenceSecrets）只用 high。
 */
const RULES: readonly Rule[] = [
  {
    id: 'private-key',
    confidence: 'high',
    re: /-----BEGIN[A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,8192}?(?:-----END[A-Z ]{0,40}PRIVATE KEY-----|\[REDACTED:private-key\]|$)/g,
    detect:
      /-----BEGIN[A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,8192}?-----END[A-Z ]{0,40}PRIVATE KEY-----/,
  },
  { id: 'aws-access-key', confidence: 'high', re: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    id: 'aws-access-key',
    confidence: 'low',
    re: /\b(?:ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}\b/g,
  },
  {
    id: 'github-token',
    confidence: 'high',
    re: /\b(?:gh[po]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{30,255})/g,
  },
  { id: 'github-token', confidence: 'low', re: /\bgh[usr]_[A-Za-z0-9]{30,255}/g },
  { id: 'gitlab-token', confidence: 'high', re: /\bglpat-[A-Za-z0-9_-]{20,255}/g },
  { id: 'slack-token', confidence: 'high', re: /\bxox[bp]-[A-Za-z0-9-]{10,255}/g },
  { id: 'slack-token', confidence: 'low', re: /\bxox[aosr]-[A-Za-z0-9-]{10,255}/g },
  {
    id: 'stripe-key',
    confidence: 'low',
    re: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,255}/g,
  },
  { id: 'google-api-key', confidence: 'low', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { id: 'npm-token', confidence: 'high', re: /\bnpm_[A-Za-z0-9]{30,255}/g },
  // `flow hub token issue` 签发的绑定 token（明文只输出一次，中枢只存摘要，无法入名单）。
  { id: 'flow-hub-token', confidence: 'high', re: /\bfht_[A-Za-z0-9_-]{43}/g },
  // 中枢按唤醒租约签发的唤醒绑定 token（add-m1-supervisor D6），只在租约响应中下发一次。
  { id: 'flow-wake-token', confidence: 'high', re: /\bfwk_[A-Za-z0-9_-]{43}/g },
  { id: 'huggingface-token', confidence: 'high', re: /\bhf_[A-Za-z0-9]{30,255}/g },
  { id: 'api-key', confidence: 'high', re: /\bsk-ant-[A-Za-z0-9_-]{20,512}/g },
  // 通用的 sk- 前缀会命中 `sk-learn-…` 这类普通名字，只用于自由文本。
  { id: 'api-key', confidence: 'low', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,512}/g },
  {
    id: 'jwt',
    confidence: 'high',
    re: /\beyJ[A-Za-z0-9_-]{8,1024}\.eyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,1024}/g,
  },
  {
    id: 'bearer',
    confidence: 'low',
    re: /(Bearer[ \t]{1,5})([A-Za-z0-9._~+/=-]{16,1024})/gi,
    group: 2,
  },
  {
    id: 'basic-auth',
    confidence: 'low',
    re: /(Authorization:[ \t]{0,5}Basic[ \t]{1,5})([A-Za-z0-9+/]{8,1024}={0,2})/gi,
    group: 2,
  },
  {
    id: 'cli-flag',
    confidence: 'low',
    re: /(--(?:password|passwd|token|secret|api-key|access-key)(?:=|[ \t]{1,5}))([^\s"']{3,512})/gi,
    group: 2,
  },
  {
    // 不用 \b 开头：`DB_PASSWORD` 中 `_` 与 `P` 之间没有单词边界。键名片段之后最多再跟 40 个键名字符。
    id: 'assignment',
    confidence: 'low',
    re: new RegExp(
      `((?:${KEY_WORDS})[A-Za-z0-9_]{0,40}["']?[ \\t]{0,5}[:=][ \\t]{0,5}["']?)([^\\s"',;]{8,512})`,
      'gi',
    ),
    group: 2,
  },
  {
    // scheme 限长，避免 `a.a.a…` 这类输入的平方级回溯（复核第 1 条）。
    id: 'url-credentials',
    confidence: 'low',
    re: /(\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@]{1,128}:)([^\s@/]{3,256})(@)/gi,
    group: 2,
  },
]

/** 高置信度规则的 id（带厂商前缀、格式明确）。 */
export const HIGH_CONFIDENCE_RULES: readonly string[] = [
  ...new Set(RULES.filter((r) => r.confidence === 'high').map((r) => r.id)),
]
/** 低置信度规则的 id（只用于自由文本脱敏）。 */
export const LOW_CONFIDENCE_RULES: readonly string[] = [
  ...new Set(RULES.filter((r) => r.confidence === 'low').map((r) => r.id)),
]

const HIGH_DETECTORS = RULES.filter((r) => r.confidence === 'high').map((r) => ({
  id: r.id,
  re: new RegExp((r.detect ?? r.re).source, (r.detect ?? r.re).flags.replace('g', '')),
}))

/** 文本中命中的高置信度规则 id（去重）；不返回命中的值。 */
export function findHighConfidenceSecrets(text: string): string[] {
  return [...new Set(HIGH_DETECTORS.filter((d) => d.re.test(text)).map((d) => d.id))]
}

/**
 * 在任意 JSON 形态的值（例如任务合同）中查找高置信度的疑似密钥，返回字段路径与规则 id。
 * 用于创建任务时拒绝：结构化、会被执行的内容不做改写，只能整体拒绝并提示改用 `secret://`。
 */
export function scanForHighConfidenceSecrets(
  value: unknown,
  path: string[] = [],
  out: Array<{ field: string; rule: string }> = [],
): Array<{ field: string; rule: string }> {
  if (typeof value === 'string') {
    for (const rule of findHighConfidenceSecrets(value)) out.push({ field: path.join('.'), rule })
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => {
      scanForHighConfidenceSecrets(v, [...path, String(i)], out)
    })
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) scanForHighConfidenceSecrets(v, [...path, k], out)
  }
  return out
}

const KEY_END_RE = /-----END[A-Z ]{0,40}PRIVATE KEY-----/
const KEY_MARKER = '[REDACTED:private-key]'
const BASE64_LINE_RE = /^[A-Za-z0-9+/=]{16,128}\r?$/
/** 私钥正文最多回溯的行数（8192 位 RSA 的 PEM 约 100 行）。 */
const KEY_BODY_MAX_LINES = 200

/**
 * `-----END … PRIVATE KEY-----` 之前连续的 base64 行一并脱敏（第三轮复核第 1 条）：
 * 截取窗口切掉了 BEGIN 那一行时，私钥正文仍然认得出来。逐行线性扫描，不用跨行正则，
 * 每行最多被看一次，回溯行数有上限。
 */
function redactKeyBodies(text: string): string {
  if (!text.includes('PRIVATE KEY-----') && !text.includes(KEY_MARKER)) return text
  const lines = text.split('\n')
  const out: string[] = []
  for (const line of lines) {
    // 上游已把 BEGIN / END 行替换成标记时（例如合同在入账时已脱敏），标记行同样视为结束行。
    if (KEY_END_RE.test(line) || line.trim() === KEY_MARKER) {
      let n = 0
      while (
        n < KEY_BODY_MAX_LINES &&
        out.length > 0 &&
        BASE64_LINE_RE.test(out[out.length - 1] ?? '')
      ) {
        out.pop()
        n++
      }
      out.push(line.replace(KEY_END_RE, '[REDACTED:private-key]'))
    } else out.push(line)
  }
  return out.join('\n')
}

/**
 * 已知密钥值的脱敏名单（secret-hygiene "已知密钥值的脱敏"、design D7）。
 *
 * 名单只在中枢进程内存中：中枢启动后注册自己的替换函数，停止时注销。`redactSecrets`
 * 先套用全部已注册的名单（值 → `[secret:<路径>]`），再跑下面的正则兜底，保证名单优先：
 * 正则只替换一部分时，密钥剩余部分可能就认不出来了。节点进程不持有密钥，不注册任何名单。
 */
const knownSecretRedactors = new Set<(text: string) => string>()

/** 注册一个名单替换函数，返回注销函数。同一进程可以有多个（测试中多个中枢并存）。 */
export function registerKnownSecrets(redact: (text: string) => string): () => void {
  const entry = (text: string) => redact(text)
  knownSecretRedactors.add(entry)
  return () => {
    knownSecretRedactors.delete(entry)
  }
}

/** 只套用已注册的名单，不跑正则。 */
export function redactKnownSecrets(text: string): string {
  let out = text
  for (const redact of knownSecretRedactors) out = redact(out)
  return out
}

/**
 * 把文本中的已知密钥值替换为 `[secret:<路径>]`，再把疑似密钥的部分替换为 `[REDACTED:<规则>]`。
 * 调用方应先截断输入。
 */
export function redactSecrets(text: string): string {
  // 名单替换出的 `[secret:<路径>]` 本身形如 `secret:xxx`，会被 assignment 规则再次命中；
  // 正则阶段先换成不会被任何规则匹配的占位符，结束后还原。
  const labels: string[] = []
  let out = redactKnownSecrets(text).replace(SECRET_LABEL_RE, (label) => {
    labels.push(label)
    return `\uE000${labels.length - 1}\uE001`
  })
  out = redactKeyBodies(out)
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
  return labels.length === 0
    ? out
    : out.replace(PLACEHOLDER_RE, (m, i: string) => labels[Number(i)] ?? m)
}

const SECRET_LABEL_RE = /\[secret:[A-Za-z0-9_./-]{1,256}\]/g
const PLACEHOLDER_RE = /\uE000(\d{1,6})\uE001/g

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
  // 名单在截断之前逐行套用：截断可能把一个已知密钥切成两半，剩下的前缀就认不出来了。
  const kept = clipTail(knownSecretRedactors.size > 0 ? lines.map(redactKnownSecrets) : lines)
  if (kept.length === 0) return []
  return redactSecrets(kept.join('\n'))
    .split('\n')
    .map((l) => clipText(l, TAIL_LINE_MAX))
}

/**
 * 逐行截断（每行 2000 字符）后整体脱敏，返回脱敏后的行。节点先对完整的输出缓冲调用它，
 * 再截取末尾若干行，避免截取窗口切断私钥块（第三轮复核第 1 条）。
 */
export function redactLines(lines: readonly string[]): string[] {
  if (lines.length === 0) return []
  return redactSecrets(lines.map((l) => clipText(l, TAIL_LINE_MAX)).join('\n')).split('\n')
}

/** 卡住说明入账前的处理：先替换已知密钥，再截断，再正则脱敏。 */
export function sanitizeMessage(message: string): string {
  // 同 sanitizeTail：已知密钥在截断前替换。
  return clipText(
    redactSecrets(clipText(redactKnownSecrets(message), BLOCKED_MESSAGE_MAX)),
    BLOCKED_MESSAGE_MAX,
  )
}

/** 账本中每条活动文本的长度上限（字符）。 */
export const ACTIVITY_TEXT_MAX = 4096

/** 任意文本入账前的处理：先替换已知密钥，再截断到 max，再正则脱敏，最后再保证不超过 max。 */
export function sanitizeText(text: string, max: number): string {
  return clipText(redactSecrets(clipText(redactKnownSecrets(text), max)), max)
}

/**
 * 创建任务前的检查（secret-hygiene）：合同是结构化、会被执行的内容，不能悄悄改写，
 * 命中高置信度规则时拒绝创建，返回 `secret_suspected`（400），提示改用 `secret://` 引用。
 * 错误信息与 details 只含字段路径和规则 id，不含命中的值。
 */
export function checkContractSecrets(contract: unknown): Result<void> {
  const hits = scanForHighConfidenceSecrets(contract)
  if (hits.length === 0) return { ok: true, data: undefined }
  const where = hits.map((h) => `${h.field || '（根）'}（${h.rule}）`).join('、')
  return fail(
    'usage',
    'secret_suspected',
    `任务合同中疑似含有密钥：${where}。请改用 secret://<路径> 引用，不要把密钥写进合同`,
    hits.map((h) => ({ field: h.field, code: 'secret_suspected', rule: h.rule })),
  )
}
