import { describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { exitCodeOf, type Result } from '../src/result.ts'
import { DEFAULT_ROLE_FILES } from '../src/role-templates.ts'
import {
  actorMatches,
  canCreateRole,
  effectiveRoleKind,
  findSupervisorRole,
  inferRoleKind,
  loadRoles,
  type Role,
  roleSchema,
} from '../src/roles.ts'
import { jsonSchemas } from '../src/schema/index.ts'
import { tempHome, writeText } from './helpers.ts'

const data = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error.message)
  return result.data
}
const role = { name: 'dev', executor: 'fake', prompt: '完成任务并报告结果' }

describe('角色配置', () => {
  test('内联提示词、全部可选字段和执行器专用权限内容原样保留', async () => {
    const home = tempHome('flow-roles-')
    const configured = {
      ...role,
      model: 'custom-model',
      effort: 'high',
      permissions: { sandbox: 'read-only', nested: { tools: ['Read'], enabled: true } },
      no_progress_minutes: 15,
    }
    writeText(join(home, 'config/roles/dev.yaml'), stringify(configured))
    expect(data(await loadRoles(home))).toEqual({ roles: [configured], errors: [] })
  })

  test('引用 Markdown 提示词：读取同目录文件', async () => {
    const home = tempHome('flow-roles-')
    const prompt = '# 开发角色\n完成任务并运行验收。\n'
    writeText(join(home, 'config/roles/dev.yaml'), stringify({ ...role, prompt: 'dev.md' }))
    writeText(join(home, 'config/roles/dev.md'), prompt)
    expect(data(await loadRoles(home))).toEqual({
      roles: [{ ...role, prompt }],
      errors: [],
    })
  })

  test('提示词文件缺失时报 prompt_file_missing，不加载该角色且不影响其他角色', async () => {
    const home = tempHome('flow-roles-')
    writeText(join(home, 'config/roles/dev.yaml'), stringify({ ...role, prompt: 'dev.md' }))
    writeText(join(home, 'config/roles/triage.yaml'), stringify({ ...role, name: 'triage' }))
    expect(data(await loadRoles(home))).toEqual({
      roles: [{ ...role, name: 'triage' }],
      errors: [
        {
          file: 'config/roles/dev.yaml',
          field: 'prompt',
          code: 'prompt_file_missing',
          message: '提示词文件 dev.md 不存在',
        },
      ],
    })
  })

  test('只解析同目录文件名，不读取路径指向的 Markdown', async () => {
    const home = tempHome('flow-roles-')
    writeText(join(home, 'config/outside.md'), '目录外提示词')
    writeText(join(home, 'config/roles/dev.yaml'), stringify({ ...role, prompt: '../outside.md' }))
    expect(data(await loadRoles(home)).roles[0]?.prompt).toBe('../outside.md')
  })

  test('目录缺失返回空集，目录无法读取返回失败', async () => {
    const home = tempHome('flow-roles-')
    expect(data(await loadRoles(home))).toEqual({ roles: [], errors: [] })
    writeText(join(home, 'config/roles'), '不是目录')
    const result = await loadRoles(home)
    expect(result).toMatchObject({ ok: false, error: { code: 'read_failed' } })
    expect(exitCodeOf(result)).toBe(1)
  })

  test('逐文件隔离 YAML、字段与读取错误，保留合法角色并报告文件和字段', async () => {
    const home = tempHome('flow-roles-')
    const dir = join(home, 'config/roles')
    writeText(join(dir, 'dev.yaml'), stringify(role))
    writeText(join(dir, 'broken.yaml'), 'name: [\n')
    writeText(join(dir, 'invalid.yaml'), 'name: invalid\npermissions: []\n')
    writeText(join(dir, 'mismatch.yaml'), stringify({ ...role, name: 'other' }))
    writeText(
      join(dir, 'unreadable-prompt.yaml'),
      stringify({
        ...role,
        name: 'unreadable-prompt',
        prompt: 'directory.md',
      }),
    )
    mkdirSync(join(dir, 'directory.md'))
    mkdirSync(join(dir, 'unreadable.yaml'))
    const loaded = data(await loadRoles(home))
    expect(loaded.roles).toEqual([role])
    expect(loaded.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: 'config/roles/broken.yaml', code: 'invalid_yaml' }),
        expect.objectContaining({
          file: 'config/roles/invalid.yaml',
          field: 'executor',
          code: 'missing_field',
        }),
        expect.objectContaining({
          file: 'config/roles/invalid.yaml',
          field: 'prompt',
          code: 'missing_field',
        }),
        expect.objectContaining({
          file: 'config/roles/invalid.yaml',
          field: 'permissions',
          code: 'invalid_field',
        }),
        expect.objectContaining({
          file: 'config/roles/mismatch.yaml',
          field: 'name',
          code: 'role_name_mismatch',
        }),
        expect.objectContaining({
          file: 'config/roles/unreadable-prompt.yaml',
          field: 'prompt',
          code: 'read_failed',
        }),
        expect.objectContaining({ file: 'config/roles/unreadable.yaml', code: 'read_failed' }),
      ]),
    )
    expect(loaded.errors).toHaveLength(7)
  })

  test('schema 校验必填字段、可选类型和正整数阈值，permissions 只要求对象', () => {
    expect(roleSchema.safeParse({ ...role, executor: 'gpt-cli' }).success).toBe(true)
    for (const field of ['name', 'executor', 'prompt'] as const) {
      const { [field]: _omitted, ...missing } = role
      expect(roleSchema.safeParse(missing).success).toBe(false)
      expect(roleSchema.safeParse({ ...role, [field]: '' }).success).toBe(false)
    }
    for (const invalid of [
      { model: 123 },
      { effort: false },
      { permissions: [] },
      { permissions: null },
      { permissions: 'read-only' },
      { no_progress_minutes: 0 },
      { no_progress_minutes: -1 },
      { no_progress_minutes: 1.5 },
      { no_progress_minutes: '15' },
    ]) {
      expect(roleSchema.safeParse({ ...role, ...invalid }).success).toBe(false)
    }
    expect(roleSchema.safeParse({ ...role, permisions: {} }).success).toBe(false)
    expect(
      roleSchema.safeParse({
        ...role,
        executor: 'claude-sdk',
        permissions: { writable_paths: ['docs/**', '**/*.md'] },
      }).success,
    ).toBe(true)
    expect(
      roleSchema.safeParse({ ...role, permissions: { writable_paths: 'docs/**' } }).success,
    ).toBe(false)
    const exported = jsonSchemas()['config/role.schema.json'] as {
      required: string[]
      properties: Record<string, unknown>
    }
    expect(exported.required).toEqual(['name', 'executor', 'prompt'])
    expect(Object.keys(exported.properties)).toEqual([
      'name',
      'executor',
      'kind',
      'prompt',
      'model',
      'effort',
      'permissions',
      'no_progress_minutes',
      'creatable_by',
    ])
  })

  test('writable_paths 只属于 claude-sdk；其他执行器加载时报告字段错误', async () => {
    const home = tempHome('flow-role-writable-')
    for (const executor of ['codex-orca', 'codex-exec']) {
      writeText(
        join(home, 'config/roles', `${executor}.yaml`),
        stringify({
          ...role,
          name: executor,
          executor,
          permissions: { writable_paths: [] },
        }),
      )
    }
    const loaded = data(await loadRoles(home))
    expect(loaded.roles).toEqual([])
    expect(loaded.errors).toEqual(
      ['codex-exec', 'codex-orca'].map((executor) =>
        expect.objectContaining({
          file: `config/roles/${executor}.yaml`,
          field: 'permissions.writable_paths',
          code: 'invalid_field',
          message: '字段 permissions.writable_paths：writable_paths 仅适用于 claude-sdk 执行器',
        }),
      ),
    )
  })

  test('read_scope 只接受 cwd 且只属于 claude-sdk', async () => {
    const sdk = { ...role, executor: 'claude-sdk' }
    expect(roleSchema.safeParse({ ...sdk, permissions: { read_scope: 'cwd' } }).success).toBe(true)
    for (const read_scope of ['home', '', true, ['cwd']])
      expect(roleSchema.safeParse({ ...sdk, permissions: { read_scope } }).success).toBe(false)
    const home = tempHome('flow-role-read-scope-')
    for (const executor of ['codex-orca', 'codex-exec']) {
      writeText(
        join(home, 'config/roles', `${executor}.yaml`),
        stringify({ ...role, name: executor, executor, permissions: { read_scope: 'cwd' } }),
      )
    }
    const loaded = data(await loadRoles(home))
    expect(loaded.roles).toEqual([])
    expect(loaded.errors).toEqual(
      ['codex-exec', 'codex-orca'].map((executor) =>
        expect.objectContaining({
          file: `config/roles/${executor}.yaml`,
          field: 'permissions.read_scope',
          code: 'invalid_field',
          message: '字段 permissions.read_scope：read_scope 仅适用于 claude-sdk 执行器',
        }),
      ),
    )
  })
})

describe('creatable_by（角色创建权限）', () => {
  test('精确值、前缀通配与 *；user 永远可以创建', () => {
    expect(actorMatches('*', 'node:n1')).toBe(true)
    expect(actorMatches('node:*', 'node:n-abc')).toBe(true)
    expect(actorMatches('node:*', 'node:')).toBe(false)
    expect(actorMatches('node:*', 'remote:grok')).toBe(false)
    expect(actorMatches('node:*', 'nodex:n1')).toBe(false)
    expect(actorMatches('node:n-abc', 'node:n-abc')).toBe(true)
    expect(actorMatches('node:n-abc', 'node:n-abd')).toBe(false)
    expect(actorMatches('claude', 'Claude')).toBe(false)

    expect(canCreateRole({}, 'user')).toBe(true)
    expect(canCreateRole({ creatable_by: [] }, 'user')).toBe(true)
    expect(canCreateRole({}, 'node:n1')).toBe(false)
    expect(canCreateRole({ creatable_by: [] }, 'claude')).toBe(false)
    expect(canCreateRole({ creatable_by: ['node:*'] }, 'node:n1')).toBe(true)
    expect(canCreateRole({ creatable_by: ['node:*'] }, 'remote:grok')).toBe(false)
    expect(canCreateRole({ creatable_by: ['remote:grok'] }, 'remote:grok')).toBe(true)
    expect(canCreateRole({ creatable_by: ['*'] }, 'codex')).toBe(true)
  })

  test('schema：接受精确值与通配，拒绝不合法的模式', () => {
    const accepted = roleSchema.safeParse({
      ...role,
      creatable_by: ['user', 'node:n-abc', 'node:*', 'remote:*', '*', 'agent:claude'],
    })
    expect(accepted.success).toBe(true)
    for (const bad of ['', 'node*', ':*', 'a b', '**', 'node:**']) {
      expect(roleSchema.safeParse({ ...role, creatable_by: [bad] }).success).toBe(false)
    }
    expect(roleSchema.safeParse({ ...role, creatable_by: 'node:*' }).success).toBe(false)
  })

  test('默认模板：dev 与 pr-reviewer 为 [supervisor]，reviewer 与 triage 为 ["*"]，supervisor 与 merger 不写', async () => {
    const home = tempHome('flow-roles-')
    for (const [name, text] of Object.entries(DEFAULT_ROLE_FILES)) {
      writeText(join(home, 'config/roles', name), text)
    }
    const loaded = data(await loadRoles(home))
    expect(loaded.errors).toEqual([])
    const by = Object.fromEntries(loaded.roles.map((r) => [r.name, r.creatable_by]))
    expect(by).toEqual({
      dev: ['supervisor'],
      merger: undefined,
      'pr-reviewer': ['supervisor'],
      reviewer: ['*'],
      supervisor: undefined,
      triage: ['*'],
    })
  })
})

test('角色名只接受可声明的 AI 身份，拒绝 user、保留身份和非法格式', () => {
  for (const name of ['dev', 'reviewer', 'agent:claude']) {
    expect(roleSchema.safeParse({ ...role, name }).success).toBe(true)
  }
  for (const name of [
    'user',
    'User',
    'hub',
    'POLICY',
    'scheduler',
    'unknown',
    'node:n1',
    'NODE:n1',
    'bad name',
    'a'.repeat(65),
  ]) {
    expect(roleSchema.safeParse({ ...role, name })).toMatchObject({
      success: false,
      error: { issues: [expect.objectContaining({ path: ['name'] })] },
    })
  }
})

describe('角色有效类别（D9）', () => {
  const of = (executor: string, permissions?: Record<string, unknown>, kind?: Role['kind']) =>
    ({
      ...role,
      executor,
      ...(permissions ? { permissions } : {}),
      ...(kind ? { kind } : {}),
    }) as Role

  test('按执行器与权限推断类别', () => {
    expect(inferRoleKind(of('codex-orca'))).toBe('write')
    expect(inferRoleKind(of('codex-exec'))).toBe('read')
    expect(inferRoleKind(of('codex-exec', { sandbox: 'read-only' }))).toBe('read')
    expect(inferRoleKind(of('codex-exec', { sandbox: 'workspace-write' }))).toBe('write')
    expect(inferRoleKind(of('codex-exec', { sandbox: 'danger-full-access' }))).toBe('write')
    expect(inferRoleKind(of('pr-merge'))).toBe('merge')
    expect(inferRoleKind(of('fake'))).toBe('write')
    expect(inferRoleKind(of('gpt-cli'))).toBe('write')
    expect(inferRoleKind(of('claude-sdk'))).toBe('read')
    expect(inferRoleKind(of('claude-sdk', { allowedTools: ['Read', 'Glob', 'Grep'] }))).toBe('read')
    expect(inferRoleKind(of('claude-sdk', { permissionMode: 'plan' }))).toBe('read')
    expect(inferRoleKind(of('claude-sdk', { disallowedTools: ['Bash', 'Edit'] }))).toBe('read')
    for (const permissions of [
      { writable_paths: [] },
      { writable_paths: ['docs/**'] },
      { allowedTools: ['Edit'] },
      { allowedTools: ['Write(src/**)'] },
      { allowedTools: ['MultiEdit'] },
      { allowedTools: ['NotebookEdit'] },
      { allowedTools: ['Bash'] },
      { allowedTools: ['Read', 'Bash(gh pr view:*)'] },
      { permissionMode: 'acceptEdits' },
      { permissionMode: 'bypassPermissions' },
      { permissionMode: 'auto' },
    ]) {
      expect(inferRoleKind(of('claude-sdk', permissions))).toBe('write')
    }
  })

  test('默认 reviewer 配有 writable_paths：有效类别为 write', async () => {
    const home = tempHome('flow-roles-')
    for (const [name, text] of Object.entries(DEFAULT_ROLE_FILES)) {
      writeText(join(home, 'config/roles', name), text)
    }
    const loaded = data(await loadRoles(home))
    expect(loaded.errors).toEqual([])
    const kinds = Object.fromEntries(loaded.roles.map((r) => [r.name, effectiveRoleKind(r)]))
    expect(kinds).toEqual({
      dev: 'write',
      merger: 'merge',
      'pr-reviewer': 'read',
      reviewer: 'write',
      supervisor: 'supervisor',
      triage: 'read',
    })
    // 模板中的 supervisor 与 pr-reviewer 本身就推断为 read，声明没有放宽任何东西。
    for (const r of loaded.roles) {
      if (r.kind && r.kind !== 'supervisor') expect<string>(inferRoleKind(r)).toBe(r.kind)
    }
  })

  test('声明只能收紧：取声明与推断中更严格者', () => {
    expect(effectiveRoleKind(of('codex-orca', undefined, 'read'))).toBe('write')
    expect(effectiveRoleKind(of('claude-sdk', { writable_paths: [] }, 'read'))).toBe('write')
    expect(effectiveRoleKind(of('pr-merge', undefined, 'write'))).toBe('merge')
    expect(effectiveRoleKind(of('codex-exec', undefined, 'write'))).toBe('write')
    expect(effectiveRoleKind(of('codex-exec', undefined, 'merge'))).toBe('merge')
    expect(effectiveRoleKind(of('codex-orca', undefined, 'merge'))).toBe('merge')
    expect(effectiveRoleKind(of('claude-sdk', undefined, 'supervisor'))).toBe('supervisor')
    expect(effectiveRoleKind(of('claude-sdk', { allowedTools: ['Bash'] }, 'supervisor'))).toBe(
      'supervisor',
    )
  })

  test('kind: supervisor 只能用于 claude-sdk；未知 kind 被拒绝', () => {
    expect(
      roleSchema.safeParse({ ...role, executor: 'claude-sdk', kind: 'supervisor' }).success,
    ).toBe(true)
    for (const executor of ['codex-orca', 'codex-exec', 'pr-merge', 'fake']) {
      expect(roleSchema.safeParse({ ...role, executor, kind: 'supervisor' })).toMatchObject({
        success: false,
        error: { issues: [expect.objectContaining({ path: ['kind'] })] },
      })
    }
    expect(roleSchema.safeParse({ ...role, kind: 'admin' }).success).toBe(false)
  })

  test('supervisor 为保留 actor：名为 supervisor 但类别不是 supervisor 的角色报错', async () => {
    const sdk = { ...role, executor: 'claude-sdk' }
    expect(roleSchema.safeParse({ ...sdk, name: 'supervisor', kind: 'supervisor' }).success).toBe(
      true,
    )
    for (const bad of [
      { ...sdk, name: 'supervisor' },
      { ...sdk, name: 'supervisor', kind: 'read' },
      { ...role, name: 'supervisor', kind: 'write' },
      { ...sdk, name: 'Supervisor', kind: 'supervisor' },
      { ...sdk, name: 'SUPERVISOR' },
    ]) {
      expect(roleSchema.safeParse(bad)).toMatchObject({
        success: false,
        error: { issues: [expect.objectContaining({ path: ['name'] })] },
      })
    }
    // 其他名字的 supervisor 角色允许（唯一性由 findSupervisorRole / doctor 检查）。
    expect(roleSchema.safeParse({ ...sdk, name: 'boss', kind: 'supervisor' }).success).toBe(true)

    const home = tempHome('flow-roles-')
    writeText(
      join(home, 'config/roles/supervisor.yaml'),
      stringify({ ...role, name: 'supervisor', executor: 'codex-orca' }),
    )
    const loaded = data(await loadRoles(home))
    expect(loaded.roles).toEqual([])
    expect(loaded.errors).toEqual([
      expect.objectContaining({ file: 'config/roles/supervisor.yaml', field: 'name' }),
    ])
  })

  test('findSupervisorRole：没有返回 null，一个返回该角色，多个报 multiple_supervisor_roles', () => {
    const sup = (name: string) => ({ ...of('claude-sdk', undefined, 'supervisor'), name }) as Role
    expect(data(findSupervisorRole([of('codex-orca')]))).toBeNull()
    expect(data(findSupervisorRole([of('codex-orca'), sup('supervisor')]))?.name).toBe('supervisor')
    const r = findSupervisorRole([sup('supervisor'), sup('boss')])
    expect(r).toMatchObject({ ok: false, error: { code: 'multiple_supervisor_roles' } })
    expect(r.ok || r.error.message).toContain('supervisor、boss')
  })
})
