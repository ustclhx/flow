import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_ROLE_FILES } from '../../core/src/role-templates.ts'
import {
  CLAUDE_SDK_KNOWN_PERMISSION_KEYS,
  effectiveRoleKind,
  inferRoleKind,
  loadRoles,
} from '../../core/src/roles.ts'
import { claudeSdkPermissions } from '../src/claude-sdk.ts'

test('core 推断认识的 claude-sdk 权限键与节点 claudeSdkPermissions 的字段一致', () => {
  expect<string[]>([...CLAUDE_SDK_KNOWN_PERMISSION_KEYS].sort()).toEqual(
    Object.keys(claudeSdkPermissions.shape).sort(),
  )
})

test('模板 supervisor、pr-reviewer（及全部 claude-sdk 模板）能通过节点 claudeSdkPermissions 校验', async () => {
  const home = mkdtempSync(join(tmpdir(), 'flow-role-templates-'))
  const dir = join(home, 'config', 'roles')
  mkdirSync(dir, { recursive: true })
  for (const [name, text] of Object.entries(DEFAULT_ROLE_FILES))
    writeFileSync(join(dir, name), text)
  const loaded = await loadRoles(home)
  rmSync(home, { recursive: true, force: true })
  if (!loaded.ok) throw new Error(loaded.error.message)
  expect(loaded.data.errors).toEqual([])
  const claude = loaded.data.roles.filter((role) => role.executor === 'claude-sdk')
  expect(claude.map((r) => r.name).sort()).toEqual(['pr-reviewer', 'reviewer', 'supervisor'])
  for (const role of claude) {
    const parsed = claudeSdkPermissions.safeParse(role.permissions ?? {})
    expect(parsed.error?.issues ?? []).toEqual([])
  }
  const byName = Object.fromEntries(claude.map((r) => [r.name, r]))
  for (const name of ['supervisor', 'pr-reviewer']) {
    const role = byName[name]
    if (!role) throw new Error(`缺少模板 ${name}`)
    expect(claudeSdkPermissions.parse(role.permissions).read_scope).toBe('cwd')
    expect(inferRoleKind(role)).toBe('read')
  }
  expect(byName.supervisor && effectiveRoleKind(byName.supervisor)).toBe('supervisor')
})
