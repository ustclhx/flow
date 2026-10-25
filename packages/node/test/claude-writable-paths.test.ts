import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_REVIEWER_WRITABLE_PATHS } from '../../core/src/role-templates.ts'
import { CLAUDE_READ_ONLY_TOOLS, checkWritableTool } from '../src/claude-writable-paths.ts'

const patterns = DEFAULT_REVIEWER_WRITABLE_PATHS
let temp: string
let cwd: string
beforeEach(() => {
  temp = realpathSync(mkdtempSync(join(tmpdir(), 'flow-writable-')))
  cwd = join(temp, 'repo')
  mkdirSync(join(cwd, 'docs'), { recursive: true })
  mkdirSync(join(cwd, 'src'))
  mkdirSync(join(cwd, '.git'))
  writeFileSync(join(cwd, 'README.md'), '原文')
})
afterEach(() => rmSync(temp, { recursive: true, force: true }))

describe('文档路径边界', () => {
  test('允许创建文档、修改已有文件、docs 内其他扩展名与 cwd 内的绝对路径', async () => {
    for (const [tool, path] of [
      ['Write', 'docs/reviews/new/report.txt'],
      ['Edit', 'README.md'],
      ['MultiEdit', 'src/design.mdx'],
      ['Write', './src/./design.md'],
      ['Write', join(cwd, 'docs/report.md')],
    ]) {
      expect(
        await checkWritableTool(tool as string, { file_path: path }, cwd, patterns),
      ).toMatchObject({
        behavior: 'allow',
      })
    }
    for (const ext of ['md', 'mdx', 'txt', 'png', 'svg', 'jpg', 'jpeg', 'gif', 'webp']) {
      for (const path of [`docs/report.${ext}`, `docs/reviews/report.${ext}`])
        expect(await checkWritableTool('Write', { file_path: path }, cwd, patterns)).toMatchObject({
          behavior: 'allow',
        })
    }
  })

  test('拒绝越界、任意 ..、.git、非文档、无效输入与 NotebookEdit', async () => {
    for (const [tool, input] of [
      ['Write', { file_path: join(temp, 'outside.md') }],
      ['Write', { file_path: `${cwd}-other/report.md` }],
      ['Write', { file_path: '../outside.md' }],
      ['Write', { file_path: 'docs/../README.md' }],
      ['Edit', { file_path: '.git/report.md' }],
      ['MultiEdit', { file_path: 'docs/.GIT/report.md' }],
      ['Write', { file_path: 'src/code.ts' }],
      ['Write', { file_path: 'docs/conf.py' }],
      ['Write', { file_path: 'docs/config.ts' }],
      ['Write', { file_path: 'docs/.vitepress/config.ts' }],
      ['Write', { file_path: 'src/README.md.bak' }],
      ['Write', { file_path: 'src/README.md\n' }],
      ['Write', { file_path: 'docs' }],
      ['Edit', { file_path: '' }],
      ['Write', {}],
      ['MultiEdit', { file_path: 42 }],
      ['Write', { file_path: 'docs/file\0.md' }],
      ['NotebookEdit', { notebook_path: 'docs/review.ipynb' }],
      ['NotebookEdit', { file_path: 'docs/review.md' }],
    ] as const) {
      expect(await checkWritableTool(tool, input, cwd, patterns)).toMatchObject({
        behavior: 'deny',
      })
    }
  })

  test('即使白名单为 **，隐藏路径和任意层级的代理指令文件也不能写入', async () => {
    const paths = [
      '.claude/commands/review.md',
      '.codex/config.md',
      '.github/copilot-instructions.md',
      '.cursor/rules/review.md',
      '.vscode/settings.md',
      '.git/report.md',
      'docs/.hidden.md',
      'docs/.HIDDEN/report.md',
      ...[
        'CLAUDE.md',
        'CLAUDE.local.md',
        'AGENTS.md',
        'AGENTS.override.md',
        'GEMINI.md',
        'copilot-instructions.md',
      ].flatMap((name) => [name, `docs/nested/${name.toUpperCase()}`]),
    ]
    for (const file_path of paths) {
      expect(await checkWritableTool('Write', { file_path }, cwd, ['**'])).toMatchObject({
        behavior: 'deny',
      })
    }
    mkdirSync(join(cwd, '.claude'))
    symlinkSync(join(cwd, '.claude'), join(cwd, 'docs/hidden'))
    writeFileSync(join(cwd, 'AGENTS.md'), '不可改的指令')
    symlinkSync(join(cwd, 'AGENTS.md'), join(cwd, 'docs/ordinary.md'))
    for (const file_path of ['docs/hidden/report.md', 'docs/ordinary.md'])
      expect(await checkWritableTool('Edit', { file_path }, cwd, ['**'])).toMatchObject({
        behavior: 'deny',
      })
  })

  test('未知的非 MCP 路径工具拒绝，已知只读工具和 MCP 工具沿用原权限流程', async () => {
    for (const field of ['file_path', 'notebook_path', 'path']) {
      for (const value of ['docs/review.md', null])
        expect(
          await checkWritableTool('FutureWrite', { [field]: value }, cwd, patterns),
        ).toMatchObject({ behavior: 'deny' })
    }
    for (const tool of [...CLAUDE_READ_ONLY_TOOLS, 'mcp__external__read'])
      expect(
        await checkWritableTool(tool, { path: 'docs/report.md' }, cwd, patterns),
      ).toBeUndefined()
    expect(
      await checkWritableTool('FutureWrite', { command: 'read' }, cwd, patterns),
    ).toBeUndefined()
    expect(
      await checkWritableTool('FutureWrite', { path: 'docs/a.md' }, cwd, undefined),
    ).toBeUndefined()
  })

  test('逐段拒绝外部链接、悬空链接、.git 别名，以及伪装成文档的代码链接', async () => {
    mkdirSync(join(temp, 'outside'))
    symlinkSync(join(temp, 'outside'), join(cwd, 'docs/external'))
    symlinkSync(join(temp, 'missing'), join(cwd, 'docs/dangling'))
    symlinkSync(join(cwd, '.git'), join(cwd, 'docs/git'))
    writeFileSync(join(cwd, 'src/code.ts'), '代码')
    symlinkSync(join(cwd, 'src/code.ts'), join(cwd, 'docs/code.md'))
    for (const path of [
      'docs/external/report.md',
      'docs/dangling/report.md',
      'docs/git/report.md',
      'docs/code.md',
    ]) {
      expect(await checkWritableTool('Write', { file_path: path }, cwd, patterns)).toMatchObject({
        behavior: 'deny',
      })
    }
    symlinkSync(join(cwd, 'docs'), join(cwd, 'src/docs'))
    // 原始路径同样必须匹配，不能借允许的目标扩大范围。
    expect(
      await checkWritableTool('Write', { file_path: 'src/docs/file.txt' }, cwd, patterns),
    ).toMatchObject({ behavior: 'deny' })
    symlinkSync(join(cwd, 'docs'), join(cwd, 'docs/alias'))
    expect(
      await checkWritableTool('Write', { file_path: 'docs/alias/new.md' }, cwd, patterns),
    ).toEqual({ behavior: 'allow', path: join(cwd, 'docs/new.md') })
    const alias = join(temp, 'repo-alias')
    symlinkSync(cwd, alias)
    expect(
      await checkWritableTool('Write', { file_path: join(cwd, 'docs/new.md') }, alias, patterns),
    ).toEqual({ behavior: 'allow', path: join(cwd, 'docs/new.md') })
  })

  test('角色可以收紧目录；空白名单禁写，缺省及非文件工具沿用原审批', async () => {
    expect(
      await checkWritableTool('Write', { file_path: 'README.md' }, cwd, ['docs/reviews/**']),
    ).toMatchObject({ behavior: 'deny' })
    expect(
      await checkWritableTool('Write', { file_path: 'docs/reviews/a.md' }, cwd, [
        'docs/reviews/**',
      ]),
    ).toMatchObject({ behavior: 'allow' })
    expect(await checkWritableTool('Write', { file_path: 'README.md' }, cwd, [])).toMatchObject({
      behavior: 'deny',
    })
    expect(
      await checkWritableTool('Write', { file_path: 'README.md' }, cwd, undefined),
    ).toBeUndefined()
    expect(
      await checkWritableTool('Bash', { command: 'gh pr diff' }, cwd, patterns),
    ).toBeUndefined()
  })
})
