import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseFrontmatter } from '../src/frontmatter.ts'
import { appendCapture, appendJournal, renderEntry, writeEntry } from '../src/write/api.ts'
import { scanForSecrets } from '../src/write/secrets.ts'
import { commitCount, fakeStripeKey, gitStatus, initTempHome, snapshot } from './helpers.ts'

const dataSource = {
  type: 'data-source',
  title: 'Stripe',
  summary: '东方站的 Stripe 数据',
  scope: 'work',
  owner: 'ws/xuanxue-saas',
  provider: 'stripe',
  credential: 'secret://stripe/readonly',
  sources: ['https://dashboard.stripe.com'],
}

describe('scanForSecrets', () => {
  test('发现假 Stripe key：给出规则 ID 与行号，结果中不含原文', async () => {
    const key = fakeStripeKey()
    const r = await scanForSecrets(`第一行\nkey: ${key}\n第三行\n`)
    if (!r.ok) throw new Error(r.error.message)
    expect(r.data.findings).toHaveLength(1)
    expect(r.data.findings[0]?.ruleId).toBe('stripe-access-token')
    expect(r.data.findings[0]?.line).toBe(2)
    expect(JSON.stringify(r)).not.toContain(key)
  })

  test('secret:// 引用不是密钥', async () => {
    const r = await scanForSecrets('credential: secret://stripe/readonly\n')
    if (!r.ok) throw new Error(r.error.message)
    expect(r.data.findings).toEqual([])
  })

  test('使用仓库的 .gitleaks.toml', async () => {
    const home = await initTempHome()
    const r = await scanForSecrets('credential: secret://cloudflare/zone-ezarouter\n', {
      configPath: join(home, 'brain', '.gitleaks.toml'),
    })
    expect(r.ok && r.data.findings).toEqual([])
  })

  test('gitleaks 缺失时返回明确错误，不静默放行', async () => {
    const r = await scanForSecrets('hello', { gitleaksBin: '/nonexistent/gitleaks' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('gitleaks_missing')
  })
})

describe('Flow 写入前扫描', () => {
  test('agent 在 journal 里粘贴了 key：写入被拒绝，错误只给位置和类型，不含原文', async () => {
    const home = await initTempHome()
    const brain = join(home, 'brain')
    const before = snapshot(brain)
    const commits = await commitCount(brain)
    const key = fakeStripeKey()
    const r = await appendJournal(
      home,
      { workspace: 'ws/product-res', text: `调试支付\n用的 key 是 ${key}` },
      { actor: 'codex' },
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('secret_detected')
    expect(r.error.message).toContain('stripe-access-token')
    expect(r.error.message).toMatch(/brain\/journal\/\d{4}-\d{2}-\d{2}\.md 第 \d+ 行/)
    expect(JSON.stringify(r)).not.toContain(key)
    expect(snapshot(brain)).toEqual(before)
    expect(await commitCount(brain)).toBe(commits)
  })

  test('追加时行号是文件中的行号', async () => {
    const home = await initTempHome()
    const ok1 = await appendJournal(home, { text: '第一条' }, { actor: 'codex' })
    if (!ok1.ok) throw new Error(ok1.error.message)
    const existing = readFileSync(join(home, ok1.data.file), 'utf8').split('\n').length - 1
    const r = await appendJournal(home, { text: `key ${fakeStripeKey()}` }, { actor: 'codex' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    const findings = (
      r.error.details as { findings: { file: string; line: number; ruleId: string }[] }
    ).findings
    // 新记录：空行、标题、空行、正文 → 正文在已有行数 + 4 行。
    expect(findings).toContainEqual({
      file: ok1.data.file,
      line: existing + 4,
      ruleId: 'stripe-access-token',
    })
    // log 简述取自正文首行，同样被扫描并定位到 log.md 的新行。
    const logLines = readFileSync(join(home, 'brain', 'log.md'), 'utf8').split('\n').length - 1
    expect(findings).toContainEqual({
      file: 'brain/log.md',
      line: logLines + 1,
      ruleId: 'stripe-access-token',
    })
  })

  test('随手记中的 key 被拒绝，raw 不变', async () => {
    const home = await initTempHome()
    const raw = join(home, 'raw')
    const before = snapshot(raw)
    const r = await appendCapture(
      home,
      { text: `token ${fakeStripeKey()}`, source: 'cli' },
      { actor: 'user' },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('secret_detected')
    expect(snapshot(raw)).toEqual(before)
    expect(existsSync(join(raw, 'inbox'))).toBe(false)
  })

  test('条目中的 key 被拒绝（即使是用户写入）', async () => {
    const home = await initTempHome()
    const r = await writeEntry(
      home,
      {
        id: 'resources/data-sources/stripe',
        frontmatter: { ...dataSource, credential: undefined },
        body: `api key: ${fakeStripeKey()}\n`,
      },
      { actor: 'user' },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('secret_detected')
      expect(JSON.stringify(r)).not.toContain(fakeStripeKey())
    }
    expect(existsSync(join(home, 'brain', 'resources'))).toBe(false)
  })

  test('数据源条目引用密钥：校验和扫描都通过，引用原样保留', async () => {
    const home = await initTempHome()
    const r = await writeEntry(
      home,
      { id: 'resources/data-sources/stripe', frontmatter: dataSource },
      { actor: 'claude' },
    )
    if (!r.ok) throw new Error(r.error.message)
    const text = readFileSync(join(home, 'brain', 'resources/data-sources/stripe.md'), 'utf8')
    expect(text).toBe(renderEntry(dataSource))
    const fm = parseFrontmatter(text)
    expect(fm.ok && fm.data.data.credential).toBe('secret://stripe/readonly')
    expect(await gitStatus(join(home, 'brain'))).toBe('')
  })

  test('gitleaks 缺失时写入被拒绝', async () => {
    const home = await initTempHome()
    const r = await appendJournal(
      home,
      { text: 'hello' },
      { actor: 'user', gitleaksBin: '/nonexistent/gitleaks' },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('gitleaks_missing')
    expect(existsSync(join(home, 'brain', 'journal'))).toBe(false)
  })
})
