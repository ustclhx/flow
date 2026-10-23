import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { git } from '../src/git.ts'
import { appendCapture, appendJournal, renderEntry, writeEntry } from '../src/write/api.ts'
import { commitWrite } from '../src/write/commit.ts'
import { isAiActor } from '../src/write/policy.ts'
import { commitCount, initTempHome, treeContents } from './helpers.ts'

const decision = {
  type: 'decision',
  title: '东方站加日语',
  summary: '是否为东方站上线日语版',
  scope: 'work',
  status: 'proposed',
  expected_outcome: '日本流量提升',
  metric: '日本地区月访问量',
  review_date: '2027-01-24',
}
const runbook = (over: Record<string, unknown> = {}) => ({
  type: 'runbook',
  title: '回滚 Worker',
  summary: '如何回滚 web Worker',
  scope: 'work',
  sources: ['docs/runbooks/rollback.md'],
  ...over,
})
const note = (over: Record<string, unknown> = {}) => ({
  type: 'note',
  title: '想法',
  summary: '一条笔记',
  scope: 'work',
  ...over,
})
const domain = (over: Record<string, unknown> = {}) => ({
  type: 'domain',
  title: 'ganjiday.com',
  summary: '东方站域名',
  scope: 'work',
  owner: 'ws/xuanxue-saas',
  registrar: null,
  expires: null,
  ...over,
})

/** 断言写入被拒绝，且 brain 内容与提交数都没有变化。 */
async function expectRejected(
  home: string,
  run: () => Promise<{ ok: boolean; error?: { code: string; message: string } }>,
  code: string,
  message?: string,
) {
  const brain = join(home, 'brain')
  const before = treeContents(brain)
  const commits = await commitCount(brain)
  const r = await run()
  expect(r.ok).toBe(false)
  expect(r.error?.code).toBe(code)
  if (message) expect(r.error?.message).toContain(message)
  expect(treeContents(brain)).toEqual(before)
  expect(await commitCount(brain)).toBe(commits)
}

describe('AI 写入边界', () => {
  test('actor 不是 user 即视为 AI', () => {
    expect(isAiActor('user')).toBe(false)
    expect(isAiActor('codex')).toBe(true)
    expect(isAiActor('claude')).toBe(true)
  })

  test('AI 试图改决策：被拒绝，并返回"决策条目只能由用户写入"', async () => {
    const home = await initTempHome()
    await expectRejected(
      home,
      () => writeEntry(home, { id: 'decisions/jp', frontmatter: decision }, { actor: 'codex' }),
      'ai_forbidden_decision',
      '决策条目只能由用户写入',
    )
  })

  test('AI 不能把已有决策条目改成别的类型，也不能删除它', async () => {
    const home = await initTempHome()
    const w = await writeEntry(
      home,
      { id: 'decisions/jp', frontmatter: decision },
      { actor: 'user' },
    )
    if (!w.ok) throw new Error(w.error.message)
    await expectRejected(
      home,
      () => writeEntry(home, { id: 'decisions/jp', frontmatter: note() }, { actor: 'claude' }),
      'ai_forbidden_decision',
      '决策条目只能由用户写入',
    )
    await expectRejected(
      home,
      () =>
        commitWrite(
          home,
          {
            repo: 'brain',
            op: 'apply',
            summary: '删除',
            files: [{ op: 'delete', path: 'decisions/jp.md' }],
          },
          { actor: 'claude' },
        ),
      'ai_forbidden_decision',
    )
  })

  test('用户可以写决策条目', async () => {
    const home = await initTempHome()
    const r = await writeEntry(
      home,
      { id: 'decisions/jp', frontmatter: decision },
      { actor: 'user' },
    )
    expect(r.ok).toBe(true)
  })

  test('AI 不能写 personal 条目，也不能改动已有的 personal 条目', async () => {
    const home = await initTempHome()
    await expectRejected(
      home,
      () =>
        writeEntry(
          home,
          { id: 'notes/private', frontmatter: note({ scope: 'personal' }) },
          { actor: 'codex' },
        ),
      'ai_forbidden_personal',
      '只能由用户写入',
    )
    const w = await writeEntry(
      home,
      { id: 'notes/private', frontmatter: note({ scope: 'personal' }) },
      { actor: 'user' },
    )
    if (!w.ok) throw new Error(w.error.message)
    await expectRejected(
      home,
      () => writeEntry(home, { id: 'notes/private', frontmatter: note() }, { actor: 'codex' }),
      'ai_forbidden_personal',
    )
  })

  test('AI 带出处更新 runbook：直接写入并提交，log 中记录该操作', async () => {
    const home = await initTempHome()
    const brain = join(home, 'brain')
    const w = await writeEntry(
      home,
      { id: 'runbooks/rollback', frontmatter: runbook() },
      { actor: 'user' },
    )
    if (!w.ok) throw new Error(w.error.message)
    const commits = await commitCount(brain)
    const r = await writeEntry(
      home,
      { id: 'runbooks/rollback', frontmatter: runbook({ summary: '补充了 jobs Worker 的步骤' }) },
      { actor: 'claude' },
    )
    if (!r.ok) throw new Error(r.error.message)
    expect(await commitCount(brain)).toBe(commits + 1)
    const head = (await git(brain, ['log', '-1', '--format=%an|%s'])).stdout.trim()
    expect(head).toBe('Flow (claude)|apply(claude): 更新 runbooks/rollback')
    const log = readFileSync(join(brain, 'log.md'), 'utf8').trimEnd().split('\n')
    expect(log.at(-1)).toMatch(/^\d{4}-\d{2}-\d{2} apply claude 更新 runbooks\/rollback$/)
    expect(readFileSync(join(brain, 'runbooks/rollback.md'), 'utf8')).toContain('jobs Worker')
  })

  test('AI 写 runbook 不附出处：被拒绝，返回"事实类条目需要出处"', async () => {
    const home = await initTempHome()
    for (const sources of [undefined, [], ['  ']]) {
      await expectRejected(
        home,
        () =>
          writeEntry(
            home,
            { id: 'runbooks/rollback', frontmatter: runbook({ sources }) },
            { actor: 'claude' },
          ),
        'sources_required',
        '事实类条目需要出处',
      )
    }
  })

  test('AI 写其他事实类条目（domain）同样必须有出处', async () => {
    const home = await initTempHome()
    await expectRejected(
      home,
      () =>
        writeEntry(
          home,
          { id: 'resources/domains/ganjiday.com', frontmatter: domain() },
          { actor: 'claude' },
        ),
      'sources_required',
      '事实类条目需要出处',
    )
    const ok = await writeEntry(
      home,
      {
        id: 'resources/domains/ganjiday.com',
        frontmatter: domain({ sources: ['apps/web/wrangler.jsonc'] }),
      },
      { actor: 'claude' },
    )
    expect(ok.ok).toBe(true)
  })

  test('用户手写事实条目不附出处可以写入（只在 kb validate 中警告）', async () => {
    const home = await initTempHome()
    const r = await writeEntry(
      home,
      { id: 'runbooks/rollback', frontmatter: runbook({ sources: undefined }) },
      { actor: 'user' },
    )
    expect(r.ok).toBe(true)
  })

  test('AI 写 note 不需要出处', async () => {
    const home = await initTempHome()
    const r = await writeEntry(home, { id: 'notes/idea', frontmatter: note() }, { actor: 'codex' })
    expect(r.ok).toBe(true)
  })

  test('任何人都不能直接改写 log.md 或 index.md', async () => {
    const home = await initTempHome()
    for (const actor of ['user', 'codex']) {
      await expectRejected(
        home,
        () =>
          commitWrite(
            home,
            {
              repo: 'brain',
              op: 'apply',
              summary: 'x',
              files: [{ op: 'replace', path: 'log.md', content: '' }],
            },
            { actor },
          ),
        'log_append_only',
        '已有行不得修改',
      )
      await expectRejected(
        home,
        () =>
          commitWrite(
            home,
            {
              repo: 'brain',
              op: 'apply',
              summary: 'x',
              files: [{ op: 'append', path: 'log.md', content: 'x' }],
            },
            { actor },
          ),
        'log_append_only',
      )
      await expectRejected(
        home,
        () =>
          commitWrite(
            home,
            {
              repo: 'brain',
              op: 'apply',
              summary: 'x',
              files: [{ op: 'replace', path: 'index.md', content: '' }],
            },
            { actor },
          ),
        'index_generated',
      )
    }
  })

  test('任何人都不能修改或删除 raw 中已有的文件，只能新增', async () => {
    const home = await initTempHome()
    const c = await appendCapture(home, { text: '原始资料', source: 'cli' }, { actor: 'user' })
    if (!c.ok) throw new Error(c.error.message)
    const path = c.data.file.replace(/^raw\//, '')
    const raw = join(home, 'raw')
    const before = treeContents(raw)
    const rawCommits = await commitCount(raw)
    for (const actor of ['user', 'claude']) {
      for (const files of [
        [{ op: 'replace' as const, path, content: '改写' }],
        [{ op: 'append' as const, path, content: '追加' }],
        [{ op: 'delete' as const, path }],
        [{ op: 'create' as const, path, content: '覆盖' }],
      ]) {
        const r = await commitWrite(
          home,
          { repo: 'raw', op: 'capture', summary: 'x', files },
          { actor },
        )
        expect(r.ok).toBe(false)
        if (!r.ok) {
          expect(r.error.code).toBe(files[0]?.op === 'create' ? 'already_exists' : 'raw_immutable')
        }
      }
    }
    expect(treeContents(raw)).toEqual(before)
    expect(await commitCount(raw)).toBe(rawCommits)
  })

  test('AI 只能追加 journal，不能改写或删除', async () => {
    const home = await initTempHome()
    const j = await appendJournal(home, { text: '第一条' }, { actor: 'codex' })
    if (!j.ok) throw new Error(j.error.message)
    const path = j.data.file.replace(/^brain\//, '')
    await expectRejected(
      home,
      () =>
        commitWrite(
          home,
          {
            repo: 'brain',
            op: 'journal',
            summary: 'x',
            files: [{ op: 'replace', path, content: '' }],
          },
          { actor: 'codex' },
        ),
      'journal_append_only',
    )
    await expectRejected(
      home,
      () =>
        commitWrite(
          home,
          { repo: 'brain', op: 'journal', summary: 'x', files: [{ op: 'delete', path }] },
          { actor: 'codex' },
        ),
      'journal_append_only',
    )
  })

  test('AI 不能修改 brain/AGENTS.md', async () => {
    const home = await initTempHome()
    await expectRejected(
      home,
      () =>
        commitWrite(
          home,
          {
            repo: 'brain',
            op: 'sync',
            summary: 'x',
            files: [{ op: 'replace', path: 'AGENTS.md', content: 'x' }],
          },
          { actor: 'claude' },
        ),
      'ai_forbidden_file',
    )
  })

  test('路径不能越界、不能写隐藏文件，条目不能追加', async () => {
    const home = await initTempHome()
    for (const path of [
      '../config/x.md',
      '/etc/x.md',
      '.gitleaks.toml',
      'a/.git/x.md',
      'a//b.md',
    ]) {
      await expectRejected(
        home,
        () =>
          commitWrite(
            home,
            {
              repo: 'brain',
              op: 'apply',
              summary: 'x',
              files: [{ op: 'create', path, content: 'x' }],
            },
            { actor: 'user' },
          ),
        'invalid_path',
      )
    }
    await expectRejected(
      home,
      () =>
        commitWrite(
          home,
          {
            repo: 'brain',
            op: 'apply',
            summary: 'x',
            files: [{ op: 'append', path: 'notes/a.md', content: renderEntry(note()) }],
          },
          { actor: 'user' },
        ),
      'invalid_op',
    )
    expect(existsSync(join(home, 'config', 'x.md'))).toBe(false)
  })
})
