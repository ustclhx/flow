import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BEGIN_MARKER,
  END_MARKER,
  type ManagedBlockInput,
  ok,
  renderManagedBlock,
  type SyncReport,
  type SyncTarget,
  spliceManagedBlock,
  syncAgentsFiles,
} from '../src/index.ts'

const input: ManagedBlockInput = {
  workspace: { id: 'ws/xuanxue-saas', name: 'Xuanxue', kind: 'product' },
  projectCardId: 'projects/xuanxue-saas',
  resources: [
    { id: 'resources/services/web', type: 'service', title: 'Web Worker', summary: '网站服务' },
    {
      id: 'resources/domains/ganjiday.com',
      type: 'domain',
      title: 'ganjiday.com',
      summary: '东方站',
    },
    {
      id: 'resources/domains/arcanumber.com',
      type: 'domain',
      title: 'arcanumber.com',
      summary: '西方站',
    },
  ],
}

describe('renderManagedBlock', () => {
  test('重复渲染和资源输入顺序变化时逐字节一致，且不改变输入', () => {
    const snapshot = structuredClone(input)
    const rendered = renderManagedBlock(input)
    expect(Buffer.from(renderManagedBlock(input))).toEqual(Buffer.from(rendered))
    expect(renderManagedBlock({ ...input, resources: input.resources.toReversed() })).toBe(rendered)
    expect(input).toEqual(snapshot)
    const ids = [
      'resources/domains/arcanumber.com',
      'resources/domains/ganjiday.com',
      'resources/services/web',
    ]
    expect(ids.map((id) => rendered.indexOf(id))).toEqual(
      ids.map((id) => rendered.indexOf(id)).sort((a, b) => a - b),
    )
  })

  test('第一级保留完整资源和全部导航，包含标记的长度符合预算', () => {
    const block = renderManagedBlock(input)
    expect(block.startsWith(BEGIN_MARKER)).toBe(true)
    expect(block.endsWith(END_MARKER)).toBe(true)
    expect(block.length).toBeLessThanOrEqual(2000)
    expect(block).toContain('domain `resources/domains/arcanumber.com`：arcanumber.com，西方站')
    expect(block).toContain('`ws/xuanxue-saas`（Xuanxue，产品）')
    expect(block).toContain('`flow kb get projects/xuanxue-saas`')
    for (const tool of [
      'kb_search',
      'kb_get',
      'kb_query',
      'ws_brief',
      'kb_journal',
      'capture',
      'kb_propose',
    ]) {
      expect(block).toContain(`\`${tool}\``)
    }
    expect(block).toContain('必须附出处；不得直接修改 decision 和 personal 条目')
    expect(renderManagedBlock(input, { maxChars: block.length })).toBe(block)
  })

  test('第二级按类型只列标识，省略标题和摘要', () => {
    const large: ManagedBlockInput = {
      ...input,
      resources: input.resources.map((r) => ({ ...r, summary: '超长资源摘要'.repeat(150) })),
    }
    const block = renderManagedBlock(large, { maxChars: 1000 })
    expect(block.length).toBeLessThanOrEqual(1000)
    expect(block).toContain(
      'domain：`resources/domains/arcanumber.com`、`resources/domains/ganjiday.com`',
    )
    expect(block).toContain('service：`resources/services/web`')
    expect(block).not.toContain('Web Worker')
    expect(block).not.toContain('超长资源摘要')
    expect(block).not.toContain('完整列表：')
    expect(
      renderManagedBlock({ ...large, resources: large.resources.toReversed() }, { maxChars: 1000 }),
    ).toBe(block)
  })

  test('第三级只保留各类型数量及完整列表入口', () => {
    const large: ManagedBlockInput = {
      ...input,
      resources: Array.from({ length: 60 }, (_, i) => ({
        id: `resources/${i % 2 === 0 ? 'domains' : 'services'}/${i}`,
        type: i % 2 === 0 ? 'domain' : 'service',
        title: `标题 ${i}`,
        summary: '摘要',
      })),
    }
    const block = renderManagedBlock(large, { maxChars: 1000 })
    expect(block.length).toBeLessThanOrEqual(1000)
    expect(block).toContain('domain：30 个\n  - service：30 个')
    expect(block).toContain('完整列表：flow ws resources ws/xuanxue-saas')
    expect(block).not.toContain('resources/domains/')
    expect(
      renderManagedBlock({ ...large, resources: large.resources.toReversed() }, { maxChars: 1000 }),
    ).toBe(block)
    expect(renderManagedBlock(large, { maxChars: 1 })).toBe(block)
  })

  test('未建项目卡片、职能 workspace 和空资源给出明确说明', () => {
    const empty: ManagedBlockInput = {
      workspace: { id: 'ws/research', name: '研究', kind: 'function' },
      projectCardId: null,
      resources: [],
    }
    const block = renderManagedBlock(empty)
    expect(block).toContain('研究，职能')
    expect(block).toContain('- 项目卡片：尚未建立')
    expect(block).toContain('暂无资源')
    expect(renderManagedBlock(empty, { maxChars: 1 })).toContain(
      '完整列表：flow ws resources ws/research',
    )
  })
})

describe('spliceManagedBlock', () => {
  const block = `${BEGIN_MARKER}\n新的上下文\n${END_MARKER}`

  test('文件不存在时创建带尾换行的区块', () => {
    expect(spliceManagedBlock(null, block)).toEqual(ok({ content: `${block}\n`, changed: true }))
  })

  test.each(['# 原文\n', '# 原文'])('没有区块时追加，原文为 %j', (existing) => {
    expect(spliceManagedBlock(existing, block)).toEqual(
      ok({ content: `# 原文\n\n${block}\n`, changed: true }),
    )
  })

  test('替换已有区块并保留前后原文，再次拼接标记为未改变', () => {
    const existing = `开头\n${BEGIN_MARKER}\n旧的上下文\n${END_MARKER}\n结尾`
    const content = `开头\n${block}\n结尾`
    expect(spliceManagedBlock(existing, block)).toEqual(ok({ content, changed: true }))
    expect(spliceManagedBlock(content, block)).toEqual(ok({ content, changed: false }))
  })

  test('真实 turborepo fixture 的区块外字节、混合换行与空白全部保持不变', async () => {
    const fixture = await readFile(new URL('./fixtures/agents-with-turborepo.md', import.meta.url))
    const existing = fixture.toString('utf8')
    const result = spliceManagedBlock(existing, block)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error.message)
    const updated = Buffer.from(result.data.content)
    const before = fixture.subarray(0, fixture.indexOf(BEGIN_MARKER))
    const after = fixture.subarray(fixture.indexOf(END_MARKER) + Buffer.byteLength(END_MARKER))
    expect(updated.subarray(0, before.length)).toEqual(before)
    expect(updated.subarray(before.length + Buffer.byteLength(block))).toEqual(after)
  })

  test.each([
    [BEGIN_MARKER, '缺少 END'],
    [END_MARKER, '缺少 BEGIN'],
    [`${END_MARKER}\n${BEGIN_MARKER}`, '之前'],
    [`${BEGIN_MARKER}\n${BEGIN_MARKER}\n${END_MARKER}`, '重复'],
    [`${BEGIN_MARKER}\n${END_MARKER}\n${END_MARKER}`, '重复'],
  ])('损坏标记拒绝替换：%s', (existing, reason) => {
    const result = spliceManagedBlock(existing, block)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('应当拒绝损坏标记')
    expect(result.error).toMatchObject({ kind: 'failure', code: 'managed_block_corrupt' })
    expect(result.error.message).toContain(reason)
  })
})

describe('syncAgentsFiles', () => {
  let root: string
  let previousFlowHome: string | undefined

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'flow-agents-sync-'))
    previousFlowHome = process.env.FLOW_HOME
    process.env.FLOW_HOME = join(root, 'flow-home')
  })

  afterEach(async () => {
    if (previousFlowHome === undefined) delete process.env.FLOW_HOME
    else process.env.FLOW_HOME = previousFlowHome
    await rm(root, { recursive: true, force: true })
  })

  async function repository(name: string, content: string | null): Promise<SyncTarget> {
    const repoPath = join(root, name)
    await mkdir(repoPath)
    if (content !== null) await writeFile(join(repoPath, 'AGENTS.md'), content)
    return { workspaceId: input.workspace.id, repoPath, input }
  }

  test('跳过损坏仓库后继续更新其他仓库，只触及 AGENTS.md', async () => {
    const corrupt = await repository('corrupt', `${BEGIN_MARKER}\n损坏`)
    const valid = await repository('valid', '# 项目约定\n')
    await mkdir(join(valid.repoPath, '.git'))
    await writeFile(join(valid.repoPath, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    await writeFile(join(valid.repoPath, 'README.md'), '保持不变\n')
    const result = await syncAgentsFiles([corrupt, valid], { check: false })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('存在损坏区块时应当失败')
    expect(result.error.code).toBe('managed_block_corrupt')
    const report = result.error.details as SyncReport
    expect(report.repositories).toEqual([
      {
        workspaceId: input.workspace.id,
        repoPath: corrupt.repoPath,
        status: 'corrupt',
        reason: '受管区块缺少 END 标记',
      },
      { workspaceId: input.workspace.id, repoPath: valid.repoPath, status: 'updated' },
    ])
    expect(await readFile(join(corrupt.repoPath, 'AGENTS.md'), 'utf8')).toBe(
      `${BEGIN_MARKER}\n损坏`,
    )
    expect(await readFile(join(valid.repoPath, 'AGENTS.md'), 'utf8')).toBe(
      `# 项目约定\n\n${renderManagedBlock(input)}\n`,
    )
    expect((await readdir(valid.repoPath)).sort()).toEqual(['.git', 'AGENTS.md', 'README.md'])
    expect(await readFile(join(valid.repoPath, '.git', 'HEAD'), 'utf8')).toBe(
      'ref: refs/heads/main\n',
    )
    expect(await readFile(join(valid.repoPath, 'README.md'), 'utf8')).toBe('保持不变\n')
  })

  test('check 报告所有状态，过时、缺失和损坏时失败，内容与 mtime 均不变', async () => {
    const targets = await Promise.all([
      repository('stale', '# 尚未生成'),
      repository('missing', null),
      repository('corrupt', END_MARKER),
      repository('current', `${renderManagedBlock(input)}\n`),
    ])
    const snapshots = await Promise.all(
      targets.map(async (target) => {
        const path = join(target.repoPath, 'AGENTS.md')
        if (target.repoPath.endsWith('missing')) return null
        await utimes(path, 946684800, 946684800)
        return { content: await readFile(path), mtimeMs: (await stat(path)).mtimeMs }
      }),
    )
    const result = await syncAgentsFiles(targets, { check: true })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('check 应检测到过时区块')
    expect(result.error.code).toBe('agents_stale')
    expect((result.error.details as SyncReport).repositories.map((r) => r.status)).toEqual([
      'stale',
      'created',
      'corrupt',
      'unchanged',
    ])
    for (const [index, target] of targets.entries()) {
      const snapshot = snapshots[index]
      const path = join(target.repoPath, 'AGENTS.md')
      if (snapshot) {
        expect(await readFile(path)).toEqual(snapshot.content)
        expect((await stat(path)).mtimeMs).toBe(snapshot.mtimeMs)
      } else {
        expect(await readdir(target.repoPath)).toEqual([])
      }
    }
  })

  test('首次创建，第二次同步 unchanged 且不重写；当前内容通过 check', async () => {
    const target = await repository('new', null)
    const path = join(target.repoPath, 'AGENTS.md')
    expect(await syncAgentsFiles([target], { check: false })).toEqual(
      ok({
        repositories: [
          { workspaceId: target.workspaceId, repoPath: target.repoPath, status: 'created' },
        ],
      }),
    )
    expect(await readFile(path, 'utf8')).toBe(`${renderManagedBlock(input)}\n`)
    await utimes(path, 946684800, 946684800)
    const mtimeMs = (await stat(path)).mtimeMs
    const unchanged = ok<SyncReport>({
      repositories: [
        { workspaceId: target.workspaceId, repoPath: target.repoPath, status: 'unchanged' },
      ],
    })
    expect(await syncAgentsFiles([target], { check: false })).toEqual(unchanged)
    expect(await syncAgentsFiles([target], { check: true })).toEqual(unchanged)
    expect((await stat(path)).mtimeMs).toBe(mtimeMs)
  })

  test.each([false, true])('仅有损坏区块时失败，check=%s', async (check) => {
    const target = await repository('corrupt', BEGIN_MARKER)
    const result = await syncAgentsFiles([target], { check })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('损坏区块应当失败')
    expect(result.error.code).toBe(check ? 'agents_stale' : 'managed_block_corrupt')
    expect((result.error.details as SyncReport).repositories[0]).toMatchObject({
      status: 'corrupt',
    })
  })

  test('读取异常以稳定错误码返回，不当作缺失文件覆盖', async () => {
    const target = await repository('unreadable', null)
    await mkdir(join(target.repoPath, 'AGENTS.md'))
    const result = await syncAgentsFiles([target], { check: false })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('读取目录应当失败')
    expect(result.error.code).toBe('agents_sync_failed')
    expect((await stat(join(target.repoPath, 'AGENTS.md'))).isDirectory()).toBe(true)
  })
})
