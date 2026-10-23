import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { execCommand, git } from '../src/git.ts'
import { kbProposeOp } from '../src/ops/proposals.ts'
import {
  acceptProposals,
  createProposal,
  diffProposal,
  listProposals,
  proposalSchema,
  rejectProposals,
} from '../src/proposals/index.ts'
import type { Result } from '../src/result.ts'
import { renderEntry, writeEntry } from '../src/write/api.ts'
import { hashContent } from '../src/write/commit.ts'
import { commitCount, fakeStripeKey, initTempHome, snapshot, writeText } from './helpers.ts'

const homes: string[] = []
setDefaultTimeout(20_000)
async function home() {
  const h = await initTempHome('flow-proposals-')
  homes.push(h)
  return h
}
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(join(h, '..'), { recursive: true, force: true })
})

function data<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.data
}
const domain = (over: Record<string, unknown> = {}) => ({
  type: 'domain',
  title: 'ganjiday.com',
  summary: '东方站域名',
  scope: 'work',
  owner: 'ws/xuanxue-saas',
  registrar: null,
  expires: null,
  sources: ['repo:wrangler.jsonc'],
  ...over,
})
const propose = (h: string, target: string, over: Record<string, unknown> = {}) =>
  createProposal(
    h,
    {
      target,
      content: renderEntry(domain(over), '条目正文\n'),
      reason: '核实注册商',
    },
    { actor: 'claude' },
  )
const archive = (h: string, kind: string, id: string) =>
  JSON.parse(readFileSync(join(h, 'state/proposals', kind, `${id}.json`), 'utf8'))

describe('修改提案', () => {
  test('agent 修改域名：立即校验、记录 base_hash 和出处，brain 及 git 历史不变', async () => {
    const h = await home()
    const id = 'resources/domains/ganjiday.com'
    data(await writeEntry(h, { id, frontmatter: domain() }, { actor: 'user' }))
    const before = snapshot(join(h, 'brain'))
    const content = readFileSync(join(h, 'brain', `${id}.md`), 'utf8')
    const p = data(await propose(h, id, { registrar: 'cloudflare' }))
    expect(p.base_hash).toBe(hashContent(content))
    expect(snapshot(join(h, 'brain'))).toEqual(before)
    const stored = proposalSchema.parse(
      JSON.parse(readFileSync(join(h, 'state/proposals', `${p.id}.json`), 'utf8')),
    )
    expect(stored.actor).toBe('claude')
    expect(stored.sources).toEqual(['repo:wrangler.jsonc'])
    expect(stored.content).toContain('registrar: cloudflare')
  })

  test('非法 frontmatter 在提交时返回 validation_failed', async () => {
    const h = await home()
    for (const content of [
      '无 frontmatter',
      renderEntry(domain({ summary: undefined })),
      renderEntry(domain({ owner: 'ws/unknown' })),
    ]) {
      const r = await createProposal(
        h,
        { target: 'domains/a', content, reason: 'r' },
        { actor: 'codex' },
      )
      expect(!r.ok && r.error.code).toBe('validation_failed')
    }
    expect(data(await listProposals(h)).proposals).toEqual([])
  })

  test('AI 缺少出处的事实提案被拒绝，project-card 也要求出处', async () => {
    const h = await home()
    for (const fm of [
      domain({ sources: [] }),
      {
        type: 'project-card',
        title: 'p',
        summary: 's',
        scope: 'work',
        workspace: 'ws/product-res',
        repo_paths: [],
      },
    ]) {
      const r = await createProposal(
        h,
        { target: 'a', content: renderEntry(fm), reason: 'r' },
        { actor: 'codex' },
      )
      expect(!r.ok && r.error.code).toBe('sources_required')
      expect(!r.ok && r.error.message).toContain('事实类条目需要出处')
    }
  })

  test('decision、personal、journal、index、log 不允许提案，也不能伪装既有受限条目', async () => {
    const h = await home()
    for (const fm of [domain({ type: 'decision' }), domain({ scope: 'personal' })]) {
      const r = await createProposal(
        h,
        { target: 'a', content: renderEntry(fm), reason: 'r' },
        { actor: 'user' },
      )
      expect(!r.ok && r.error.code).toBe('proposal_forbidden')
    }
    for (const id of ['journal/2026-10-24', 'index', 'log', 'AGENTS', '../escape']) {
      expect((await propose(h, id)).ok).toBe(false)
    }
    data(
      await writeEntry(
        h,
        {
          id: 'private/a',
          frontmatter: { type: 'note', title: '私有', summary: 's', scope: 'personal' },
        },
        { actor: 'user' },
      ),
    )
    expect((await propose(h, 'private/a')).ok).toBe(false)
  })

  test('从本地文件新建提案；content 和 file 严格二选一', async () => {
    const h = await home()
    const file = join(h, 'draft.md')
    writeText(file, renderEntry(domain()))
    const p = data(
      await createProposal(h, { target: 'domains/a', file, reason: '新增' }, { actor: 'codex' }),
    )
    expect(p.base_hash).toBeNull()
    expect(data(await listProposals(h)).proposals).toEqual([
      expect.objectContaining({
        id: p.id,
        target: 'domains/a',
        actor: 'codex',
        reason: '新增',
        is_new: true,
      }),
    ])
    for (const input of [
      { target: 'b', reason: 'r' },
      { target: 'b', reason: 'r', file, content: 'x' },
    ]) {
      expect(kbProposeOp.input.safeParse(input).success).toBe(false)
      const r = await createProposal(h, input, { actor: 'user' })
      expect(!r.ok && r.error.kind).toBe('usage')
    }
  })

  test('统一 diff 比较当前内容，并支持新建条目', async () => {
    const h = await home()
    const id = 'domains/a'
    data(await writeEntry(h, { id, frontmatter: domain() }, { actor: 'user' }))
    const p = data(
      await createProposal(
        h,
        {
          target: id,
          content: renderEntry(
            domain({ registrar: 'cloudflare' }),
            '引用 a/current 和 b/proposed\n',
          ),
          reason: '核实注册商',
        },
        { actor: 'claude' },
      ),
    )
    const diff = data(await diffProposal(h, p.id)).diff
    expect(diff).toContain('--- a/domains/a.md')
    expect(diff).toContain('+++ b/domains/a.md')
    expect(diff).toContain('-registrar: null')
    expect(diff).toContain('+registrar: cloudflare')
    expect(diff).toContain('+引用 a/current 和 b/proposed')
    const fresh = data(await propose(h, 'domains/new'))
    expect(data(await diffProposal(h, fresh.id)).diff).toContain('+type: domain')
  })

  test('提案落盘前扫描完整内容和理由，密钥错误不回显原文', async () => {
    const h = await home()
    const secret = fakeStripeKey()
    const r = await createProposal(
      h,
      { target: 'a', content: renderEntry(domain(), secret), reason: 'r' },
      { actor: 'codex' },
    )
    expect(!r.ok && r.error.code).toBe('secret_detected')
    expect(JSON.stringify(r)).not.toContain(secret)
    expect(data(await listProposals(h)).proposals).toEqual([])
  })

  test('两个进程几乎同时提交，两个提案都完整保存', async () => {
    const h = await home()
    const fixture = join(import.meta.dir, 'fixtures/proposal-writer.ts')
    const runs = await Promise.all(
      ['a', 'b'].map((id) =>
        execCommand(process.execPath, [fixture, h, id], { env: { ...process.env, FLOW_HOME: h } }),
      ),
    )
    for (const r of runs) expect(r.code).toBe(0)
    const pending = data(await listProposals(h)).proposals
    expect(pending.map((p) => p.target).sort()).toEqual(['notes/a', 'notes/b'])
    for (const p of pending)
      expect(
        proposalSchema.parse(
          JSON.parse(readFileSync(join(h, 'state/proposals', `${p.id}.json`), 'utf8')),
        ).content,
      ).toContain(p.target)
  })
})

describe('提案确认', () => {
  test('批量接受：每份提案一次 apply 提交，日志旧行不变、索引更新并保留 accepted 归档', async () => {
    const h = await home()
    const brain = join(h, 'brain')
    const p1 = data(await propose(h, 'domains/a'))
    const p2 = data(await propose(h, 'domains/b'))
    const log = readFileSync(join(brain, 'log.md'), 'utf8')
    const count = await commitCount(brain)
    expect(data(await acceptProposals(h, { all: true }, { actor: 'user' })).results).toEqual([
      { id: p1.id, status: 'accepted' },
      { id: p2.id, status: 'accepted' },
    ])
    expect(await commitCount(brain)).toBe(count + 2)
    const added = readFileSync(join(brain, 'log.md'), 'utf8').slice(log.length).trim().split('\n')
    expect(readFileSync(join(brain, 'log.md'), 'utf8').startsWith(log)).toBe(true)
    expect(added).toHaveLength(2)
    for (const p of [p1, p2]) {
      expect(added.find((l) => l.includes(p.id))).toMatch(/^\d{4}-\d{2}-\d{2} apply user .*claude/)
      expect(readFileSync(join(brain, 'index.md'), 'utf8')).toContain(`${p.target}.md`)
      expect(archive(h, 'accepted', p.id).accepted_at).toBeString()
    }
    expect((await git(brain, ['log', '-1', '--format=%an'])).stdout.trim()).toBe('Flow (user)')
    expect(data(await listProposals(h)).proposals).toEqual([])
  })

  test('目标已被改动：保留冲突提案并提示重新生成；一个失败不妨碍后续合入', async () => {
    const h = await home()
    data(await writeEntry(h, { id: 'domains/a', frontmatter: domain() }, { actor: 'user' }))
    const conflicting = data(await propose(h, 'domains/a'))
    data(
      await writeEntry(
        h,
        { id: 'domains/a', frontmatter: domain({ summary: '用户的新事实' }) },
        { actor: 'user' },
      ),
    )
    const valid = data(await propose(h, 'domains/b'))
    const r = data(
      await acceptProposals(h, { ids: [conflicting.id, 'invalid', valid.id] }, { actor: 'user' }),
    )
    expect(r.results.map((r) => r.status)).toEqual(['conflict', 'error', 'accepted'])
    expect(r.results[0]?.error?.code).toBe('base_conflict')
    expect(r.results[0]?.error?.message).toContain('重新生成')
    expect(data(await listProposals(h)).proposals.map((p) => p.id)).toEqual([conflicting.id])
    expect(readFileSync(join(h, 'brain/domains/a.md'), 'utf8')).toContain('用户的新事实')
  })

  test('新建提案之后目标出现，也报告冲突', async () => {
    const h = await home()
    const p = data(await propose(h, 'domains/a'))
    data(await writeEntry(h, { id: 'domains/a', frontmatter: domain() }, { actor: 'user' }))
    expect(
      data(await acceptProposals(h, { ids: [p.id] }, { actor: 'user' })).results[0]?.status,
    ).toBe('conflict')
  })

  test('批量拒绝：归档拒绝理由和原提议理由，每个提案只追加一条 reject 日志', async () => {
    const h = await home()
    const p1 = data(await propose(h, 'domains/a'))
    const p2 = data(await propose(h, 'domains/b'))
    const log = readFileSync(join(h, 'brain/log.md'), 'utf8')
    expect(
      data(
        await rejectProposals(h, { all: true, reason: '出处不足' }, { actor: 'user' }),
      ).results.map((r) => r.status),
    ).toEqual(['rejected', 'rejected'])
    for (const p of [p1, p2]) {
      expect(archive(h, 'rejected', p.id)).toMatchObject({
        reason: '出处不足',
        proposal_reason: '核实注册商',
      })
      expect(archive(h, 'rejected', p.id).rejected_at).toBeString()
      expect(existsSync(join(h, 'brain', `${p.target}.md`))).toBe(false)
    }
    const after = readFileSync(join(h, 'brain/log.md'), 'utf8')
    expect(after.startsWith(log)).toBe(true)
    expect(after.slice(log.length).trim().split('\n')).toHaveLength(2)
    expect(after.slice(log.length)).toContain(' reject user ')
    expect(after.slice(log.length)).toContain('出处不足')
    expect(data(await listProposals(h)).proposals).toEqual([])
  })

  test('AI 调用 accept、reject 均返回 user_only，不改变待确认状态', async () => {
    const h = await home()
    const p = data(await propose(h, 'domains/a'))
    const before = snapshot(join(h, 'brain'))
    for (const action of [acceptProposals, rejectProposals]) {
      const r = await action(h, { all: true }, { actor: 'codex' })
      expect(!r.ok && r.error.code).toBe('user_only')
    }
    expect(data(await listProposals(h)).proposals[0]?.id).toBe(p.id)
    expect(snapshot(join(h, 'brain'))).toEqual(before)
  })
})
