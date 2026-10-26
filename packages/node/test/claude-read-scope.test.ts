import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkReadScope,
  GREP_HIDDEN_EXCLUDE,
  globPatternAllowed,
  grepGlobWithHiddenExclude,
  isFlowMcp,
  type ReadScopeCall,
  type ReadScopeContext,
  stripHiddenExclude,
} from '../src/claude-read-scope.ts'
import { checkWritableTool } from '../src/claude-writable-paths.ts'

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
  writeFileSync(join(cwd, 'src', 'n.ipynb'), '{}')
  mkdirSync(privateDir, { recursive: true })
  writeFileSync(join(privateDir, 'pr.diff'), 'diff')
  mkdirSync(join(home, 'state'), { recursive: true })
  writeFileSync(join(home, 'state', 'hub.token'), 'placeholder')
  scope = { cwd, privateDir }
})
afterEach(() => rmSync(temp, { recursive: true, force: true }))

const denied = { behavior: 'deny' }
const flow: ReadScopeCall = { mcpServer: { name: 'flow', source: 'dynamic' } }

async function passed(tool: string, input: unknown, s = scope, call: ReadScopeCall = {}) {
  const r = await checkReadScope(tool, input, s, call)
  if (r?.behavior !== 'pass')
    throw new Error(`${tool} ${JSON.stringify(input)} 未通过：${JSON.stringify(r)}`)
  return r.updatedInput
}

describe('路径字段', () => {
  test('cwd 内的路径通过，并改写为校验过的真实绝对路径', async () => {
    expect(await passed('Read', { file_path: 'README.md', limit: 10 })).toEqual({
      file_path: join(cwd, 'README.md'),
      limit: 10,
    })
    expect((await passed('Read', { file_path: './src/./a.ts' })).file_path).toBe(
      join(cwd, 'src/a.ts'),
    )
    expect((await passed('Read', { file_path: join(cwd, 'src/a.ts') })).file_path).toBe(
      join(cwd, 'src/a.ts'),
    )
    expect((await passed('NotebookRead', { notebook_path: 'src/n.ipynb' })).notebook_path).toBe(
      join(cwd, 'src/n.ipynb'),
    )
    expect(await passed('Glob', { pattern: 'src/*.{ts,tsx}', path: 'src' })).toEqual({
      pattern: 'src/*.{ts,tsx}',
      path: join(cwd, 'src'),
    })
    // 写入类工具允许新文件，是否可写另由 writable_paths 或审批决定。
    expect((await passed('Write', { file_path: 'src/b.ts', content: '' })).file_path).toBe(
      join(cwd, 'src/b.ts'),
    )
    for (const [tool, input] of [
      ['Glob', { pattern: '**/*.ts' }],
      ['Glob', { pattern: '*', path: cwd }],
      ['Grep', { pattern: '\\.\\./etc', path: '.' }],
      ['Grep', { pattern: 'x', glob: '*.ts', path: join(cwd, 'src') }],
      ['Grep', { pattern: 'x', '-n': true, output_mode: 'content' }],
      ['NotebookEdit', { notebook_path: 'src/n.ipynb', new_source: '' }],
      ['Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }],
      ['MultiEdit', { file_path: 'src/a.ts', edits: [{ old_string: 'a', new_string: 'b' }] }],
    ] as const) {
      await passed(tool, input)
    }
  })

  test('Glob / Grep 缺省搜索目录时补上 cwd；Grep 的 glob 末尾追加隐藏条目排除且可重复检查', async () => {
    expect(await passed('Glob', { pattern: '**/*.md' })).toEqual({ pattern: '**/*.md', path: cwd })
    const g = await passed('Grep', { pattern: 'x' })
    expect(g).toEqual({ pattern: 'x', path: cwd, glob: GREP_HIDDEN_EXCLUDE })
    // 钩子改写后的输入再经过 canUseTool：结果不变。
    expect(await passed('Grep', g)).toEqual(g)
    const h = await passed('Grep', { pattern: 'x', glob: '*.ts *.md', path: 'src' })
    expect(h.glob).toBe(`*.ts *.md ${GREP_HIDDEN_EXCLUDE}`)
    expect(await passed('Grep', h)).toEqual(h)
  })

  test('任务私有目录只按绝对路径匹配', async () => {
    expect((await passed('Read', { file_path: join(privateDir, 'pr.diff') })).file_path).toBe(
      join(privateDir, 'pr.diff'),
    )
    await passed('Grep', { pattern: 'x', path: privateDir })
    expect(
      await checkReadScope('Read', { file_path: '../private/t-1/pr.diff' }, scope),
    ).toMatchObject(denied)
    // 未注入私有目录时同一路径越界。
    expect(
      await checkReadScope('Read', { file_path: join(privateDir, 'pr.diff') }, { cwd }),
    ).toMatchObject(denied)
  })

  test('~ 展开、首尾空白与不存在的读取目标拒绝（CLI 会把 ~ 展开为 home）', async () => {
    for (const path of [
      '~',
      '~/flow-home/state/hub.token',
      ' ~/.ssh',
      '~/.ssh',
      'README.md ',
      ' README.md',
    ]) {
      expect(await checkReadScope('Read', { file_path: path }, scope)).toMatchObject(denied)
      expect(await checkReadScope('Grep', { pattern: 'x', path }, scope)).toMatchObject(denied)
      expect(await checkReadScope('Glob', { pattern: '*', path }, scope)).toMatchObject(denied)
      expect(await checkWritableTool('Write', { file_path: path }, cwd, ['**'])).toMatchObject(
        denied,
      )
    }
    // 读取的目标必须已存在：cwd 下不存在的 `~` 目录也不能借新路径放行。
    for (const [tool, input] of [
      ['Read', { file_path: 'src/missing.ts' }],
      ['Read', { file_path: 'missing/dir/file' }],
      ['Glob', { pattern: '*', path: 'missing' }],
      ['Grep', { pattern: 'x', path: 'missing' }],
      ['NotebookRead', { notebook_path: 'src/missing.ipynb' }],
    ] as const) {
      expect(await checkReadScope(tool, input, scope)).toMatchObject(denied)
    }
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
      ['NotebookEdit', { notebook_path: join(temp, 'n.ipynb'), new_source: '' }],
      ['Write', { file_path: join(temp, 'outside.md'), content: '' }],
    ] as const) {
      expect(await checkReadScope(tool, input, scope)).toMatchObject(denied)
    }
  })

  test('符号链接越界拒绝，cwd 内的链接与 cwd 自身是链接时通过', async () => {
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
    expect((await passed('Read', { file_path: 'alias.ts' })).file_path).toBe(join(cwd, 'src/a.ts'))
    const alias = join(temp, 'repo-alias')
    symlinkSync(cwd, alias)
    for (const file_path of ['README.md', join(alias, 'README.md'), join(cwd, 'README.md')])
      expect((await passed('Read', { file_path }, { cwd: alias })).file_path).toBe(
        join(cwd, 'README.md'),
      )
  })

  test('.github/ 只在开启选项时可读，且只限 cwd 根下，其中的隐藏段仍拒绝', async () => {
    const review = { cwd, allowDotGithub: true }
    for (const [tool, input] of [
      ['Read', { file_path: '.github/workflows/ci.yml' }],
      ['Glob', { pattern: '.github/workflows/*.yml' }],
      ['Grep', { pattern: 'on', path: '.github' }],
    ] as const) {
      await passed(tool, input, review)
      expect(await checkReadScope(tool, input, scope)).toMatchObject(denied)
    }
    for (const file_path of [
      'src/.github/x',
      '.github/.secret',
      '.env',
      '.GITHUB/workflows/ci.yml',
    ])
      expect(await checkReadScope('Read', { file_path }, review)).toMatchObject(denied)
    // 在 cwd 根下搜索时排除隐藏条目，只放回根下的 .github；没有正向片段时先补 *。
    expect((await passed('Grep', { pattern: 'x' }, review)).glob).toBe('* !.* /.github')
    expect((await passed('Grep', { pattern: 'x', glob: '*.yml' }, review)).glob).toBe(
      '*.yml !.* /.github',
    )
    // 搜索子目录时不放回。
    expect((await passed('Grep', { pattern: 'x', path: 'src' }, review)).glob).toBe('!.*')
    // 没有开启选项时，用户自己写的 .github 后缀被去掉后按当前边界重新追加。
    expect((await passed('Grep', { pattern: 'x', glob: '* !.* /.github' })).glob).toBe('!.*')
  })
})

describe('Glob pattern 与 Grep glob', () => {
  test('绝对、~、..、反斜杠、字符类与可能匹配隐藏名的段拒绝', async () => {
    for (const pattern of [
      '/Users/x/.ssh/*',
      '~/.ssh/*',
      'C:/x/*',
      '../*',
      'src/../../*',
      '**/..',
      '{..,src}/*',
      '{/etc,src}/*',
      '*.ts *.{js,/x}',
      '*.ts /etc/*',
      '**/.ssh/*',
      '.git/**',
      '{.env,src}',
      'src/\\.env',
      '**/[.]env',
      '[.]ssh/*',
      '[a-z]*.ts',
      '?env',
      '**/?ssh/*',
      '!.env',
      '',
      '   ',
    ]) {
      expect(globPatternAllowed(pattern)).toBe(false)
      expect(await checkReadScope('Glob', { pattern }, scope)).toMatchObject(denied)
      if (pattern.trim())
        expect(await checkReadScope('Grep', { pattern: 'x', glob: pattern }, scope)).toMatchObject(
          denied,
        )
    }
    // Spec 场景：用 Glob 越界。
    expect(await checkReadScope('Glob', { pattern: '/Users/x/.ssh/*' }, scope)).toMatchObject(
      denied,
    )
    for (const pattern of ['**/*', '*.md', 'src/**/*.{ts,tsx}', 'docs/@(a|b)/*.md', '*.ts,*.md'])
      expect(globPatternAllowed(pattern)).toBe(true)
    expect(await checkReadScope('Grep', { pattern: 'x', glob: 42 }, scope)).toMatchObject(denied)
  })

  test('隐藏排除后缀：追加与去除', () => {
    expect(grepGlobWithHiddenExclude(undefined, false)).toBe('!.*')
    expect(grepGlobWithHiddenExclude('*.ts', false)).toBe('*.ts !.*')
    expect(grepGlobWithHiddenExclude('!*.min.js', true)).toBe('!*.min.js * !.* /.github')
    expect(stripHiddenExclude('*.ts !.*')).toBe('*.ts')
    expect(stripHiddenExclude('* !.* /.github')).toBe('')
    expect(stripHiddenExclude('*.ts')).toBe('*.ts')
  })
})

describe('工具类别', () => {
  test('不在白名单的工具一律拒绝：命令、代理、网络与未知工具', async () => {
    for (const tool of [
      'Bash',
      'PowerShell',
      'Monitor',
      'Agent',
      'Task',
      'Workflow',
      'RemoteTrigger',
      'EnterWorktree',
      'ExitWorktree',
      'WebFetch',
      'WebSearch',
      'Skill',
      'LSP',
      'SendUserFile',
      'ListMcpResourcesTool',
      'ReadMcpResourceTool',
      'FutureRead',
    ])
      expect(await checkReadScope(tool, { query: 'x' }, scope)).toMatchObject(denied)
    expect(
      await checkReadScope('Bash', { command: `cat ${join(home, 'state', 'hub.token')}` }, scope),
    ).toMatchObject(denied)
    expect(
      await checkReadScope('WebFetch', { url: 'file:///etc/passwd', prompt: 'x' }, scope),
    ).toMatchObject(denied)
  })

  test('白名单工具带未知字段拒绝（含大小写变体），输入不是对象拒绝', async () => {
    for (const [tool, input] of [
      ['Read', { file_path: 'src/a.ts', FILE_PATH: '/etc/passwd' }],
      ['Read', { file_path: 'src/a.ts', filePath: '/etc/passwd' }],
      ['Glob', { pattern: '*', cwd: '/' }],
      ['Grep', { pattern: 'x', root: '/' }],
      ['TodoWrite', { todos: [], path: '/' }],
      ['Read', 'README.md'],
      ['Read', null],
      ['Read', ['README.md']],
    ] as const) {
      expect(await checkReadScope(tool, input, scope)).toMatchObject(denied)
    }
    await passed('TodoWrite', { todos: [{ content: '读 README', status: 'pending' }] })
    await passed('ToolSearch', { query: 'select:mcp__flow__ws_brief', max_results: 5 })
    await passed('StructuredOutput', { verdict: 'approve', summary: '好' })
  })

  test('Flow MCP 只在名称与来源都对得上时豁免；缺少来源、其他来源或其他 MCP 一律拒绝', async () => {
    const input = { path: join(home, 'state', 'hub.token'), file: '/x' }
    expect(await checkReadScope('mcp__flow__kb_get', input, scope, flow)).toBeUndefined()
    expect(
      await checkReadScope('mcp__flow__kb_get', input, scope, {
        mcpServer: { name: 'flow', source: 'sdk' },
      }),
    ).toBeUndefined()
    for (const call of [
      {},
      { mcpServer: { name: 'flow', source: 'project' } },
      { mcpServer: { name: 'flow', source: 'plugin' } },
      { mcpServer: { name: 'evil', source: 'dynamic' } },
    ])
      expect(await checkReadScope('mcp__flow__kb_get', input, scope, call)).toMatchObject(denied)
    for (const tool of ['mcp__flowx__y', 'mcp__external__search'])
      expect(await checkReadScope(tool, { query: 'x' }, scope, flow)).toMatchObject(denied)
    expect(isFlowMcp('mcp__flow__ws_brief', undefined)).toBe(false)
  })

  test('会话 cwd 偏离合同 cwd 时拒绝全部非 Flow 工具', async () => {
    await passed('Read', { file_path: 'README.md' }, scope, { sessionCwd: cwd })
    for (const sessionCwd of [temp, join(temp, 'missing')])
      expect(
        await checkReadScope('Read', { file_path: 'README.md' }, scope, { sessionCwd }),
      ).toMatchObject(denied)
    expect(
      await checkReadScope('mcp__flow__ws_brief', {}, scope, { ...flow, sessionCwd: temp }),
    ).toBeUndefined()
  })
})
