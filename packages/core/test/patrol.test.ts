import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import {
  runDoctor as actualDoctor,
  checkPatrolRules,
  type DoctorReport,
  git,
  initFlowHome,
  loadSchedulesConfig,
  SUPERVISOR_PATROL_KIND,
  scheduleRuleSchema,
} from '../src/index.ts'
import { SCHEDULES_YAML } from '../src/templates.ts'
import { doctorOptions } from './doctor-helpers.ts'
import { tempHome, writeText } from './helpers.ts'

/** 巡检（add-m1-supervisor D13；tasks 6.2）：init 生成注释掉的示例、doctor 提示缺少巡检规则。 */

const init = async (home: string) => {
  const r = await initFlowHome(home)
  if (!r.ok) throw new Error(r.error.message)
  return r.data
}

/** 登记一个带仓库的 workspace（仓库目录只需存在）。 */
function workspace(home: string, id: string, extra = '') {
  const repo = mkdtempSync(join(tmpdir(), 'flow-patrol-repo-'))
  writeText(
    join(home, 'config/workspaces', `${id}.yaml`),
    `id: ${id}\nkind: product\nname: ${id}\ndescription: 测试\nrepos:\n  - ${repo}\n${extra}`,
  )
  return repo
}

describe('flow init 的巡检示例（D13）', () => {
  test('模板全部注释掉；取消注释并换成实际 workspace 后是一条合法的巡检规则', () => {
    expect(parse(SCHEDULES_YAML)).toBeNull()
    const lines = SCHEDULES_YAML.split('\n')
      .filter((l) => l.startsWith('# '))
      .map((l) => l.slice(2))
    const rules = parse(
      lines.join('\n').replaceAll('ws/<id>', 'ws/product-res').replaceAll('<id>', 'product-res'),
    ) as unknown[]
    expect(rules).toHaveLength(1)
    const rule = scheduleRuleSchema.parse(rules[0])
    expect(rule).toEqual({
      id: 'patrol-product-res',
      cron: '0 9 * * *',
      workspace: 'ws/product-res',
      payload: { kind: SUPERVISOR_PATROL_KIND },
    })
  })

  test('新 home 生成 config/schedules.yaml 并提交；默认不启用任何规则', async () => {
    const home = tempHome('flow-patrol-init-')
    await init(home)
    expect(readFileSync(join(home, 'config/schedules.yaml'), 'utf8')).toBe(SCHEDULES_YAML)
    const files = (await git(join(home, 'config'), ['ls-files'])).stdout.split('\n')
    expect(files).toContain('schedules.yaml')
    const loaded = await loadSchedulesConfig(home)
    expect(loaded.ok && loaded.data).toEqual({ rules: [], errors: [] })
    rmSync(join(home, '..'), { recursive: true, force: true })
  })

  test('已有 schedules.yaml 不覆盖；缺失时补齐', async () => {
    const home = tempHome('flow-patrol-init-')
    await init(home)
    const mine = '- id: mine\n  cron: "0 8 * * *"\n  workspace: ws/global\n'
    writeFileSync(join(home, 'config/schedules.yaml'), mine)
    const again = await init(home)
    expect(again.created).not.toContain('config/schedules.yaml')
    expect(readFileSync(join(home, 'config/schedules.yaml'), 'utf8')).toBe(mine)
    rmSync(join(home, 'config/schedules.yaml'))
    const restored = await init(home)
    expect(restored.created).toContain('config/schedules.yaml')
    expect(readFileSync(join(home, 'config/schedules.yaml'), 'utf8')).toBe(SCHEDULES_YAML)
    rmSync(join(home, '..'), { recursive: true, force: true })
  })
})

describe('doctor：启用 supervisor 却没有巡检规则（D13）', () => {
  test('有仓库、启用、没有巡检规则的 workspace 给 info；有规则、未启用、无仓库、global 不提示', async () => {
    const home = tempHome('flow-patrol-doctor-')
    await init(home)
    const repos = [
      workspace(home, 'none'),
      workspace(home, 'patrolled'),
      workspace(home, 'off', 'supervisor:\n  enabled: false\n'),
      workspace(home, 'other-kind'),
    ]
    writeText(
      join(home, 'config/workspaces/norepo.yaml'),
      'id: norepo\nkind: product\nname: norepo\ndescription: 测试\nrepos: []\n',
    )
    writeFileSync(
      join(home, 'config/schedules.yaml'),
      [
        '- id: patrol-patrolled',
        '  cron: "0 9 * * *"',
        '  workspace: ws/patrolled',
        '  payload:',
        '    kind: supervisor_patrol',
        '- id: other',
        '  cron: "0 9 * * *"',
        '  workspace: ws/other-kind',
        '  payload:',
        '    kind: something_else',
        '',
      ].join('\n'),
    )
    const r = await actualDoctor(home, 'FLOW_HOME', doctorOptions(home))
    const report = r.ok ? r.data : (r.error.details as DoctorReport)
    const find = (id: string) => report.checks.find((c) => c.id === id)
    expect(find('workspace.none.supervisor_patrol')).toMatchObject({ ok: false, severity: 'info' })
    expect(find('workspace.none.supervisor_patrol')?.message).toContain('没有巡检规则')
    expect(find('workspace.none.supervisor_patrol')?.hint).toContain('supervisor_patrol')
    expect(find('workspace.other-kind.supervisor_patrol')).toMatchObject({ severity: 'info' })
    expect(find('workspace.patrolled.supervisor_patrol')).toBeUndefined()
    expect(find('workspace.off.supervisor_patrol')).toBeUndefined()
    expect(find('workspace.norepo.supervisor_patrol')).toBeUndefined()
    expect(find('workspace.global.supervisor_patrol')).toBeUndefined()
    for (const repo of repos) rmSync(repo, { recursive: true, force: true })
    rmSync(join(home, '..'), { recursive: true, force: true })
  })

  test('没有 supervisor 角色或 schedules.yaml 读不出来时不提示', async () => {
    const home = tempHome('flow-patrol-doctor-')
    await init(home)
    const repo = workspace(home, 'none')
    expect(await checkPatrolRules(home, [])).toEqual([])
    writeFileSync(join(home, 'config/schedules.yaml'), 'a: [')
    expect(await checkPatrolRules(home)).toEqual([])
    rmSync(join(home, 'config/schedules.yaml'))
    expect((await checkPatrolRules(home)).map((c) => c.id)).toEqual([
      'workspace.none.supervisor_patrol',
    ])
    rmSync(repo, { recursive: true, force: true })
    rmSync(join(home, '..'), { recursive: true, force: true })
  })
})
