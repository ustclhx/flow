import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { taskContract } from '@flow/core'
import { analyzeTail, classifyCodexOrca, isBusy, lastMessage } from '../src/codex-orca/classify.ts'
import { TUI_FIXTURES, tuiFixture } from './codex-orca-helpers.ts'

/**
 * classify 的 fixture 测试（add-m1-executors 2.3）：`test/fixtures/codex-tui/` 下是
 * Codex 0.164.0 在 Orca 1.4.218 终端中的真实片段（`orca terminal read --json` 的完整输出，已脱敏）。
 */

const contract = taskContract.parse({
  goal: 'g',
  workspace: 'ws/product-res',
  role: 'dev',
  executor: 'codex-orca',
})
const snapshot = (name: string, trigger: 'idle' | 'no_progress' = 'idle') => ({
  trigger,
  tail: [],
  idle_ms: 60_000,
  hint: { tail: tuiFixture(name).tail },
  contract,
})

describe('fixture 清单', () => {
  test('每个 fixture 都能按 Orca 的输出 schema 解析，且都列在 TUI_FIXTURES 中', () => {
    const files = readdirSync(join(import.meta.dir, 'fixtures', 'codex-tui'))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5))
      .sort()
    expect(files).toEqual([...TUI_FIXTURES].sort())
    for (const name of TUI_FIXTURES) expect(Array.isArray(tuiFixture(name).tail)).toBe(true)
  })

  test('所有 fixture 目录（codex-tui、orca）都不含用户信息与疑似令牌', () => {
    // 真实的账号名与主机名在运行时拼出，避免它们以字面量出现在公开仓库里。
    const names = [['ust', 'clhx'].join(''), ['hx', 'lee'].join(''), ['hxde', 'MacBook'].join('')]
    const forbidden: RegExp[] = [
      /\/Users\/(?!user\b)[^/\s"]+/,
      /\/home\/(?!user\b)[^/\s"]+/,
      ...names.map((n) => new RegExp(n, 'i')),
      /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{8,}/,
      /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,}/,
      /\bxox[abposr]-[A-Za-z0-9-]{8,}/,
      /\b(?:AKIA|ASIA)[0-9A-Z]{12,}/,
      /\bglpat-[A-Za-z0-9_-]{8,}/,
      /\bnpm_[A-Za-z0-9]{16,}/,
      /\bAIza[0-9A-Za-z_-]{20,}/,
      /\beyJ[A-Za-z0-9_-]{8,}\.eyJ/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /actions\/runs\/(?!1000000001\b)\d+/,
    ]
    const root = join(import.meta.dir, 'fixtures')
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((f) =>
      f.endsWith('.json'),
    )
    expect(files.some((f) => f.startsWith('orca'))).toBe(true)
    expect(files.some((f) => f.startsWith('codex-tui'))).toBe(true)
    for (const f of files) {
      const text = readFileSync(join(root, f), 'utf8')
      for (const re of forbidden) {
        if (re.test(text)) throw new Error(`${f} 命中 ${re}`)
      }
    }
  })
})

describe('analyzeTail', () => {
  test('信任提示', () => {
    const a = analyzeTail(tuiFixture('trust-prompt').tail)
    expect(a.kind).toBe('trust_prompt')
  })

  test('Working：忙碌标记在末尾', () => {
    const t = tuiFixture('working').tail
    expect(isBusy(t)).toBe(true)
    expect(analyzeTail(t).kind).toBe('working')
    // 启动时加载 MCP 也带 esc to interrupt。
    expect(analyzeTail(tuiFixture('starting').tail).kind).toBe('working')
  })

  test('流式输出中途可能没有忙碌标记（所以要连续两次才算停下）', () => {
    const t = tuiFixture('streaming').tail
    expect(isBusy(t)).toBe(false)
    expect(analyzeTail(t).kind).toBe('other')
  })

  test('提问：输入框之上的最后一条消息以问号结尾', () => {
    const t = tuiFixture('question').tail
    expect(isBusy(t)).toBe(false)
    expect(lastMessage(t)).toEqual([
      '• 根目录 package.json 的 name 字段是 flow。未做任何修改。',
      '  下一步你希望我查看什么？',
    ])
    const a = analyzeTail(t)
    expect(a).toMatchObject({ kind: 'question', message: '下一步你希望我查看什么？' })
  })

  test('授权请求：说明中带上命令；"esc to cancel" 不是忙碌标记', () => {
    const t = tuiFixture('approval').tail
    expect(isBusy(t)).toBe(false)
    const a = analyzeTail(t)
    expect(a.kind).toBe('awaiting_approval')
    expect(a.command).toBe('mkdir -p /tmp/flow-tui-probe-dir2')
    expect(a.message).toContain('mkdir -p /tmp/flow-tui-probe-dir2')
  })

  test('开完 PR：最后一条消息中的 PR 链接', () => {
    const a = analyzeTail(tuiFixture('pr-opened').tail)
    expect(a).toMatchObject({
      kind: 'pr_opened',
      pr_url: 'https://github.com/example-user/flow/pull/20',
    })
  })

  test('无输出：终端已退出且没有任何行', () => {
    const t = tuiFixture('no-output')
    expect(t.status).toBe('exited')
    expect(analyzeTail(t.tail).kind).toBe('empty')
  })

  test('其他：普通的陈述、被拒绝后中断、回到 shell', () => {
    expect(analyzeTail(tuiFixture('stopped-statement').tail)).toMatchObject({
      kind: 'other',
      message: '已执行 mkdir -p /tmp/flow-tui-probe-dir，命令成功，退出码为 0。',
    })
    expect(analyzeTail(tuiFixture('approval-denied').tail).kind).toBe('other')
    const exited = analyzeTail(tuiFixture('codex-exited').tail)
    expect(exited.kind).toBe('other')
    expect(exited.message).toContain('shell 提示符')
    expect(analyzeTail(tuiFixture('shell-prompt').tail).message).toContain('shell 提示符')
  })

  test('历史中的 "Working (" 不算忙碌：只看末尾 15 行', () => {
    const t = [
      '• Working (1m 00s • esc to interrupt)',
      ...Array.from({ length: 20 }, (_, i) => `  line ${i}`),
      '• 要基于哪个分支？',
    ]
    expect(isBusy(t)).toBe(false)
    expect(analyzeTail(t).kind).toBe('question')
  })

  test('提问的关键词：没有问号也算', () => {
    expect(analyzeTail(['• 请确认是否删除旧目录']).kind).toBe('question')
    expect(analyzeTail(['• Let me know which approach you prefer.']).kind).toBe('question')
    expect(analyzeTail(['• 已完成全部修改。']).kind).toBe('other')
  })

  test('说明经过脱敏', () => {
    const token = ['ghp', 'A'.repeat(36)].join('_')
    const a = analyzeTail([`• 用这个令牌可以吗 ${token}？`])
    expect(a.kind).toBe('question')
    expect(a.message).not.toContain(token)
    expect(a.message).toContain('[REDACTED:github-token]')
  })
})

describe('对抗与顺序（PR #24 审查第 1、2、5 条）', () => {
  const trust = () => tuiFixture('trust-prompt').tail
  const approval = () => tuiFixture('approval').tail

  test('授权弹窗上方的历史输出里有信任提示文字：判为授权请求，不是信任提示', () => {
    const t = ['• Ran cat trust-prompt.json', ...trust(), ...approval().slice(-9)]
    expect(analyzeTail(t).kind).toBe('awaiting_approval')
  })

  test('授权弹窗的 Reason 里写着信任提示的文字：仍是授权请求', () => {
    const t = approval().map((l) =>
      l.startsWith('  Reason:')
        ? '  Reason: Trust this folder? Trust and continue · enter continue'
        : l,
    )
    expect(analyzeTail(t).kind).toBe('awaiting_approval')
  })

  test('对抗：不在授权规则里的未知弹窗含信任文案、最后一行是 "enter continue · esc cancel"，不判为信任提示', () => {
    const unknown = [
      '  Folder access',
      '  /tmp/scratch',
      '  Trust this folder? Codex can read, edit, and run files here.',
      '› 1. Trust and continue',
      '  2. Quit',
      '  enter continue · esc cancel',
    ]
    expect(analyzeTail(unknown).kind).not.toBe('trust_prompt')
    // 布局缺一段（没有 Folder access 标题或没有 2. Quit）也不算。
    expect(analyzeTail(trust().filter((l) => !l.includes('Folder access'))).kind).not.toBe(
      'trust_prompt',
    )
    expect(analyzeTail(trust().filter((l) => !l.includes('2. Quit'))).kind).not.toBe('trust_prompt')
    // 真实布局仍然识别。
    expect(analyzeTail(trust()).kind).toBe('trust_prompt')
  })

  test('信任提示的三段文字必须同时出现在末尾 8 行内，且最后一行是 enter continue', () => {
    expect(
      analyzeTail([...trust(), '› Ask Codex to do anything', '  ? for shortcuts']).kind,
    ).not.toBe('trust_prompt')
    expect(analyzeTail(trust().filter((l) => !l.includes('Trust and continue'))).kind).not.toBe(
      'trust_prompt',
    )
    expect(analyzeTail([...trust(), ...Array(8).fill('x'), 'enter continue']).kind).not.toBe(
      'trust_prompt',
    )
  })

  test('历史中的授权文字、底部是输入框：不是授权请求', () => {
    const t = [
      ...approval(),
      '• 已取消。还需要别的吗？',
      '› Ask Codex to do anything',
      '  ? for shortcuts',
    ]
    expect(analyzeTail(t).kind).toBe('question')
  })

  test('提问排在 PR 链接之前', () => {
    const t = [
      '• 已开 PR https://github.com/example-user/flow/pull/20，要我顺便合并吗？',
      '› Ask Codex to do anything',
    ]
    expect(analyzeTail(t).kind).toBe('question')
  })
})

describe('classifyCodexOrca', () => {
  test('授权请求 → awaiting_approval，说明包含命令', () => {
    const v = classifyCodexOrca(snapshot('approval'))
    expect(v?.reason).toBe('awaiting_approval')
    expect(v?.message).toContain('mkdir -p /tmp/flow-tui-probe-dir2')
  })

  test('提问 → question', () => {
    expect(classifyCodexOrca(snapshot('question'))).toEqual({
      reason: 'question',
      message: '下一步你希望我查看什么？',
    })
  })

  test('自动确认没生效的信任提示 → awaiting_approval', () => {
    expect(classifyCodexOrca(snapshot('trust-prompt'))?.reason).toBe('awaiting_approval')
  })

  test('其他：idle 触发时为 other，无进展触发时交给节点（null）', () => {
    expect(classifyCodexOrca(snapshot('stopped-statement'))?.reason).toBe('other')
    expect(classifyCodexOrca(snapshot('stopped-statement', 'no_progress'))).toBeNull()
    expect(classifyCodexOrca(snapshot('no-output', 'no_progress'))).toBeNull()
  })

  test('没有 hint 时用节点累积的末尾输出', () => {
    const v = classifyCodexOrca({
      trigger: 'no_progress',
      tail: tuiFixture('question').tail,
      idle_ms: 1,
      contract,
    })
    expect(v?.reason).toBe('question')
  })
})
