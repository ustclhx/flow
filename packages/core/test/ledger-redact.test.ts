import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import {
  redactLines,
  redactSecrets,
  sanitizeMessage,
  sanitizeTail,
  TAIL_LINE_MAX,
  TAIL_TOTAL_MAX_BYTES,
} from '../src/index.ts'

describe('中枢绑定 token 与名单标签', () => {
  test('fht_ 前缀的绑定 token 被替换；[secret:<路径>] 标签不被正则再次改写', () => {
    const bound = `fht_${randomBytes(32).toString('base64url')}`
    expect(redactSecrets(`token ${bound} end`)).toBe('token [REDACTED:flow-hub-token] end')
    expect(redactSecrets('API_TOKEN=[secret:telegram/bot-token]')).toBe(
      'API_TOKEN=[secret:telegram/bot-token]',
    )
  })
})

/**
 * 末尾输出入账前的脱敏与限长（PR #16 审查第 7 条）。
 * 样例在运行时拼接，源码中不出现像真密钥的字面量。
 */
const j = (...parts: string[]) => parts.join('')

describe('redactSecrets', () => {
  const cases: [string, string, string][] = [
    ['aws-access-key', j('AK', 'IA', 'Q'.repeat(16)), 'aws-access-key'],
    ['github-token', j('gh', 'p_', 'a1'.repeat(18)), 'github-token'],
    ['slack-token', j('xo', 'xb-', '1234567890-abcdef'), 'slack-token'],
    ['stripe-key', j('sk', '_live_', 'Q'.repeat(24)), 'stripe-key'],
    ['api-key', j('sk', '-ant-', 'Q'.repeat(30)), 'api-key'],
    ['jwt', j('ey', 'J', 'a'.repeat(12), '.ey', 'J', 'b'.repeat(12), '.', 'c'.repeat(12)), 'jwt'],
  ]
  test.each(cases)('%s', (_name, secret, rule) => {
    const out = redactSecrets(`前缀 ${secret} 后缀`)
    expect(out).not.toContain(secret)
    expect(out).toBe(`前缀 [REDACTED:${rule}] 后缀`)
  })

  test('只替换值：赋值、Bearer、URL 中的密码', () => {
    const value = 'V'.repeat(20)
    expect(redactSecrets(`API_KEY=${value}`)).toBe('API_KEY=[REDACTED:assignment]')
    expect(redactSecrets(`password: "${value}"`)).toBe('password: "[REDACTED:assignment]"')
    expect(redactSecrets(`Authorization: Bearer ${value}`)).toBe(
      'Authorization: Bearer [REDACTED:bearer]',
    )
    expect(redactSecrets(`git clone https://bot:${value}@example.com/r.git`)).toBe(
      'git clone https://bot:[REDACTED:url-credentials]@example.com/r.git',
    )
  })

  test('环境变量写法（大小写）与其他令牌前缀（复核第 3 条）', () => {
    const v = j('Vv', '9'.repeat(18))
    for (const key of [
      'DB_PASSWORD',
      'GITHUB_TOKEN',
      'OPENAI_API_KEY',
      'AWS_SECRET_ACCESS_KEY',
      'db_password',
      'github_token',
      'openai_api_key',
      'aws_secret_access_key',
    ]) {
      const out = redactSecrets(`export ${key}=${v}`)
      expect(out).toBe(`export ${key}=[REDACTED:assignment]`)
    }
    expect(redactSecrets(`npm ${j('np', 'm_', 'A'.repeat(36))}`)).toBe('npm [REDACTED:npm-token]')
    expect(redactSecrets(`hf ${j('h', 'f_', 'B'.repeat(34))}`)).toBe(
      'hf [REDACTED:huggingface-token]',
    )
    expect(redactSecrets(`Authorization: Basic ${j('dXNl', 'cjpw', 'YXNz')}`)).toBe(
      'Authorization: Basic [REDACTED:basic-auth]',
    )
    expect(redactSecrets(`mysql --password ${v} db`)).toBe(
      'mysql --password [REDACTED:cli-flag] db',
    )
    expect(redactSecrets(`tool --token=${v}`)).toBe('tool --token=[REDACTED:cli-flag]')
  })

  test('私钥块整体替换', () => {
    const block = j('-----BEGIN ', 'RSA PRIVATE KEY-----\nAAAA\n-----END ', 'RSA PRIVATE KEY-----')
    expect(redactSecrets(`a\n${block}\nb`)).toBe('a\n[REDACTED:private-key]\nb')
  })

  test('普通输出保持不变', () => {
    const text = 'Allow command `rm -rf build`? [y/n] token 数 1234，secret 管理见文档'
    expect(redactSecrets(text)).toBe(text)
  })
})

/** 运行时拼出的 PEM 形状文本（随机 base64 正文），不是真的私钥。4096 位约 50 行正文，8192 位约 98 行。 */
function fakePem(bodyLines: number): string[] {
  const body =
    randomBytes(bodyLines * 48)
      .toString('base64')
      .match(/.{1,64}/g) ?? []
  const label = j('PRIVATE', ' KEY')
  return [`-----BEGIN ${label}-----`, ...body, `-----END ${label}-----`]
}

describe('私钥块被截取窗口切断（第三轮复核第 1 条）', () => {
  test.each([
    ['4096 位', 50],
    ['8192 位', 98],
  ])('%s：末尾 40 行里没有 BEGIN 行也能脱敏', (_name, n) => {
    const pem = fakePem(n)
    const lines = ['$ cat key.pem', ...pem, '要继续吗？']
    const body = pem.slice(1, -1)
    const leaked = (out: string[]) => body.filter((l) => out.join('\n').includes(l))
    // 只看末尾 40 行（BEGIN 行已被切掉）：END 之前的连续 base64 行一并脱敏。
    const window = lines.slice(-40)
    expect(window.some((l) => l.includes('BEGIN'))).toBe(false)
    expect(leaked(redactSecrets(window.join('\n')).split('\n'))).toEqual([])
    expect(leaked(sanitizeTail(window))).toEqual([])
    // 节点的做法：先对完整缓冲脱敏，再取末尾 40 行。
    const redacted = redactLines(lines).slice(-40)
    expect(leaked(redacted)).toEqual([])
    expect(redacted).toContain('要继续吗？')
  })

  test('END 之前的普通文字不被吞掉；回溯行数有上限', () => {
    const label = j('PRIVATE', ' KEY')
    const out = redactSecrets(['普通输出', 'A'.repeat(64), `-----END ${label}-----`].join('\n'))
    expect(out).toBe('普通输出\n[REDACTED:private-key]')
    const many = [...Array.from({ length: 300 }, () => 'B'.repeat(64)), `-----END ${label}-----`]
    expect(redactSecrets(many.join('\n')).split('\n')).toHaveLength(101)
  })
})

describe('sanitizeTail / sanitizeMessage', () => {
  test('单行截断到 2000 字符', () => {
    const [line] = sanitizeTail(['z'.repeat(TAIL_LINE_MAX + 500)])
    expect(line).toHaveLength(TAIL_LINE_MAX)
    expect(line?.endsWith('…')).toBe(true)
  })

  test('总量不超过 16KB，保留最近的行', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `${i}`.padEnd(500, '.'))
    const kept = sanitizeTail(lines)
    expect(Buffer.byteLength(kept.join('\n'), 'utf8')).toBeLessThanOrEqual(TAIL_TOTAL_MAX_BYTES)
    expect(kept.at(-1)).toBe(lines.at(-1))
    expect(kept.length).toBeLessThan(lines.length)
  })

  test('说明也会脱敏', () => {
    const secret = j('gh', 'o_', 'b'.repeat(36))
    expect(sanitizeMessage(`用 ${secret}？`)).toBe('用 [REDACTED:github-token]？')
  })
})

describe('性能：病态输入不造成回溯爆炸（复核第 1 条）', () => {
  const MB = 1024 * 1024
  const patterns = [
    'a.',
    'a-',
    'a+',
    'eyJ',
    'ghp_',
    'sk-',
    'token',
    'password:',
    'a://b:',
    '-----BEGIN ',
    'secret_',
    'Bearer ',
    '--token ',
    'Authorization: Basic ',
  ]
  const timed = (fn: () => unknown) => {
    const t0 = performance.now()
    fn()
    return performance.now() - t0
  }

  /**
   * 绝对耗时只作防挂死的兜底（1 秒，CI 机器负载高时也不会误报）；
   * 是否线性由下面的复杂度断言判断：输入放大 4 倍，耗时比必须小于 8（平方级会接近 16）。
   */
  const HANG_GUARD_MS = 1000

  test.each(patterns)('1MB 的 %p 重复：sanitizeTail / sanitizeMessage 不挂死', (p) => {
    const big = p.repeat(Math.ceil(MB / p.length))
    // 拆分本身不计入耗时。
    const chunks = big.match(/.{1,1000}/g) ?? []
    expect(timed(() => sanitizeTail([big]))).toBeLessThan(HANG_GUARD_MS)
    expect(timed(() => sanitizeTail(chunks))).toBeLessThan(HANG_GUARD_MS)
    expect(timed(() => sanitizeMessage(big))).toBeLessThan(HANG_GUARD_MS)
  })

  /** 多次测量取最小值，减少调度抖动。 */
  const best = (fn: () => unknown, runs = 5) => {
    let min = Number.POSITIVE_INFINITY
    for (let i = 0; i < runs; i++) min = Math.min(min, timed(fn))
    return min
  }

  test.each(patterns)('16KB 的 %p 重复直接脱敏也是线性的', (p) => {
    const small = p.repeat(Math.ceil(TAIL_TOTAL_MAX_BYTES / 4 / p.length))
    const text = p.repeat(Math.ceil(TAIL_TOTAL_MAX_BYTES / p.length))
    expect(timed(() => redactSecrets(text))).toBeLessThan(HANG_GUARD_MS)
    redactSecrets(small) // 预热
    const t4 = best(() => redactSecrets(small))
    const t16 = best(() => redactSecrets(text))
    // 计时器分辨率以下的耗时不比较比值（分母取 0.05ms 下限）。
    expect(t16 / Math.max(t4, 0.05)).toBeLessThan(8)
  })
})
