import { expect, test } from 'bun:test'
import { loadSyncTargets } from '../src/agents-sync/targets.ts'
import { tempHome, writeEntry, writeWorkspace } from './helpers.ts'

const base = { scope: 'work', sources: ['用户确认（2026-10-24）'], last_verified: null }

test('每个产品 workspace 的每个仓库生成一个目标，只带本 workspace 拥有的资源', async () => {
  const home = tempHome()
  writeWorkspace(home, 'xuanxue-saas', {
    id: 'xuanxue-saas',
    kind: 'product',
    name: 'Xuanxue',
    description: '东西方双站',
    repos: ['/tmp/repo-xuanxue'],
  })
  writeWorkspace(home, 'radar', {
    id: 'radar',
    kind: 'function',
    name: '热点',
    description: '职能 workspace',
  })
  writeEntry(home, 'projects/xuanxue-saas', {
    ...base,
    type: 'project-card',
    title: 'Xuanxue',
    summary: '项目卡片',
    workspace: 'ws/xuanxue-saas',
    repo_paths: ['/tmp/repo-xuanxue'],
  })
  for (const [name, owner] of [
    ['arcanumber.com', 'ws/xuanxue-saas'],
    ['other.com', 'ws/global'],
  ] as const) {
    writeEntry(home, `resources/domains/${name}`, {
      ...base,
      type: 'domain',
      title: name,
      summary: `${name} 摘要`,
      owner,
      registrar: null,
      expires: null,
    })
  }

  const result = await loadSyncTargets(home)
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.data).toEqual([
    {
      workspaceId: 'ws/xuanxue-saas',
      repoPath: '/tmp/repo-xuanxue',
      input: {
        workspace: { id: 'ws/xuanxue-saas', name: 'Xuanxue', kind: 'product' },
        projectCardId: 'projects/xuanxue-saas',
        resources: [
          {
            id: 'resources/domains/arcanumber.com',
            type: 'domain',
            title: 'arcanumber.com',
            summary: 'arcanumber.com 摘要',
          },
        ],
      },
    },
  ])
})

test('存在格式错误的条目时拒绝生成目标', async () => {
  const home = tempHome()
  writeEntry(home, 'notes/bad', { type: 'note' })
  const result = await loadSyncTargets(home)
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error.code).toBe('invalid_flow_home')
})
