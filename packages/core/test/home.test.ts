import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { flowHomeSource, flowPaths, resolveFlowHome } from '../src/home.ts'

describe('resolveFlowHome', () => {
  test('默认位置：未设置 FLOW_HOME 时使用 ~/flow-home', () => {
    expect(resolveFlowHome({}, '/Users/someone')).toBe('/Users/someone/flow-home')
    expect(resolveFlowHome({ FLOW_HOME: '' }, '/Users/someone')).toBe('/Users/someone/flow-home')
    expect(resolveFlowHome({ FLOW_HOME: '  ' }, '/Users/someone')).toBe('/Users/someone/flow-home')
    expect(flowHomeSource({})).toBe('default')
  })

  test('覆盖位置：FLOW_HOME 优先', () => {
    expect(resolveFlowHome({ FLOW_HOME: '/tmp/fh' }, '/Users/someone')).toBe('/tmp/fh')
    expect(resolveFlowHome({ FLOW_HOME: '~/data/fh' }, '/Users/someone')).toBe(
      '/Users/someone/data/fh',
    )
    expect(resolveFlowHome({ FLOW_HOME: 'rel/fh' }, '/Users/someone')).toBe(
      join(process.cwd(), 'rel/fh'),
    )
    expect(flowHomeSource({ FLOW_HOME: '/tmp/fh' })).toBe('FLOW_HOME')
  })
})

test('flowPaths 给出四个子目录与固定文件', () => {
  const p = flowPaths('/x/fh')
  expect(p).toMatchObject({
    home: '/x/fh',
    config: '/x/fh/config',
    brain: '/x/fh/brain',
    raw: '/x/fh/raw',
    state: '/x/fh/state',
    workspaces: '/x/fh/config/workspaces',
    brainAgents: '/x/fh/brain/AGENTS.md',
    brainIndex: '/x/fh/brain/index.md',
    brainLog: '/x/fh/brain/log.md',
    journal: '/x/fh/brain/journal',
    inbox: '/x/fh/raw/inbox',
  })
})
