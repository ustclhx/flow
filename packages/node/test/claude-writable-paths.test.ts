import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkWritableTool } from '../src/claude-writable-paths.ts'

const patterns = ['docs/**', '**/*.md', '**/*.mdx']
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
