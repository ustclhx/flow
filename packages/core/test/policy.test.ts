import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stringify } from 'yaml'
import {
  COMMAND_ACTION_MAPPINGS,
  classifyAction,
  decide,
  type IndexedPolicyRule,
  loadPoliciesConfig,
  type PolicyLevel,
  type PolicyRequest,
  type PolicyRule,
  policiesConfigSchema,
} from '../src/policy/index.ts'
import type { Result } from '../src/result.ts'
import { jsonSchemas } from '../src/schema/index.ts'
import { tempHome, writeText } from './helpers.ts'

const data = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error.message)
  return result.data
}
const indexed = (...rules: PolicyRule[]): IndexedPolicyRule[] =>
  rules.map((rule, rule_index) => ({ rule_index, rule }))
const rule = (scope = '*', action = 'git.push', level: PolicyLevel = 'auto'): PolicyRule => ({
  scope,
  action,
  level,
})
const request: PolicyRequest = {
  scope: { workspace: 'ws/xuanxue-saas', role: 'dev' },
  actions: ['git.push'],
}

describe('策略配置', () => {
  const homes: string[] = []
  const home = () => {
    const value = tempHome('flow-policy-')
    homes.push(value)
    return value
  }
  afterEach(() => {
    for (const value of homes.splice(0)) rmSync(dirname(value), { recursive: true, force: true })
  })

  test('一条规则写错：跳过坏规则，保留原始索引并报告序号、字段', async () => {
    const root = home()
    const valid = rule('ws/xuanxue-saas', 'git.push', 'draft-approve')
    writeText(
      join(root, 'config/policies.yaml'),
      stringify([
        rule(),
        { ...rule(), level: 'always' },
        { ...rule(), when: { paths: 'src/**' } },
        valid,
      ]),
    )
    const loaded = data(await loadPoliciesConfig(root))
    expect(loaded.rules).toEqual([
      { rule_index: 0, rule: rule() },
      { rule_index: 3, rule: valid },
    ])
    expect(loaded.errors).toEqual([
      expect.objectContaining({
        file: 'config/policies.yaml',
        rule_index: 1,
        field: 'level',
        code: 'invalid_field',
        message: expect.stringContaining('第 2 条规则'),
      }),
      expect.objectContaining({ rule_index: 2, field: 'when.paths', code: 'invalid_field' }),
    ])
    expect(decide(loaded.rules, request)).toMatchObject({
      level: 'draft-approve',
      matched_rules: [{ rule_index: 3, rule: valid }],
    })
  })

  test('不存在或空文件返回空配置；读取、YAML、顶层类型错误返回稳定错误码', async () => {
    const root = home()
    const path = join(root, 'config/policies.yaml')
    expect(data(await loadPoliciesConfig(root))).toEqual({ rules: [], errors: [] })
    writeText(path, '')
    expect(data(await loadPoliciesConfig(root))).toEqual({ rules: [], errors: [] })
    for (const text of ['[\n', 'rules: []\n']) {
      writeText(path, text)
      expect(await loadPoliciesConfig(root)).toMatchObject({
        ok: false,
        error: { code: 'invalid_config' },
      })
    }
    rmSync(path)
    mkdirSync(path)
    expect(await loadPoliciesConfig(root)).toMatchObject({
      ok: false,
      error: { code: 'read_failed' },
    })
  })

  test('schema 拒绝拼错字段、部分 scope 通配和无效条件，导出整个配置的 JSON Schema', () => {
    const valid = { ...rule(), when: { command_prefix: 'git push', paths: ['src/**', '*.md'] } }
    expect(policiesConfigSchema.safeParse([valid]).success).toBe(true)
    for (const invalid of [
      { scope: 'ws/*' },
      { scope: 'ws/Bad' },
      { scope: 'de*' },
      { action: '' },
      { level: 'always' },
      { when: { paths: [] } },
      { when: { command_prefix: ' ' } },
      { when: { command: 'git' } },
      { actions: '*' },
    ]) {
      expect(policiesConfigSchema.safeParse([{ ...rule(), ...invalid }]).success).toBe(false)
    }
    const schema = jsonSchemas()['config/policies.schema.json']
    expect(schema).toMatchObject({
      type: 'array',
      items: { required: ['scope', 'action', 'level'], additionalProperties: false },
    })
  })

  test('拼错的字段和非对象规则都有可定位的规则序号与字段', async () => {
    const root = home()
    writeText(
      join(root, 'config/policies.yaml'),
      stringify([{ ...rule(), levle: 'auto' }, { ...rule(), when: { path: ['src/**'] } }, null]),
    )
    const loaded = data(await loadPoliciesConfig(root))
    expect(loaded.rules).toEqual([])
    expect(loaded.errors).toMatchObject([
      { rule_index: 0, field: 'levle' },
      { rule_index: 1, field: 'when.path' },
      { rule_index: 2, field: '$' },
    ])
  })
})

describe('动作识别', () => {
  test.each([
    ['git -C dir push', 'git.push'],
    ['git -c k=v push', 'git.push'],
    ['git --git-dir=x push', 'git.push'],
    ['git --work-tree dir --namespace ns --no-pager push', 'git.push'],
    ['git -Cdir -ck=v push', 'git.push'],
    ['gh -R o/r pr merge', 'pr.merge'],
    ['gh --repo o/r pr merge', 'pr.merge'],
    ['gh --repo=o/r pr merge', 'pr.merge'],
    ['gh pr --repo o/r merge', 'pr.merge'],
    ['timeout 10 git push', 'git.push'],
    ['timeout -s TERM -k 2 10 git push', 'git.push'],
    ['nice git push', 'git.push'],
    ['nice -n 5 git push', 'git.push'],
    ['nice -5 git push', 'git.push'],
    ['nohup git push', 'git.push'],
    ['time git push', 'git.push'],
    ['time -f %e -o timing.log git push', 'git.push'],
    ['exec git push', 'git.push'],
    ['exec -a worker git push', 'git.push'],
    ['stdbuf -oL -e 0 git push', 'git.push'],
    ['xargs gh pr merge', 'pr.merge'],
    ['xargs -n 1 -P2 -I{} gh -R o/r pr merge {}', 'pr.merge'],
    [
      'sudo timeout 10 env X=1 nice -n5 nohup time exec stdbuf -oL xargs git -C dir push',
      'git.push',
    ],
  ])('绕过回归：%s', (command, action) => {
    const actions = classifyAction({ tool: 'Bash', command })
    expect(actions).toEqual(['tool:Bash', action])
    expect(
      decide(indexed(rule('*', 'tool:Bash'), rule('dev', action, 'draft-approve')), {
        ...request,
        actions,
        command,
      }).level,
    ).toBe('draft-approve')
  })

  test.each([
    'bash -c "git push"',
    'sh -c "git push"',
    'zsh -c "git push"',
    'bash -lc "git push"',
    'eval "git push"',
    'source x',
    '. x',
    'python -c "print(1)"',
    'python -e "print(1)"',
    'python3 -c "print(1)"',
    'node -c "code"',
    'node -e "code"',
    'ruby -c "code"',
    'ruby -e "code"',
    'perl -c "code"',
    'perl -e "code"',
    'echo $(git push)',
    'echo "$(git push)"',
    'echo `git push`',
    'cat <(git push)',
    'timeout 10 sudo /bin/bash -c "git push"',
  ])('不透明命令回归：%s', (command) => {
    const actions = classifyAction({ tool: 'Bash', command })
    expect(actions).toEqual(
      expect.arrayContaining([
        'tool:Bash',
        'shell.opaque',
        'pr.merge',
        'deploy',
        'secrets',
        'policy.edit',
      ]),
    )
    expect(decide(indexed(rule('*', 'tool:Bash')), { ...request, actions, command }).level).toBe(
      'user',
    )
    expect(decide(indexed(rule('*', '*')), { ...request, actions, command }).level).toBe(
      'draft-approve',
    )
  })

  test.each([
    'bash -c "git push"',
    'sh -c "git push"',
    'zsh -lc "git push"',
    'bash -c \'sh -c "git push"\'',
  ])('提取 shell 命令字符串递归识别：%s', (command) => {
    expect(classifyAction({ tool: 'Bash', command })).toContain('git.push')
  })

  test.each([
    'git --unknown value push',
    'gh --repo',
    'timeout --unknown 10 git push',
    'git push "unterminated',
    '$EXEC push',
  ])('解析不确定时按敏感处理：%s', (command) => {
    const actions = classifyAction({ tool: 'Bash', command })
    expect(actions).toContain('shell.opaque')
    expect(decide(indexed(rule('*', '*')), { ...request, actions, command }).level).toBe(
      'draft-approve',
    )
  })

  test('不透明请求须逐一显式授权所有敏感动作；只授权 shell.opaque 仍需用户', () => {
    const command = 'bash -c "git push"'
    const actions = classifyAction({ tool: 'Bash', command })
    const rules = indexed(
      rule('*', 'tool:Bash'),
      rule('dev', 'git.push'),
      rule('dev', 'shell.opaque'),
    )
    expect(decide(rules, { ...request, actions, command }).level).toBe('user')
    rules.push(
      ...['pr.merge', 'deploy', 'secrets', 'policy.edit'].map((action, index) => ({
        rule_index: index + rules.length,
        rule: rule('dev', action),
      })),
    )
    expect(decide(rules, { ...request, actions, command }).level).toBe('auto')
  })

  test.each(['cat policies.yaml', 'echo policies.yaml.bak', 'printf policies.yaml > other'])(
    '命令文本命中策略文件：%s',
    (command) => {
      expect(classifyAction({ tool: 'Bash', command })).toContain('policy.edit')
      expect(
        decide(indexed(rule('*', 'tool:Bash')), {
          ...request,
          command,
          actions: classifyAction({ tool: 'Bash', command }),
        }).level,
      ).toBe('user')
    },
  )

  test.each([
    ['git push origin feat-x', ['git.push']],
    ['gh pr create --title test', ['pr.create']],
    ['gh pr merge 42', ['pr.merge']],
    ['wrangler deploy', ['deploy']],
    ['wrangler pages deploy dist', ['deploy']],
    ['flow secrets list', ['secrets']],
    ['git  push origin x', ['git.push']],
    ['git\tpush', ['git.push']],
    ['/usr/bin/git push', ['git.push']],
    ['command git push', ['git.push']],
    ['command -p git push', ['git.push']],
    ['command -- /usr/bin/git push', ['git.push']],
    ['FOO=1 BAR="two words" git push', ['git.push']],
    ['env FOO=1 git push', ['git.push']],
    ['/usr/bin/env -u TOKEN FOO=1 git push', ['git.push']],
    ['sudo git push', ['git.push']],
    ['sudo -u root -- env FOO=1 command /usr/bin/git push', ['git.push']],
    ['"/usr/bin/git" p"u"sh', ['git.push']],
    ['git \\\npush', ['git.push']],
    [
      'git push && gh pr create; gh pr merge | wrangler deploy',
      ['git.push', 'pr.create', 'pr.merge', 'deploy'],
    ],
    ['git push || env X=1 gh pr merge\nflow secrets list', ['git.push', 'pr.merge', 'secrets']],
    ['git push; git push | git push', ['git.push']],
    ['echo "git push; gh pr merge"; git status', []],
    ["echo 'git push && gh pr merge'", []],
    ['echo git push # gh pr merge\ngit push', ['git.push']],
    ['git pushy', []],
  ] as const)('%s', (command, actions) => {
    expect(classifyAction({ tool: 'Bash', command })).toEqual(['tool:Bash', ...actions])
  })

  test('Codex 与任意工具名、可扩展映射表', () => {
    expect(classifyAction({ tool: 'exec_command', command: 'git push' })).toEqual([
      'tool:exec_command',
      'git.push',
    ])
    expect(classifyAction({ tool: 'Read' })).toEqual(['tool:Read'])
    expect(
      classifyAction({ tool: 'Bash', command: 'npm publish' }, [
        ...COMMAND_ACTION_MAPPINGS,
        { prefix: ['npm', 'publish'], action: 'package.publish' },
      ]),
    ).toEqual(['tool:Bash', 'package.publish'])
  })

  test('策略路径识别包含相对路径、绝对路径及词法归一；与命令动作取并集', () => {
    for (const path of [
      'config/policies.yaml',
      './config/policies.yaml',
      '/tmp/home/config/policies.yaml',
      'config/sub/../policies.yaml',
      'C:\\flow\\config\\policies.yaml',
    ]) {
      expect(classifyAction({ tool: 'Edit', paths: [path] })).toEqual(['tool:Edit', 'policy.edit'])
    }
    expect(
      classifyAction({ tool: 'Edit', paths: ['config/policies.yaml.bak', 'policies.yaml'] }),
    ).toEqual(['tool:Edit'])
    expect(
      classifyAction({
        tool: 'Bash',
        command: 'flow secrets list',
        paths: ['config/policies.yaml'],
      }),
    ).toEqual(['tool:Bash', 'secrets', 'policy.edit'])
  })
})

describe('策略判定优先级表', () => {
  const scopes = ['*', 'dev', 'ws/xuanxue-saas']
  const levels: PolicyLevel[] = ['notify', 'draft-approve', 'auto-report', 'auto']
  // 三层 scope × 两类 action × 六种不同档位并列组合，共 36 例。
  const ties = scopes.flatMap((scope) =>
    ['git.push', 'git.*'].flatMap((action) =>
      levels.flatMap((conservative, index) =>
        levels.slice(index + 1).map((permissive) => ({
          scope,
          action,
          conservative,
          permissive,
        })),
      ),
    ),
  )
  test.each(ties)(
    '$scope / $action / $conservative 优先于 $permissive',
    ({ scope, action, conservative, permissive }) => {
      for (const ordered of [
        indexed(rule(scope, action, permissive), rule(scope, action, conservative)),
        indexed(rule(scope, action, conservative), rule(scope, action, permissive)),
      ]) {
        const result = decide(ordered, request)
        expect(result.level).toBe(conservative)
        expect(result.actions[0]?.matched_rules.map(({ rule }) => rule.level)).toEqual([
          conservative,
          permissive,
        ])
      }
    },
  )

  const scopePairs = [
    ['dev', '*'],
    ['ws/xuanxue-saas', '*'],
    ['ws/xuanxue-saas', 'dev'],
  ]
  const priorities = scopePairs.flatMap(([higher, lower]) =>
    ['git.push', 'git.*'].flatMap((highAction) =>
      ['git.push', 'git.*'].map((lowAction) => ({ higher, lower, highAction, lowAction })),
    ),
  )
  test.each(priorities)(
    '$higher / $highAction 胜过 $lower / $lowAction',
    ({ higher, lower, highAction, lowAction }) => {
      const rules = indexed(rule(lower, lowAction, 'notify'), rule(higher, highAction, 'auto'))
      expect(decide(rules, request)).toMatchObject({ level: 'auto', matched_rules: [rules[1]] })
    },
  )

  test.each(scopes)('%s 同层具体 action 胜过通配，与档位无关', (scope) => {
    expect(decide(indexed(rule(scope, '*', 'notify'), rule(scope)), request).level).toBe('auto')
  })

  test('具体规则优先：workspace 的 draft-approve 胜过全局 auto', () => {
    const rules = indexed(rule(), rule('ws/xuanxue-saas', 'git.push', 'draft-approve'))
    expect(decide(rules, request)).toMatchObject({
      level: 'draft-approve',
      matched_rules: [rules[1]],
    })
  })
})

describe('策略条件、保护与审计明细', () => {
  test.each([
    {
      command: 'gh pr merge 1',
      rules: [rule('ws/a', 'pr.merge')],
      level: 'auto',
    },
    {
      command: 'gh pr create && gh pr merge',
      rules: [rule('*', 'pr.create', 'auto-report')],
      level: 'user',
    },
    {
      command: "bash -c 'gh pr merge'",
      rules: [rule('ws/a', 'pr.merge')],
      level: 'user',
    },
    {
      command: 'ls',
      rules: [rule('*', 'tool:Bash')],
      level: 'auto',
    },
    {
      command: 'gh pr create',
      rules: [rule('*', 'pr.create', 'auto-report')],
      level: 'auto-report',
    },
  ])('工具动作兜底：$command → $level', ({ command, rules, level }) => {
    const actions = classifyAction({ tool: 'Bash', command })
    const result = decide(indexed(...rules), {
      scope: { workspace: 'ws/a', role: 'dev' },
      actions,
      command,
    })
    expect(result.level).toBe(level)
    expect(result.actions[0]).toMatchObject({
      action: 'tool:Bash',
      level: command === 'ls' ? 'auto' : 'skipped',
      guarded: false,
    })
    if (command !== 'ls') expect(result.actions[0]?.matched_rules).toEqual([])
  })

  test('无匹配、空动作以及任一未覆盖动作都交给用户；notify 保留最高提醒级别', () => {
    expect(decide([], request)).toEqual({
      level: 'user',
      matched_rules: [],
      actions: [{ action: 'git.push', level: 'user', matched_rules: [], guarded: false }],
    })
    expect(decide(indexed(rule('other')), request).level).toBe('user')
    expect(decide(indexed(rule()), { ...request, actions: [] }).level).toBe('user')
    const multi = { ...request, actions: ['tool:Bash', 'git.push', 'pr.merge'] }
    expect(decide(indexed(rule()), multi).level).toBe('user')
    expect(decide(indexed(rule('*', 'git.push', 'notify')), multi).level).toBe('notify')
  })

  test('具体动作存在时忽略工具规则；保留命中内容、原始序号、并列规则，动作和汇总规则去重', () => {
    const rules = indexed(
      rule('*', 'tool:*', 'notify'),
      rule('dev', 'git.push', 'auto-report'),
      rule('dev', 'git.push', 'auto-report'),
    )
    const result = decide(rules, {
      ...request,
      actions: ['tool:Bash', 'tool:Read', 'git.push', 'git.push'],
    })
    expect(result).toEqual({
      level: 'auto-report',
      matched_rules: rules.slice(1),
      actions: [
        { action: 'tool:Bash', level: 'skipped', matched_rules: [], guarded: false },
        { action: 'tool:Read', level: 'skipped', matched_rules: [], guarded: false },
        { action: 'git.push', level: 'auto-report', matched_rules: rules.slice(1), guarded: false },
      ],
    })
  })

  test('通配规则不能放行合并：包含 tool:Bash 的真实请求至少 draft-approve', () => {
    const actions = classifyAction({ tool: 'Bash', command: 'gh pr merge' })
    expect(decide(indexed(rule('*', '*')), { ...request, actions })).toMatchObject({
      level: 'draft-approve',
      actions: [
        { action: 'tool:Bash', level: 'skipped', guarded: false },
        { action: 'pr.merge', level: 'draft-approve', guarded: true },
      ],
    })
  })

  test.each(['pr.merge', 'deploy', 'policy.edit', 'secrets', 'shell.opaque'])(
    '%s 只有具体 scope 和精确 action 才能自动放行',
    (action) => {
      for (const scope of ['*', 'dev', 'ws/xuanxue-saas']) {
        for (const pattern of ['*', action]) {
          for (const level of ['auto', 'auto-report'] as const) {
            const explicit = scope !== '*' && pattern === action
            expect(
              decide(indexed(rule(scope, pattern, level)), { ...request, actions: [action] }),
            ).toMatchObject({
              level: explicit ? level : 'draft-approve',
              actions: [{ guarded: !explicit }],
            })
          }
        }
      }
      expect(decide([], { ...request, actions: [action] }).level).toBe('user')
      expect(
        decide(indexed(rule('*', '*', 'notify')), { ...request, actions: [action] }).level,
      ).toBe('notify')
    },
  )

  test('when 的命令前缀按词匹配，缺失条件或任一串联段不满足则规则不生效', () => {
    const rules = indexed({ ...rule(), when: { command_prefix: 'git push' } })
    for (const command of [
      'git push origin x',
      'FOO=1 sudo command /usr/bin/git  push',
      'git push && git push origin y',
    ]) {
      expect(decide(rules, { ...request, command }).level).toBe('auto')
    }
    for (const command of [undefined, 'git pushy', 'git push && gh pr merge', 'echo "git push"']) {
      expect(
        decide(rules, { ...request, ...(command === undefined ? {} : { command }) }).level,
      ).toBe('user')
    }
  })

  test('when 的路径模式覆盖所有请求路径，多个条件按且组合；未命中的具体规则不遮挡兜底', () => {
    const rules = indexed(rule('*', '*', 'draft-approve'), {
      ...rule('dev'),
      when: { command_prefix: 'git push', paths: ['src/**/*.ts', 'docs/?.md'] },
    })
    for (const paths of [['src/main.ts'], ['./src/nested/main.ts', 'docs/a.md']]) {
      expect(decide(rules, { ...request, command: 'git push', paths }).level).toBe('auto')
    }
    for (const paths of [undefined, [], ['src/main.ts', 'secret.txt'], ['docs/ab.md']]) {
      expect(
        decide(rules, {
          ...request,
          command: 'git push',
          ...(paths === undefined ? {} : { paths }),
        }).level,
      ).toBe('draft-approve')
    }
    expect(decide(rules, { ...request, paths: ['src/main.ts'] }).level).toBe('draft-approve')
  })
})
