import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { readBrainEntries } from '../src/entries.ts'
import { git } from '../src/git.ts'
import { briefUpdateOp } from '../src/ops/brief.ts'
import { kbProposeOp } from '../src/ops/proposals.ts'
import { kbSearchOp } from '../src/ops/search.ts'
import type { Result } from '../src/result.ts'
import { validateBrain } from '../src/validate.ts'
import { writeEntry } from '../src/write/api.ts'
import { BRIEF_MAX_CHARS, briefHash, briefPath, readBrief, writeBrief } from '../src/write/brief.ts'
import { commitWrite } from '../src/write/commit.ts'
import { classifyBrainPath } from '../src/write/policy.ts'
import { commitCount, fakeStripeKey, initTempHome, snapshot } from './helpers.ts'

const homes: string[] = []
async function home() {
  const h = await initTempHome('flow-brief-')
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
const code = (r: Result<unknown>) => (r.ok ? 'ok' : r.error.code)
const WS = 'ws/product-res'
const EMPTY = briefHash(null)
const notePath = (h: string) => join(h, 'brain', 'briefs', 'product-res.md')

describe('简报笔记路径（design D8）', () => {
  test('briefs/<id>.md 是独立路径类别，<id> 不含 ws/ 前缀', () => {
    expect(data(briefPath(WS))).toBe('briefs/product-res.md')
    expect(code(briefPath('product-res'))).toBe('invalid_workspace')
    expect(classifyBrainPath('briefs/product-res.md')).toBe('brief')
    expect(code(classifyBrainPath('briefs/a/b.md') as Result<never>)).toBe('invalid_path')
    expect(code(classifyBrainPath('briefs/Upper.md') as Result<never>)).toBe('invalid_path')
  })

  test('supervisor 经 writeBrief 写入：提交、log 行，作者为 supervisor', async () => {
    const h = await home()
    const before = await commitCount(join(h, 'brain'))
    const r = data(
      await writeBrief(
        h,
        { workspace: WS, text: '当前在做 README 修复', base_hash: EMPTY },
        {
          actor: 'supervisor',
        },
      ),
    )
    expect(r.changed).toBe(true)
    expect(r.file).toBe('brain/briefs/product-res.md')
    expect(readFileSync(notePath(h), 'utf8')).toBe('当前在做 README 修复\n')
    expect(r.hash).toBe(briefHash('当前在做 README 修复\n'))
    expect(await commitCount(join(h, 'brain'))).toBe(before + 1)
    const log = readFileSync(join(h, 'brain', 'log.md'), 'utf8')
    expect(log).toContain('brief supervisor ws/product-res 简报笔记')
    const author = await git(join(h, 'brain'), ['log', '-1', '--format=%an'])
    expect(author.stdout.trim()).toBe('Flow (supervisor)')
    const note = data(await readBrief(h, WS))
    expect(note).toEqual({
      workspace: WS,
      text: '当前在做 README 修复\n',
      hash: r.hash,
      exists: true,
    })
  })

  test('整体替换；内容不变时不产生提交', async () => {
    const h = await home()
    const first = data(
      await writeBrief(h, { workspace: WS, text: 'v1', base_hash: EMPTY }, { actor: 'user' }),
    )
    const second = data(
      await writeBrief(h, { workspace: WS, text: 'v2', base_hash: first.hash }, { actor: 'user' }),
    )
    expect(readFileSync(notePath(h), 'utf8')).toBe('v2\n')
    const count = await commitCount(join(h, 'brain'))
    const same = data(
      await writeBrief(h, { workspace: WS, text: 'v2', base_hash: second.hash }, { actor: 'user' }),
    )
    expect(same).toMatchObject({ changed: false, sha: null, hash: second.hash })
    expect(await commitCount(join(h, 'brain'))).toBe(count)
  })

  test('base_hash 不一致 → conflict，文件不变', async () => {
    const h = await home()
    data(await writeBrief(h, { workspace: WS, text: 'v1', base_hash: EMPTY }, { actor: 'user' }))
    const before = snapshot(join(h, 'brain'))
    const r = await writeBrief(
      h,
      { workspace: WS, text: 'v2', base_hash: EMPTY },
      { actor: 'supervisor' },
    )
    expect(code(r)).toBe('conflict')
    expect(snapshot(join(h, 'brain'))).toEqual(before)
  })

  test('超过 3000 字符 → brief_too_long；非 user / supervisor → role_not_allowed；未定义 workspace', async () => {
    const h = await home()
    const long = 'a'.repeat(BRIEF_MAX_CHARS + 1)
    expect(
      code(await writeBrief(h, { workspace: WS, text: long, base_hash: EMPTY }, { actor: 'user' })),
    ).toBe('brief_too_long')
    data(
      await writeBrief(
        h,
        { workspace: WS, text: 'a'.repeat(BRIEF_MAX_CHARS), base_hash: EMPTY },
        { actor: 'user' },
      ),
    )
    expect(
      code(await writeBrief(h, { workspace: WS, text: 'x', base_hash: EMPTY }, { actor: 'codex' })),
    ).toBe('role_not_allowed')
    expect(
      code(
        await writeBrief(
          h,
          { workspace: 'ws/nope', text: 'x', base_hash: EMPTY },
          { actor: 'user' },
        ),
      ),
    ).toBe('unknown_workspace')
  })

  test('写入前脱敏，疑似密钥不进入 brain', async () => {
    const h = await home()
    const key = fakeStripeKey()
    data(
      await writeBrief(
        h,
        { workspace: WS, text: `部署用 ${key}`, base_hash: EMPTY },
        {
          actor: 'supervisor',
        },
      ),
    )
    const text = readFileSync(notePath(h), 'utf8')
    expect(text).not.toContain(key)
    expect(text).toContain('REDACTED')
  })

  test('其他写入路径都不能写 briefs/（包括 user 与提案）', async () => {
    const h = await home()
    expect(
      code(
        await commitWrite(
          h,
          {
            repo: 'brain',
            op: 'apply',
            summary: '直写',
            files: [{ op: 'create', path: 'briefs/product-res.md', content: 'x\n' }],
          },
          { actor: 'user' },
        ),
      ),
    ).toBe('brief_hub_only')
    expect(
      code(
        await commitWrite(
          h,
          {
            repo: 'brain',
            op: 'apply',
            summary: '直写',
            files: [{ op: 'create', path: 'briefs/product-res.md', content: 'x\n' }],
          },
          { actor: 'supervisor' },
        ),
      ),
    ).toBe('brief_hub_only')
    expect(
      code(await writeEntry(h, { id: 'briefs/product-res', content: 'x\n' }, { actor: 'user' })),
    ).toBe('invalid_entry_id')
    const proposed = await kbProposeOp.run(
      { target: 'briefs/product-res', content: 'x\n', reason: '改笔记' },
      { home: h, actor: 'supervisor', via: 'mcp' },
    )
    expect(proposed.ok).toBe(false)
    expect(existsSync(notePath(h))).toBe(false)
  })

  test('briefs/ 不是条目：校验不报错、index.md 中没有、搜索不到', async () => {
    const h = await home()
    data(
      await writeBrief(
        h,
        { workspace: WS, text: '独特笔记词zqxj', base_hash: EMPTY },
        {
          actor: 'supervisor',
        },
      ),
    )
    const v = data(await validateBrain(h))
    expect(v.errors).toEqual([])
    expect(v.warnings).toEqual([])
    expect(readFileSync(join(h, 'brain', 'index.md'), 'utf8')).not.toContain('briefs')
    const entries = data(await readBrainEntries(h)).entries
    expect(entries.some((e) => e.id.startsWith('briefs/'))).toBe(false)
    const found = data(
      await kbSearchOp.run({ query: 'zqxj' } as never, { home: h, actor: 'user', via: 'cli' }),
    ) as { results: unknown[] }
    expect(found.results).toEqual([])
  })
})

describe('brief_update 操作', () => {
  test('只在中枢执行：本地不写文件；非 supervisor / user 在本地就被拒绝', async () => {
    const h = await home()
    const input = { workspace: 'product-res', text: '笔记', base_hash: EMPTY }
    expect(code(await briefUpdateOp.run(input, { home: h, actor: 'codex', via: 'mcp' }))).toBe(
      'role_not_allowed',
    )
    // 没有中枢 token：请求发不出去，也没有在本地写入。
    expect(code(await briefUpdateOp.run(input, { home: h, actor: 'supervisor', via: 'mcp' }))).toBe(
      'hub_unavailable',
    )
    expect(existsSync(notePath(h))).toBe(false)
  })

  test('workspace 两种写法都规范为 ws/<id> 发给中枢', async () => {
    const h = await home()
    const bodies: unknown[] = []
    const ctx = {
      home: h,
      actor: 'supervisor',
      via: 'mcp' as const,
      token: 'test-token',
      fetch: async (req: Request) => {
        bodies.push(await req.json())
        return Response.json({
          ok: true,
          data: {
            workspace: WS,
            file: 'brain/briefs/product-res.md',
            hash: EMPTY,
            sha: null,
            changed: false,
          },
        })
      },
    }
    for (const workspace of ['product-res', WS]) {
      data(await briefUpdateOp.run({ workspace, text: '笔记', base_hash: EMPTY }, ctx))
    }
    expect(bodies).toEqual([
      { workspace: WS, text: '笔记', base_hash: EMPTY },
      { workspace: WS, text: '笔记', base_hash: EMPTY },
    ])
  })
})
