import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { git } from '../src/git.ts'
import { BRAIN_INDEX_MD } from '../src/templates.ts'
import { localDate } from '../src/validate.ts'
import {
  appendCapture,
  appendJournal,
  entryPath,
  localIsoTime,
  renderEntry,
  writeEntry,
} from '../src/write/api.ts'
import { commitWrite, currentHash, hashContent } from '../src/write/commit.ts'
import { formatLogLine, renderIndex } from '../src/write/render.ts'
import { commitCount, gitStatus, initTempHome, snapshot, treeContents } from './helpers.ts'

const NOW = new Date(2026, 9, 24, 14, 3, 5)
const runbook = (over: Record<string, unknown> = {}) => ({
  type: 'runbook',
  title: '回滚 Worker',
  summary: '如何回滚 web Worker',
  scope: 'work',
  sources: ['docs/runbooks/rollback.md'],
  ...over,
})

async function lastCommit(dir: string) {
  const r = await git(dir, ['log', '-1', '--format=%an <%ae>|%s'])
  return r.stdout.trim()
}

describe('renderIndex', () => {
  test('无条目时与 init 写入的占位 index 逐字节相同', () => {
    expect(renderIndex([])).toBe(BRAIN_INDEX_MD)
  })

  test('按固定类型顺序分组，组内按标识排序，输出确定', () => {
    const entries = [
      { id: 'runbooks/b', frontmatter: { type: 'runbook', title: 'B', summary: 'b 摘要' } },
      { id: 'product/x', frontmatter: { type: 'product', title: 'X', summary: 'x 摘要' } },
      { id: 'runbooks/a', frontmatter: { type: 'runbook', title: 'A [1]', summary: '多\n行' } },
      { id: 'misc/odd', frontmatter: { type: 'gadget', title: 'Odd' } },
    ]
    const out = renderIndex(entries)
    expect(out).toBe(renderIndex([...entries].reverse()))
    expect(out).toBe(
      [
        '# 索引',
        '',
        '> 由 Flow 自动生成，请勿手动编辑。',
        '',
        '## product',
        '',
        '- [X](product/x.md) — x 摘要',
        '',
        '## runbook',
        '',
        '- [A \\[1\\]](runbooks/a.md) — 多 行',
        '- [B](runbooks/b.md) — b 摘要',
        '',
        '## 其他',
        '',
        '- [Odd](misc/odd.md)',
        '',
      ].join('\n'),
    )
  })
})

describe('log 行', () => {
  test('格式为 YYYY-MM-DD <op> <actor> <简述>，简述压成单行', () => {
    expect(formatLogLine('2026-10-24', 'apply', 'user', '新增\nrunbooks/a')).toBe(
      '2026-10-24 apply user 新增 runbooks/a',
    )
  })
})

describe('统一写入', () => {
  test('brain 允许只追加日志的提交，raw 的空操作仍被拒绝', async () => {
    const home = await initTempHome()
    const brain = join(home, 'brain')
    const before = await commitCount(brain)
    const log = readFileSync(join(brain, 'log.md'), 'utf8')
    const index = readFileSync(join(brain, 'index.md'), 'utf8')
    const r = await commitWrite(
      home,
      {
        repo: 'brain',
        op: 'reject',
        summary: '拒绝提案 p',
        files: [],
      },
      { actor: 'user', now: NOW },
    )
    if (!r.ok) throw new Error(r.error.message)
    expect(r.data.files).toEqual(['brain/log.md'])
    expect(r.data.indexChanged).toBe(false)
    expect(readFileSync(join(brain, 'log.md'), 'utf8')).toBe(
      `${log}2026-10-24 reject user 拒绝提案 p\n`,
    )
    expect(readFileSync(join(brain, 'index.md'), 'utf8')).toBe(index)
    expect(await commitCount(brain)).toBe(before + 1)
    expect(await gitStatus(brain)).toBe('')
    const raw = await commitWrite(
      home,
      {
        repo: 'raw',
        op: 'reject',
        summary: '空操作',
        files: [],
      },
      { actor: 'user' },
    )
    expect(!raw.ok && raw.error.code).toBe('invalid_change')
  })

  test('新条目进入索引：一次写入恰好一次提交，index 与 log 同时更新', async () => {
    const home = await initTempHome()
    const brain = join(home, 'brain')
    const before = await commitCount(brain)
    const logBefore = readFileSync(join(brain, 'log.md'), 'utf8')
    const r = await writeEntry(
      home,
      { id: 'runbooks/rollback', frontmatter: runbook(), body: '步骤\n' },
      { actor: 'user', now: NOW },
    )
    if (!r.ok) throw new Error(r.error.message)
    expect(r.data.created).toBe(true)
    expect(r.data.indexChanged).toBe(true)
    expect(r.data.files).toEqual(['brain/runbooks/rollback.md', 'brain/index.md', 'brain/log.md'])
    expect(await commitCount(brain)).toBe(before + 1)
    expect(await lastCommit(brain)).toBe(
      'Flow (user) <flow@localhost>|apply(user): 新增 runbooks/rollback',
    )
    const index = readFileSync(join(brain, 'index.md'), 'utf8')
    expect(index).toContain(
      '## runbook\n\n- [回滚 Worker](runbooks/rollback.md) — 如何回滚 web Worker\n',
    )
    const log = readFileSync(join(brain, 'log.md'), 'utf8')
    expect(log).toBe(`${logBefore}2026-10-24 apply user 新增 runbooks/rollback\n`)
    expect(r.data.logLine).toBe('2026-10-24 apply user 新增 runbooks/rollback')
    expect(r.data.hash).toBe(hashContent(renderEntry(runbook(), '步骤\n')))
    expect(await currentHash(home, 'brain', 'runbooks/rollback.md')).toBe(r.data.hash)
    expect(await gitStatus(brain)).toBe('')
  })

  test('替换条目：log 已有行保持不变，只追加新行', async () => {
    const home = await initTempHome()
    const brain = join(home, 'brain')
    const w1 = await writeEntry(
      home,
      { id: 'runbooks/a', frontmatter: runbook() },
      { actor: 'user' },
    )
    if (!w1.ok) throw new Error(w1.error.message)
    const logBefore = readFileSync(join(brain, 'log.md'), 'utf8')
    const w2 = await writeEntry(
      home,
      { id: 'runbooks/a', frontmatter: runbook({ summary: '新摘要' }) },
      { actor: 'user', summary: '改摘要' },
    )
    if (!w2.ok) throw new Error(w2.error.message)
    expect(w2.data.created).toBe(false)
    const log = readFileSync(join(brain, 'log.md'), 'utf8')
    expect(log.startsWith(logBefore)).toBe(true)
    expect(log.slice(logBefore.length)).toMatch(/^\d{4}-\d{2}-\d{2} apply user 改摘要\n$/)
    expect(readFileSync(join(brain, 'index.md'), 'utf8')).toContain('— 新摘要')
  })

  test('journal 提交：写入当天文件，记录带时间、操作者、workspace 和正文', async () => {
    const home = await initTempHome()
    const brain = join(home, 'brain')
    const before = await commitCount(brain)
    const r = await appendJournal(
      home,
      { workspace: 'ws/product-res', text: '修好了登录页\n顺手升级依赖' },
      { actor: 'codex', now: NOW },
    )
    if (!r.ok) throw new Error(r.error.message)
    expect(r.data.file).toBe('brain/journal/2026-10-24.md')
    const r2 = await appendJournal(home, { text: '第二条' }, { actor: 'claude', now: NOW })
    if (!r2.ok) throw new Error(r2.error.message)
    expect(readFileSync(join(home, r.data.file), 'utf8')).toBe(
      [
        '# 2026-10-24',
        '',
        '## 14:03:05 · codex · ws/product-res',
        '',
        '修好了登录页',
        '顺手升级依赖',
        '',
        '## 14:03:05 · claude',
        '',
        '第二条',
        '',
      ].join('\n'),
    )
    expect(await commitCount(brain)).toBe(before + 2)
    const subjects = (await git(brain, ['log', '-2', '--format=%an|%s'])).stdout.trim().split('\n')
    expect(subjects[1]).toBe('Flow (codex)|journal(codex): ws/product-res 修好了登录页')
    const log = readFileSync(join(brain, 'log.md'), 'utf8')
    expect(log).toContain('2026-10-24 journal codex ws/product-res 修好了登录页\n')
    // journal 不是条目，不进入 index。
    expect(readFileSync(join(brain, 'index.md'), 'utf8')).toBe(BRAIN_INDEX_MD)
  })

  test('journal 的 workspace 必须已定义，正文不能为空', async () => {
    const home = await initTempHome()
    const r1 = await appendJournal(home, { workspace: 'ws/nope', text: 'x' }, { actor: 'codex' })
    expect(!r1.ok && r1.error.code).toBe('unknown_workspace')
    const r2 = await appendJournal(home, { text: '  \n' }, { actor: 'codex' })
    expect(!r2.ok && r2.error.code).toBe('empty_text')
  })

  test('用户随手记：raw/inbox 新增带元数据的文件，brain 没有任何变化', async () => {
    const home = await initTempHome()
    const brain = join(home, 'brain')
    const raw = join(home, 'raw')
    const brainBefore = snapshot(brain)
    const brainCommits = await commitCount(brain)
    const rawCommits = await commitCount(raw)
    const r = await appendCapture(
      home,
      { text: '考虑给东方站加日语', source: 'cli' },
      { actor: 'user', now: NOW },
    )
    if (!r.ok) throw new Error(r.error.message)
    expect(r.data.file).toMatch(/^raw\/inbox\/2026-10-24T140305-[0-9a-f]{6}\.md$/)
    expect(r.data.logLine).toBeNull()
    expect(readFileSync(join(home, r.data.file), 'utf8')).toBe(
      renderEntry(
        { captured_at: localIsoTime(NOW), actor: 'user', source: 'cli' },
        '考虑给东方站加日语\n',
      ),
    )
    expect(snapshot(brain)).toEqual(brainBefore)
    expect(await commitCount(brain)).toBe(brainCommits)
    expect(await commitCount(raw)).toBe(rawCommits + 1)
    expect(await lastCommit(raw)).toBe(
      'Flow (user) <flow@localhost>|capture(user): 考虑给东方站加日语',
    )
    expect(readdirSync(join(raw, 'inbox'))).toHaveLength(1)
  })

  test('校验不通过：拒绝写入，不留文件、不产生提交', async () => {
    const home = await initTempHome()
    const brain = join(home, 'brain')
    const before = snapshot(brain)
    const commits = await commitCount(brain)
    const r = await writeEntry(
      home,
      { id: 'runbooks/bad', frontmatter: runbook({ summary: undefined }) },
      { actor: 'user' },
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.code).toBe('validation_failed')
    expect(r.error.message).toContain('summary')
    expect(snapshot(brain)).toEqual(before)
    expect(await commitCount(brain)).toBe(commits)
  })

  test('资源 owner 必须是已定义的 workspace（与 kb validate 同一套规则）', async () => {
    const home = await initTempHome()
    const domain = {
      type: 'domain',
      title: 'arcanumber.com',
      summary: '西方站域名',
      scope: 'work',
      owner: 'ws/nope',
      registrar: null,
      expires: null,
      sources: ['apps/web/wrangler.jsonc'],
    }
    const r = await writeEntry(
      home,
      { id: 'resources/domains/arcanumber.com', frontmatter: domain },
      { actor: 'user' },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('validation_failed')
      expect((r.error.details as { issues: { code: string }[] }).issues[0]?.code).toBe(
        'unknown_owner',
      )
    }
    const ok2 = await writeEntry(
      home,
      {
        id: 'resources/domains/arcanumber.com',
        frontmatter: { ...domain, owner: 'ws/xuanxue-saas' },
      },
      { actor: 'user' },
    )
    expect(ok2.ok).toBe(true)
  })

  test('提交失败时回滚：文件、index、log 恢复原样，新建的目录被移除，暂存区干净', async () => {
    const home = await initTempHome()
    const brain = join(home, 'brain')
    const hook = join(brain, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\necho blocked >&2\nexit 1\n')
    chmodSync(hook, 0o755)
    const before = treeContents(brain)
    const commits = await commitCount(brain)
    const r = await writeEntry(
      home,
      { id: 'runbooks/deep/new', frontmatter: runbook() },
      { actor: 'user' },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('git_commit_failed')
    expect(treeContents(brain)).toEqual(before)
    expect(existsSync(join(brain, 'runbooks'))).toBe(false)
    expect(await commitCount(brain)).toBe(commits)
    expect(await gitStatus(brain)).toBe('')
  })

  test('提交失败时替换操作也恢复原内容', async () => {
    const home = await initTempHome()
    const brain = join(home, 'brain')
    const w = await writeEntry(
      home,
      { id: 'runbooks/a', frontmatter: runbook() },
      { actor: 'user' },
    )
    if (!w.ok) throw new Error(w.error.message)
    const hook = join(brain, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\nexit 1\n')
    chmodSync(hook, 0o755)
    const before = treeContents(brain)
    const r = await writeEntry(
      home,
      { id: 'runbooks/a', frontmatter: runbook({ summary: '改了' }) },
      { actor: 'user' },
    )
    expect(r.ok).toBe(false)
    expect(treeContents(brain)).toEqual(before)
    expect(await gitStatus(brain)).toBe('')
  })

  test('expectedBaseHash：一致时写入，不一致或存在性不符时报告冲突', async () => {
    const home = await initTempHome()
    const id = 'runbooks/a'
    const created = await writeEntry(
      home,
      { id, frontmatter: runbook() },
      { actor: 'user', expectedBaseHash: null },
    )
    if (!created.ok) throw new Error(created.error.message)
    const base = created.data.hash

    const again = await writeEntry(
      home,
      { id, frontmatter: runbook() },
      { actor: 'user', expectedBaseHash: null },
    )
    expect(!again.ok && again.error.code).toBe('base_conflict')

    // 用户在提案创建之后改动了目标条目。
    const edited = await writeEntry(
      home,
      { id, frontmatter: runbook({ summary: '用户改过' }) },
      { actor: 'user' },
    )
    if (!edited.ok) throw new Error(edited.error.message)
    const commits = await commitCount(join(home, 'brain'))
    const stale = await writeEntry(
      home,
      { id, frontmatter: runbook({ summary: '提案内容' }) },
      { actor: 'user', expectedBaseHash: base, op: 'apply' },
    )
    expect(stale.ok).toBe(false)
    if (!stale.ok) {
      expect(stale.error.code).toBe('base_conflict')
      expect(stale.error.details).toMatchObject({ expected: base, actual: edited.data.hash })
    }
    expect(await commitCount(join(home, 'brain'))).toBe(commits)

    const fresh = await writeEntry(
      home,
      { id, frontmatter: runbook({ summary: '提案内容' }) },
      { actor: 'user', expectedBaseHash: edited.data.hash },
    )
    expect(fresh.ok).toBe(true)

    const missing = await writeEntry(
      home,
      { id: 'runbooks/gone', frontmatter: runbook() },
      { actor: 'user', expectedBaseHash: base },
    )
    expect(!missing.ok && missing.error.code).toBe('base_conflict')
  })

  test('commitWrite：一次多文件操作仍只有一次提交；删除条目会从 index 移除', async () => {
    const home = await initTempHome()
    const brain = join(home, 'brain')
    const commits = await commitCount(brain)
    const r = await commitWrite(
      home,
      {
        repo: 'brain',
        op: 'apply',
        summary: '批量新增',
        files: [
          { op: 'create', path: 'runbooks/a.md', content: renderEntry(runbook({ title: 'A' })) },
          { op: 'create', path: 'runbooks/b.md', content: renderEntry(runbook({ title: 'B' })) },
        ],
      },
      { actor: 'user' },
    )
    if (!r.ok) throw new Error(r.error.message)
    expect(await commitCount(brain)).toBe(commits + 1)
    const del = await commitWrite(
      home,
      {
        repo: 'brain',
        op: 'apply',
        summary: '删除 a',
        files: [{ op: 'delete', path: 'runbooks/a.md' }],
      },
      { actor: 'user' },
    )
    if (!del.ok) throw new Error(del.error.message)
    const index = readFileSync(join(brain, 'index.md'), 'utf8')
    expect(index).not.toContain('runbooks/a.md')
    expect(index).toContain('runbooks/b.md')
    expect(await gitStatus(brain)).toBe('')
    expect((await git(brain, ['ls-files', 'runbooks'])).stdout.trim()).toBe('runbooks/b.md')
  })

  test('参数错误：非法操作者、空操作、重复路径、非法条目标识', async () => {
    const home = await initTempHome()
    const base = { repo: 'brain' as const, op: 'apply' as const, summary: 's' }
    const badActor = await commitWrite(
      home,
      { ...base, files: [{ op: 'create', path: 'a.md', content: '' }] },
      { actor: 'bad actor' },
    )
    expect(!badActor.ok && badActor.error.code).toBe('invalid_actor')
    const empty = await commitWrite(home, { ...base, repo: 'raw', files: [] }, { actor: 'user' })
    expect(!empty.ok && empty.error.code).toBe('invalid_change')
    const dup = await commitWrite(
      home,
      {
        ...base,
        files: [
          { op: 'delete', path: 'a.md' },
          { op: 'delete', path: 'a.md' },
        ],
      },
      { actor: 'user' },
    )
    expect(!dup.ok && dup.error.code).toBe('invalid_change')
    for (const id of ['../x', 'journal/2026-10-24', 'index', 'a/.hidden', 'x.md']) {
      const p = entryPath(id)
      expect(!p.ok && p.error.code).toBe('invalid_entry_id')
    }
  })

  test('未初始化的 flow-home 返回 not_initialized', async () => {
    const r = await appendJournal('/nonexistent/flow-home', { text: 'x' }, { actor: 'user' })
    expect(!r.ok && r.error.code).toBe('not_initialized')
  })

  test('log 日期使用写入时间的本地日期', async () => {
    const home = await initTempHome()
    const r = await appendJournal(home, { text: 'x' }, { actor: 'user' })
    if (!r.ok) throw new Error(r.error.message)
    expect(r.data.logLine?.startsWith(`${localDate()} journal user`)).toBe(true)
  })
})
