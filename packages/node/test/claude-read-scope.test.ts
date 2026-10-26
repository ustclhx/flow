import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkReadScope,
  globPatternAllowed,
  READ_SCOPE_DENIED_TOOLS,
  type ReadScopeContext,
} from '../src/claude-read-scope.ts'

/** read_scope: cwd（add-m1-supervisor 5.1；executor-claude-sdk「读边界 read_scope」）。全部使用临时目录。 */

let temp: string
let cwd: string
let privateDir: string
let home: string
let scope: ReadScopeContext
beforeEach(() => {
  temp = realpathSync(mkdtempSync(join(tmpdir(), 'flow-read-scope-')))
  cwd = join(temp, 'repo')
  privateDir = join(temp, 'private', 't-1')
  // 临时 FLOW_HOME：模拟中枢 token 所在位置。
  home = join(temp, 'flow-home')
  mkdirSync(join(cwd, 'src'), { recursive: true })
  mkdirSync(join(cwd, '.git'))
  mkdirSync(join(cwd, '.github', 'workflows'), { recursive: true })
  writeFileSync(join(cwd, '.github', 'workflows', 'ci.yml'), 'on: push')
  writeFileSync(join(cwd, '.env'), 'X=1')
  writeFileSync(join(cwd, 'README.md'), '说明')
  writeFileSync(join(cwd, 'src', 'a.ts'), 'export {}')
  mkdirSync(privateDir, { recursive: true })
  writeFileSync(join(privateDir, 'pr.diff'), 'diff')
  mkdirSync(join(home, 'state'), { recursive: true })
  writeFileSync(join(home, 'state', 'hub.token'), 'placeholder')
  scope = { cwd, privateDir }
})
afterEach(() => rmSync(temp, { recursive: true, force: true }))

const denied = { behavior: 'deny' }

describe('路径字段', () => {
  test('cwd 内的相对路径、绝对路径与 cwd 根目录不拦截', async () => {
    for (const [tool, input] of [
      ['Read', { file_path: 'README.md' }],
      ['Read', { file_path: './src/./a.ts' }],
      ['Read', { file_path: join(cwd, 'src/a.ts') }],
      ['Read', { file_path: 'src/new-file.ts' }],
      ['Glob', { pattern: '**/*.ts' }],
      ['Glob', { pattern: 'src/*.{ts,tsx}', path: 'src' }],
      ['Glob', { pattern: '*', path: cwd }],
      ['Grep', { pattern: '\\.\\./etc', path: '.' }],
      ['Grep', { pattern: 'x', glob: '*.ts', path: join(cwd, 'src') }],
      ['Grep', { pattern: 'x' }],
      ['NotebookEdit', { notebook_path: 'src/n.ipynb', new_source: '' }],
      ['Write', { file_path: 'src/b.ts', content: '' }],
    ] as const) {
      expect(await checkReadScope(tool, input, scope)).toBeUndefined()
    }
  })

  test('任务私有目录内的绝对路径不拦截，相对路径不能借 .. 进入', async () => {
    expect(
      await checkReadScope('Read', { file_path: join(privateDir, 'pr.diff') }, scope),
    ).toBeUndefined()
    expect(await checkReadScope('Grep', { pattern: 'x', path: privateDir }, scope)).toBeUndefined()
    expect(
      await checkReadScope('Read', { file_path: '../private/t-1/pr.diff' }, scope),
    ).toMatchObject(denied)
    // 未注入私有目录时同一路径越界。
    expect(
      await checkReadScope('Read', { file_path: join(privateDir, 'pr.diff') }, { cwd }),
    ).toMatchObject(denied)
  })

  test('cwd 外、hub.token、..、隐藏段、空值与非字符串一律拒绝', async () => {
    for (const [tool, input] of [
      ['Read', { file_path: join(home, 'state', 'hub.token') }],
      ['Read', { file_path: join(temp, 'outside.txt') }],
      ['Read', { file_path: `${cwd}-other/a.ts` }],
      ['Read', { file_path: '../repo/README.md' }],
      ['Read', { file_path: 'src/../README.md' }],
      ['Read', { file_path: 'src\\..\\README.md' }],
      ['Read', { file_path: '.env' }],
      ['Read', { file_path: '.git/config' }],
      ['Read', { file_path: 'src/.cache/x' }],
      ['Read', { file_path: 'src/．hidden/x' }],
      ['Read', { file_path: '.github/workflows/ci.yml' }],
      ['Read', { file_path: '' }],
      ['Read', { file_path: 42 }],
      ['Read', { file_path: 'src/a\0.ts' }],
      ['Glob', { pattern: '*', path: '/' }],
      ['Glob', { pattern: '*', path: '.git' }],
      ['Grep', { pattern: 'x', path: join(home, 'state') }],
      ['Grep', { pattern: 'x', path: '..' }],
      ['NotebookEdit', { notebook_path: join(temp, 'n.ipynb') }],
      ['Write', { file_path: join(temp, 'outside.md') }],
    ] as const) {
      expect(await checkReadScope(tool, input, scope)).toMatchObject(denied)
    }
  })

  test('符号链接越界拒绝，cwd 内的链接与 cwd 自身是链接时不拦截', async () => {
    mkdirSync(join(temp, 'outside'))
    writeFileSync(join(temp, 'outside', 'secret'), 's')
    symlinkSync(join(temp, 'outside'), join(cwd, 'src', 'ext'))
    symlinkSync(join(home, 'state', 'hub.token'), join(cwd, 'token.txt'))
    symlinkSync(join(cwd, '.git'), join(cwd, 'src', 'git'))
    symlinkSync(join(temp, 'missing'), join(cwd, 'src', 'dangling'))
    for (const [tool, input] of [
      ['Read', { file_path: 'src/ext/secret' }],
      ['Read', { file_path: 'token.txt' }],
      ['Read', { file_path: 'src/git/config' }],
      ['Read', { file_path: 'src/dangling' }],
      ['Grep', { pattern: 'x', path: 'src/ext' }],
      ['Glob', { pattern: '*', path: 'src/ext' }],
    ] as const) {
      expect(await checkReadScope(tool, input, scope)).toMatchObject(denied)
    }
    symlinkSync(join(cwd, 'src', 'a.ts'), join(cwd, 'alias.ts'))
    expect(await checkReadScope('Read', { file_path: 'alias.ts' }, scope)).toBeUndefined()
    const alias = join(temp, 'repo-alias')
    symlinkSync(cwd, alias)
    for (const file_path of ['README.md', join(alias, 'README.md'), join(cwd, 'README.md')])
      expect(await checkReadScope('Read', { file_path }, { cwd: alias })).toBeUndefined()
  })

  test('.github/ 只在开启选项时可读，且只限 cwd 根下，其中的隐藏段仍拒绝', async () => {
    const review = { cwd, allowDotGithub: true }
    for (const [tool, input] of [
      ['Read', { file_path: '.github/workflows/ci.yml' }],
      ['Glob', { pattern: '.github/workflows/*.yml' }],
      ['Grep', { pattern: 'on', path: '.github' }],
    ] as const) {
      expect(await checkReadScope(tool, input, review)).toBeUndefined()
      expect(await checkReadScope(tool, input, scope)).toMatchObject(denied)
    }
    for (const file_path of [
      'src/.github/x',
      '.github/.secret',
      '.env',
      '.GITHUB/workflows/ci.yml',
    ])
      expect(await checkReadScope('Read', { file_path }, review)).toMatchObject(denied)
  })
})

describe('Glob pattern 与 Grep glob', () => {
  test('绝对、~、..、反斜杠与隐藏段（含花括号分支）拒绝', async () => {
    for (const pattern of [
      '/Users/x/.ssh/*',
      '~/.ssh/*',
      'C:/x/*',
      '../*',
      'src/../../*',
      '**/..',
      '{..,src}/*',
      '{/etc,src}/*',
      '**/.ssh/*',
      '.git/**',
      '{.env,src}',
      'src/\\.env',
      '',
    ]) {
      expect(globPatternAllowed(pattern)).toBe(false)
      expect(await checkReadScope('Glob', { pattern }, scope)).toMatchObject(denied)
      expect(await checkReadScope('Grep', { pattern: 'x', glob: pattern }, scope)).toMatchObject(
        denied,
      )
    }
    // Spec 场景：用 Glob 越界。
    expect(await checkReadScope('Glob', { pattern: '/Users/x/.ssh/*' }, scope)).toMatchObject(
      denied,
    )
    for (const pattern of ['**/*', '*.md', 'src/**/*.{ts,tsx}', 'docs/@(a|b)/*.md'])
      expect(globPatternAllowed(pattern)).toBe(true)
    expect(await checkReadScope('Grep', { pattern: 'x', glob: 42 }, scope)).toMatchObject(denied)
  })
})

describe('工具类别', () => {
  test('无法按路径约束的工具一律拒绝', async () => {
    for (const tool of READ_SCOPE_DENIED_TOOLS)
      expect(await checkReadScope(tool, { command: 'cat README.md' }, scope)).toMatchObject(denied)
    expect(
      await checkReadScope('Bash', { command: `cat ${join(home, 'state', 'hub.token')}` }, scope),
    ).toMatchObject(denied)
  })

  test('带未知路径字段的工具拒绝（含嵌套与非 Flow MCP），无路径字段的工具不拦截', async () => {
    for (const [tool, input] of [
      ['FutureRead', { source_path: 'README.md' }],
      ['FutureRead', { filePath: 'README.md' }],
      ['LSP', { operation: 'hover', filePath: 'src/a.ts', line: 1, character: 1 }],
      ['FutureRead', { options: { directory: '/' } }],
      ['FutureRead', { items: [{ file: 'README.md' }] }],
      ['ReadMcpResourceTool', { server: 'flow', uri: 'file:///etc/passwd' }],
      ['Glob', { pattern: '*', cwd: '/' }],
      ['Grep', { pattern: 'x', root: '/' }],
      ['mcp__external__read', { path: 'README.md' }],
      ['mcp__external__read', { file_path: join(home, 'state', 'hub.token') }],
      ['Read', 'README.md'],
      ['Read', null],
      ['Read', ['README.md']],
    ] as const) {
      expect(await checkReadScope(tool, input, scope)).toMatchObject(denied)
    }
    for (const [tool, input] of [
      ['TodoWrite', { todos: [{ content: '读 README', status: 'pending', activeForm: '读' }] }],
      ['WebSearch', { query: 'flow' }],
      ['ToolSearch', { query: 'x', max_results: 5 }],
      ['ListMcpResourcesTool', { server: 'flow' }],
      ['mcp__external__search', { query: 'x' }],
    ] as const) {
      expect(await checkReadScope(tool, input, scope)).toBeUndefined()
    }
  })

  test('Flow MCP 工具不受影响；来源名不是 flow 时不豁免', async () => {
    const input = { path: join(home, 'state', 'hub.token'), file: '/x' }
    expect(await checkReadScope('mcp__flow__kb_get', input, scope)).toBeUndefined()
    expect(
      await checkReadScope('mcp__flow__kb_get', input, scope, { mcpServer: { name: 'flow' } }),
    ).toBeUndefined()
    expect(
      await checkReadScope('mcp__flow__kb_get', input, scope, { mcpServer: { name: 'evil' } }),
    ).toMatchObject(denied)
  })

  test('会话 cwd 偏离合同 cwd 时拒绝全部非 Flow 工具', async () => {
    expect(
      await checkReadScope('Read', { file_path: 'README.md' }, scope, { sessionCwd: cwd }),
    ).toBeUndefined()
    for (const sessionCwd of [temp, join(temp, 'missing')])
      expect(
        await checkReadScope('Read', { file_path: 'README.md' }, scope, { sessionCwd }),
      ).toMatchObject(denied)
    expect(
      await checkReadScope('mcp__flow__ws_brief', {}, scope, { sessionCwd: temp }),
    ).toBeUndefined()
  })
})
