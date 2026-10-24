import { describe, expect, test } from 'bun:test'
import {
  redactSecrets,
  sanitizeMessage,
  sanitizeTail,
  TAIL_LINE_MAX,
  TAIL_TOTAL_MAX_BYTES,
} from '../src/index.ts'

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

  test('私钥块整体替换', () => {
    const block = j('-----BEGIN ', 'RSA PRIVATE KEY-----\nAAAA\n-----END ', 'RSA PRIVATE KEY-----')
    expect(redactSecrets(`a\n${block}\nb`)).toBe('a\n[REDACTED:private-key]\nb')
  })

  test('普通输出保持不变', () => {
    const text = 'Allow command `rm -rf build`? [y/n] token 数 1234，secret 管理见文档'
    expect(redactSecrets(text)).toBe(text)
  })
})

describe('sanitizeTail / sanitizeMessage', () => {
  test('单行截断到 2000 字符', () => {
    const [line] = sanitizeTail(['z'.repeat(TAIL_LINE_MAX + 500)])
    expect(line).toHaveLength(TAIL_LINE_MAX + 1)
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
