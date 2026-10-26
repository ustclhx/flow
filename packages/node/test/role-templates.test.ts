import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_ROLE_FILES } from '../../core/src/role-templates.ts'
import {
  CLAUDE_SDK_KNOWN_PERMISSION_KEYS,
  CODEX_EXEC_KNOWN_PERMISSION_KEYS,
  effectiveRoleKind,
  inferRoleKind,
  loadRoles,
} from '../../core/src/roles.ts'
import { claudeSdkPermissions } from '../src/claude-sdk.ts'
import { CODEX_EXEC_REJECTED_PERMISSION_KEYS, codexExecPermissions } from '../src/codex-exec.ts'

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

test('core 推断认识的 codex-exec 权限键与节点 codexExecPermissions 可用的字段一致（防漂移）', () => {
  const rejected: readonly string[] = CODEX_EXEC_REJECTED_PERMISSION_KEYS
  const usable = Object.keys(codexExecPermissions.shape).filter((k) => !rejected.includes(k))
  expect<string[]>([...CODEX_EXEC_KNOWN_PERMISSION_KEYS].sort()).toEqual(usable.sort())
  // 被拒绝的键写任何值都校验失败；core 不认识它们，推断为 write（方向保守）。
  for (const key of rejected) {
    for (const value of [[], 'cwd', ['docs/**'], true])
      expect(codexExecPermissions.safeParse({ [key]: value }).success).toBe(false)
    expect(inferRoleKind({ executor: 'codex-exec', permissions: { [key]: 'cwd' } })).toBe('write')
  }
  // 白名单之外的任何键都会被节点拒绝（strictObject），与 core 推断为 write 一致。
  expect(codexExecPermissions.safeParse({ approval: 'never' }).success).toBe(false)
})
