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
    ['git --git-dir=x push', 'git.push'],
    ['git --work-tree dir --namespace ns --no-pager push', 'git.push'],
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

  // 第五轮审查：间接执行器与 `git -c` 照常识别其后的动作，整段另按不透明处理。
  test.each([
    ['git -c k=v push', 'git.push'],
    ['git -Cdir -ck=v push', 'git.push'],
    ['xargs gh pr merge', 'pr.merge'],
    ['xargs -n 1 -P2 -I{} gh -R o/r pr merge {}', 'pr.merge'],
    [
      'sudo timeout 10 env X=1 nice -n5 nohup time exec stdbuf -oL xargs git -C dir push',
      'git.push',
    ],
  ])('间接执行仍识别动作并按不透明处理：%s', (command, action) => {
    const actions = classifyAction({ tool: 'Bash', command })
    expect(actions).toContain(action)
    expect(actions).toContain('shell.opaque')
  })

  test.each([
    'xargs rm -rf',
    'find . -name x -exec rm {} ;',
    'find . -execdir sh x ;',
    'find . -ok rm {} ;',
    'find . -okdir rm {} ;',
    'git rebase --exec "make" main',
    'git rebase --exec=make main',
    'git rebase -x make main',
    'git rebase -ix make main',
    'git bisect run make',
    'git submodule foreach make',
    'git filter-branch --tree-filter x',
    'git difftool -x meld',
    'git -c alias.st=!sh st',
    'git --config-env=core.sshCommand=X push origin main',
    'git --exec-path=/tmp push origin main',
    'watch make',
    'parallel make ::: a b',
    'script -c make /dev/null',
    'su -c make root',
    'ssh host make',
    'doas make',
    'env xargs make',
    'git difftool HEAD~1',
    'git mergetool',
    'GIT_SSH_COMMAND=evil git push origin x',
    'GIT_DIR=/tmp/x git status',
    'LD_PRELOAD=/tmp/x.so ls',
    'DYLD_INSERT_LIBRARIES=/tmp/x.dylib ls',
    'BASH_ENV=/tmp/x bash script.sh',
    'ENV=/tmp/x sh script.sh',
    'PYTHONSTARTUP=/tmp/x python3 -V',
    'NODE_OPTIONS=--require=/tmp/x.js pnpm test',
    'env NODE_OPTIONS=--require=/tmp/x.js pnpm test',
    'arch -arm64 make',
    'sandbox-exec -p x make',
    'osascript -e x',
    'FOO=1 pnpm test',
    'git grep -O foo',
    'git grep --open-files-in-pager=vim foo',
    'git fetch --upload-pack=evil origin',
    'git clone -u evil x',
    'git ls-remote --upload-pack evil origin',
    'git archive --exec=evil --remote=x HEAD',
    'git push --receive-pack=evil origin x',
    'git push --exec=evil origin x',
    'git send-email x.patch',
    'git help --web push',
    'git instaweb',
    // 长选项的唯一前缀缩写（git parse-options 接受）。
    'git fetch --upload=evil origin',
    'git fetch --uploa evil origin',
    'git push --recei=evil origin x',
    'git push --exe=evil origin x',
    'git rebase --exe=make main',
    'git grep --open-files=vim foo',
    'git archive --exe=evil --remote=x HEAD',
    'git help --brow=x push',
    // 短选项直接接参数。
    'git clone -uevil x',
    'git clone -qu evil x',
    // clone 的 -c / --config 写入新仓库配置并立即生效。
    'git clone -c core.sshCommand=evil https://example.com/x.git',
    'git clone --config core.fsmonitor=evil https://example.com/x.git',
    'git clone --config=core.fsmonitor=evil https://example.com/x.git',
    'git clone --conf=core.fsmonitor=evil https://example.com/x.git',
  ])('间接执行器按不透明处理：%s', (command) => {
    expect(classifyAction({ tool: 'Bash', command })).toContain('shell.opaque')
  })

  test('caffeinate 按包装剥离，识别其后的动作', () => {
    expect(classifyAction({ tool: 'Bash', command: 'caffeinate -i git push origin x' })).toEqual([
      'tool:Bash',
      'git.push',
    ])
  })

  test.each([
    'find . -name x',
    'git rebase main',
    'git status',
    'pnpm test',
    'CI=1 NODE_ENV=test TZ=UTC LANG=C LC_ALL=C NO_COLOR=1 FORCE_COLOR=0 pnpm test',
    'git grep foo',
    'git fetch origin',
    'git push origin x',
    'git archive HEAD',
    'git help push',
    'git fetch --prune origin',
    'git fetch --unshallow origin',
    'git push --force-with-lease origin x',
    'git pull --rebase origin main',
    'git rebase --onto main x',
    'git clone https://example.com/x.git',
    'git clone --depth 1 https://example.com/x.git',
  ])('普通命令不因间接执行器规则变为不透明：%s', (command) => {
    expect(classifyAction({ tool: 'Bash', command })).not.toContain('shell.opaque')
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
      ...['pr.merge', 'deploy', 'secrets', 'policy.edit', 'config.edit'].map((action, index) => ({
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
    ['CI=1 LANG="en_US UTF-8" git push', ['git.push']],
    ['env CI=1 git push', ['git.push']],
    ['/usr/bin/env -u TOKEN CI=1 git push', ['git.push']],
    ['sudo git push', ['git.push']],
    ['sudo -u root -- env CI=1 command /usr/bin/git push', ['git.push']],
    ['"/usr/bin/git" p"u"sh', ['git.push']],
    ['git \\\npush', ['git.push']],
    [
      'git push && gh pr create; gh pr merge | wrangler deploy',
      ['git.push', 'pr.create', 'pr.merge', 'deploy'],
    ],
    ['git push || env TZ=UTC gh pr merge\nflow secrets list', ['git.push', 'pr.merge', 'secrets']],
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
    for (const command of ['git push origin x', 'git  push', 'git push && git push origin y']) {
      expect(decide(rules, { ...request, command }).level).toBe('auto')
    }
    // 严格匹配：环境变量赋值、包装命令与执行文件路径都不再被消去（行为变更，见 README）。
    for (const command of [
      undefined,
      'git pushy',
      'git push && gh pr merge',
      'echo "git push"',
      'FOO=1 sudo command /usr/bin/git  push',
      'sudo git push',
      '/usr/bin/git push',
    ]) {
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

describe('受保护的工具与配置写入（PR #29 审查的对抗用例）', () => {
  const judge = (
    rules: PolicyRule[],
    req: { tool: string; command?: string; paths?: string[] },
    flowHomes?: string[],
  ) => {
    const actions = classifyAction(req, undefined, flowHomes ? { flowHomes } : {})
    return { ...decide(indexed(...rules), { ...request, ...req, actions }), ids: actions }
  }
  const WILDCARDS = [
    [rule('dev', 'tool:*')],
    [rule('*', 'tool:*')],
    [rule('*', '*')],
    [rule('ws/xuanxue-saas', '*')],
  ]

  test('mcp__flow__task_create：识别为 task.create，tool:* 不能放行；显式 task.create 规则可以', () => {
    const req = { tool: 'mcp__flow__task_create' }
    expect(classifyAction(req)).toEqual(['tool:mcp__flow__task_create', 'task.create'])
    for (const rules of [...WILDCARDS, [rule('dev', 'tool:mcp__*')], [rule('*', 'task.create')]]) {
      expect(judge(rules, req).level).not.toMatch(/^auto/)
    }
    // tool:* 匹配不到具体动作 task.create：无规则覆盖，交给用户；`* *` 命中但被拦下。
    expect(judge([rule('dev', 'tool:*')], req).level).toBe('user')
    expect(judge([rule('dev', '*')], req).level).toBe('draft-approve')
    expect(judge([rule('dev', 'task.create')], req).level).toBe('auto')
    expect(judge([rule('dev', 'tool:mcp__flow__task_create')], req).level).toBe('user')
  })

  test('其他会扩大权限的 flow 工具同样识别为具体动作', () => {
    expect(classifyAction({ tool: 'mcp__flow__inbox_act' })).toContain('inbox.act')
    expect(judge([rule('*', '*')], { tool: 'mcp__flow__inbox_act' }).level).not.toMatch(/^auto/)
    expect(classifyAction({ tool: 'mcp__flow__task_cancel' })).toContain('task.cancel')
    expect(classifyAction({ tool: 'mcp__flow__kb_proposals_accept' })).toContain('proposal.decide')
    expect(classifyAction({ tool: 'mcp__flow__kb_proposals_reject' })).toContain('proposal.decide')
    expect(classifyAction({ tool: 'mcp__flow__kb_search' })).toEqual(['tool:mcp__flow__kb_search'])
    expect(judge([rule('dev', '*')], { tool: 'mcp__flow__kb_proposals_accept' }).level).toBe(
      'draft-approve',
    )
  })

  test('第三方 MCP、WebFetch、WebSearch、Task：通配规则不能放行，精确工具规则可以', () => {
    for (const tool of ['mcp__github__create_pr', 'WebFetch', 'WebSearch', 'Task']) {
      for (const rules of [...WILDCARDS, [rule('dev', 'tool:mcp__*')]]) {
        expect(judge(rules, { tool }).level).not.toMatch(/^auto/)
      }
      expect(judge([rule('dev', 'tool:*')], { tool }).level).toBe('draft-approve')
      expect(judge([rule('dev', `tool:${tool}`)], { tool }).level).toBe('auto')
    }
  })

  test.each([
    'sed -i s/draft-approve/auto/ ~/flow-home/config/polic*.yaml',
    // 字面的 ${p}（shell 变量展开），拼接以免被当作模板字符串。
    'p=polic; sed -i s/x/y/ ~/flow-home/config/$' + '{p}ies.yaml',
    'cp /tmp/evil ~/flow-home/config/policies.yam?',
    'cp /tmp/evil ~/flow-home/config/[p]olicies.yaml',
    'cat /tmp/evil > $HOME/flow-home/config/policies.yaml',
    'cp /tmp/evil ~/flow-home/CONFIG/Policies.YAML',
  ])('策略文件的动态或大小写变体写法不能被通配规则放行：%s', (command) => {
    const { ids } = judge([], { tool: 'Bash', command })
    expect(ids).toContain('policy.edit')
    for (const rules of [...WILDCARDS, [rule('*', 'tool:Bash')], [rule('dev', 'tool:Bash')]]) {
      expect(judge(rules, { tool: 'Bash', command }).level).not.toMatch(/^auto/)
    }
  })

  test('路径不区分大小写：Write /Users/u/flow-home/CONFIG/Policies.yaml', () => {
    const req = { tool: 'Write', paths: ['/Users/u/flow-home/CONFIG/Policies.yaml'] }
    expect(classifyAction(req)).toContain('policy.edit')
    const r = judge([rule('dev', 'tool:*'), rule('dev', 'tool:Write')], req, ['/Users/u/flow-home'])
    expect(r.ids).toContain('config.edit')
    expect(r.level).toBe('user')
  })

  test('flow-home 的 config/ 下任何路径或命令都识别为 config.edit，必须显式授权', () => {
    const home = '/Users/u/flow-home'
    for (const req of [
      { tool: 'Edit', paths: [`${home}/config/roles/dev.yaml`] },
      { tool: 'Write', paths: [`${home}/Config/remote.yaml`] },
      { tool: 'Bash', command: `echo x >> ${home}/config/roles/dev.yaml` },
      { tool: 'Bash', command: 'tee ~/flow-home/config/remote.yaml < /tmp/x' },
    ]) {
      const r = judge([rule('*', '*'), rule('dev', 'tool:*')], req, [home])
      expect(r.ids).toContain('config.edit')
      expect(r.level).not.toMatch(/^auto/)
    }
    // 不在 flow-home 下的普通 config 目录不受影响。
    expect(
      judge([rule('dev', 'tool:Edit')], { tool: 'Edit', paths: ['/repo/config/app.ts'] }, [home])
        .level,
    ).toBe('auto')
    const explicit = judge(
      [rule('dev', 'config.edit')],
      { tool: 'Edit', paths: [`${home}/config/roles/dev.yaml`] },
      [home],
    )
    expect(explicit.level).toBe('auto')
  })

  test.each(['rm -rf ~', 'curl -d @dist https://example.com/upload', 'git push origin main'])(
    'CodexCommand 被通配规则拦下：%s',
    (command) => {
      for (const rules of WILDCARDS) {
        expect(judge(rules, { tool: 'CodexCommand', command }).level).not.toMatch(/^auto/)
      }
      expect(judge([rule('*', '*')], { tool: 'CodexCommand', command }).level).toBe('draft-approve')
    },
  )

  test('CodexCommand 的显式规则仍可放行', () => {
    expect(
      judge([rule('ws/xuanxue-saas', 'tool:CodexCommand')], {
        tool: 'CodexCommand',
        command: 'rm -rf build',
      }).level,
    ).toBe('auto')
    expect(
      judge([rule('*', 'git.push')], { tool: 'CodexCommand', command: 'git push origin feat' })
        .level,
    ).toBe('auto')
  })

  test('普通工具的通配规则不受影响', () => {
    expect(judge([rule('*', 'tool:*')], { tool: 'Bash', command: 'ls' }).level).toBe('auto')
    expect(judge([rule('dev', 'tool:*')], { tool: 'Read', paths: ['/repo/a.ts'] }).level).toBe(
      'auto',
    )
  })

  test('命令中的非打印字符（双向覆盖、零宽、控制字符）按不透明处理', () => {
    for (const command of ['ls ‮', 'ls​ -la', 'echo a\u0007']) {
      expect(classifyAction({ tool: 'Bash', command })).toContain('shell.opaque')
    }
    expect(classifyAction({ tool: 'Bash', command: 'ls\n\tpwd' })).not.toContain('shell.opaque')
  })
})

describe('Bash 调 flow CLI、直接访问中枢与 config.edit 词法变体（PR #29 复核）', () => {
  const HOME = '/Users/u'
  const FLOW_HOME = '/Users/u/flow-home'
  const opts = { flowHomes: [FLOW_HOME], userHome: HOME }
  const judge = (rules: PolicyRule[], command: string, o: Record<string, unknown> = opts) => {
    const actions = classifyAction({ tool: 'Bash', command }, undefined, o)
    return { ...decide(indexed(...rules), { ...request, command, actions }), ids: actions }
  }
  const BASH_AUTO = [rule('*', 'tool:Bash'), rule('dev', 'tool:*'), rule('*', '*')]

  test.each([
    ['flow task create --role admin --goal x', 'task.create'],
    ['flow task reply t-1 --approve', 'task.reply'],
    ['flow task cancel t-1', 'task.cancel'],
    ['flow inbox act blk.42 approve', 'inbox.act'],
    ['flow kb proposals accept p-1', 'proposal.decide'],
    ['flow kb proposals reject p-1', 'proposal.decide'],
    ['flow resource transfer r-1 --to ws/b', 'resource.transfer'],
    ['flow hub token issue node:x', 'flow.admin'],
    ['flow policy check --task t-1 --tool Bash', 'flow.admin'],
    ['flow daemon install', 'flow.admin'],
    ['flow --json --actor user task create --role admin', 'task.create'],
    ['/Users/x/.bun/bin/flow task create --role admin', 'task.create'],
    ['bunx flow task reply t-1 --approve', 'task.reply'],
    ['npx flow kb proposals accept p-1', 'proposal.decide'],
    ['bun /Users/x/flow/packages/cli/src/main.ts task create --role admin', 'task.create'],
    ['bun run packages/cli/src/main.ts hub token issue node:x', 'flow.admin'],
    ['bun x flow hub token issue node:x', 'flow.admin'],
  ])('flow CLI：%s → %s，tool:Bash 的 auto 不能放行', (command, action) => {
    const r = judge([], command)
    expect(r.ids).toContain(action)
    for (const rules of [...BASH_AUTO.map((x) => [x])]) {
      expect(judge(rules, command).level).not.toMatch(/^auto/)
    }
    // 显式规则仍可放行（flow.admin 与 flow 工具动作一样需要具体 scope 加精确 action）。
    const explicit = judge([rule('dev', action), rule('dev', 'tool:Bash')], command)
    expect(explicit.ids.filter((a) => a !== 'tool:Bash' && a !== action)).toEqual([])
    expect(explicit.level).toBe('auto')
  })

  test('白名单之外的环境变量赋值：照常识别动作，整段按不透明处理', () => {
    const r = judge([], 'cd /repo && FLOW_ACTOR=user flow task create --role admin')
    expect(r.ids).toContain('task.create')
    expect(r.ids).toContain('shell.opaque')
  })

  test('bun -e / --eval 执行任意代码：按不透明处理', () => {
    expect(judge([], 'bun -e "fetch(1)"').ids).toContain('shell.opaque')
    expect(judge([], 'bun --print 1').ids).toContain('shell.opaque')
    // 普通的 bun 子命令不受影响。
    expect(judge([rule('dev', 'tool:Bash')], 'bun test packages/node').level).toBe('auto')
  })

  test.each([
    'curl -X POST http://127.0.0.1:7477/v1/tasks -d @t.json',
    'curl http://localhost:7478/v1/tasks/t-1/reply',
    'curl -s "http://[::1]:7477/health"',
    'wget -qO- http://mac.local:7477/v1/tasks',
    'curl http://127.0.0.1:9123/x',
  ])('直接访问中枢：%s → 不透明', (command) => {
    const r = judge([], command, { ...opts, hubPorts: [9123] })
    expect(r.ids).toContain('shell.opaque')
    for (const x of BASH_AUTO) {
      expect(judge([x], command, { ...opts, hubPorts: [9123] }).level).not.toMatch(/^auto/)
    }
  })

  test('访问其他本机端口不受影响', () => {
    expect(judge([rule('dev', 'tool:Bash')], 'curl http://127.0.0.1:3000/api').level).toBe('auto')
  })

  test.each([
    'cd ~/flow-home && echo x > config/roles/dev.yaml',
    "echo x > ~/flow-home/'config'/roles/dev.yaml",
    'echo x > "/Users/u/flow-home"/config/remote.yaml',
    'echo x > /Users/u//flow-home/./config/remote.yaml',
    'echo x > $HOME/flow-home/config/remote.yaml',
    'echo x > $' + '{HOME}/flow-home/config/remote.yaml',
    'cp x /Users/u/Flow-Home/config/roles/dev.yaml',
  ])('config.edit 的相对路径与词法变体：%s', (command) => {
    const r = judge([], command)
    expect(r.ids).toContain('config.edit')
    for (const x of BASH_AUTO) expect(judge([x], command).level).not.toMatch(/^auto/)
  })

  test('非默认 flow-home 的 ~ 写法与 basename 路径段', () => {
    const o = { flowHomes: ['/Users/u/work/fh-prod'], userHome: HOME }
    for (const command of [
      'echo x > ~/work/fh-prod/config/roles/dev.yaml',
      'cd ~/work/fh-prod && echo x > config/remote.yaml',
      'cd work/fh-prod; echo x > config/remote.yaml',
    ]) {
      expect(judge([], command, o).ids).toContain('config.edit')
    }
    // basename 只在作为完整路径段时命中。
    expect(judge([], 'echo fh-production > notes.txt', o).ids).not.toContain('config.edit')
  })

  test('收窄误判：tsconfig、vite.config 与 glob 同时出现不再视为不透明', () => {
    for (const command of [
      'git diff -- "*.ts" tsconfig.json',
      'ls vite.config.*',
      'cat src/config.ts | grep -n "$x"',
    ]) {
      const r = judge([rule('dev', 'tool:Bash')], command)
      expect(r.ids).not.toContain('shell.opaque')
      expect(r.level).toBe('auto')
    }
    // 但 glob 加 /config/ 或 flow-home 仍按不透明处理。
    expect(judge([], 'sed -i x /repo/config/*.yaml').ids).toContain('shell.opaque')
    expect(judge([], 'rm ~/flow-home/*').ids).toContain('shell.opaque')
  })
})
