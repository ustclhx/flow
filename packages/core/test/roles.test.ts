import { describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { exitCodeOf, type Result } from '../src/result.ts'
import { loadRoles, roleSchema } from '../src/roles.ts'
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

  test('引用 Markdown 提示词：读取同目录文件，不存在时保留内联文本', async () => {
    const home = tempHome('flow-roles-')
    const prompt = '# 开发角色\n完成任务并运行验收。\n'
    writeText(join(home, 'config/roles/dev.yaml'), stringify({ ...role, prompt: 'dev.md' }))
    writeText(join(home, 'config/roles/dev.md'), prompt)
    writeText(
      join(home, 'config/roles/triage.yaml'),
      stringify({ ...role, name: 'triage', prompt: 'missing.md' }),
    )
    expect(data(await loadRoles(home))).toEqual({
      roles: [
        { ...role, prompt },
        { ...role, name: 'triage', prompt: 'missing.md' },
      ],
      errors: [],
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
    const exported = jsonSchemas()['config/role.schema.json'] as {
      required: string[]
      properties: Record<string, unknown>
    }
    expect(exported.required).toEqual(['name', 'executor', 'prompt'])
    expect(Object.keys(exported.properties)).toEqual([
      'name',
      'executor',
      'prompt',
      'model',
      'effort',
      'permissions',
      'no_progress_minutes',
    ])
  })
})
