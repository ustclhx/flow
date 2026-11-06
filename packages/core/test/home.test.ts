import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { raindownHomeSource, raindownPaths, resolveRaindownHome } from '../src/home.ts'

describe('resolveRaindownHome', () => {
  test('默认位置：未设置 RAINDOWN_HOME 时使用 ~/raindown-home', () => {
    expect(resolveRaindownHome({}, '/Users/someone')).toBe('/Users/someone/raindown-home')
    expect(resolveRaindownHome({ RAINDOWN_HOME: '' }, '/Users/someone')).toBe(
      '/Users/someone/raindown-home',
    )
    expect(resolveRaindownHome({ RAINDOWN_HOME: '  ' }, '/Users/someone')).toBe(
      '/Users/someone/raindown-home',
    )
    expect(raindownHomeSource({}, '/Users/someone')).toBe('default')
  })

  test('覆盖位置：RAINDOWN_HOME 优先', () => {
    expect(resolveRaindownHome({ RAINDOWN_HOME: '/tmp/fh' }, '/Users/someone')).toBe('/tmp/fh')
    expect(resolveRaindownHome({ RAINDOWN_HOME: '~/data/fh' }, '/Users/someone')).toBe(
      '/Users/someone/data/fh',
    )
    expect(resolveRaindownHome({ RAINDOWN_HOME: 'rel/fh' }, '/Users/someone')).toBe(
      join(process.cwd(), 'rel/fh'),
    )
    expect(raindownHomeSource({ RAINDOWN_HOME: '/tmp/fh' })).toBe('RAINDOWN_HOME')
  })
})

test('raindownPaths 给出四个子目录与固定文件', () => {
  const p = raindownPaths('/x/fh')
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

const temporaryHomes: string[] = []
afterEach(() => {
  for (const home of temporaryHomes.splice(0)) rmSync(home, { recursive: true, force: true })
})

test('新环境变量优先，空白新值回退旧变量', () => {
  expect(resolveRaindownHome({ RAINDOWN_HOME: ' /new ', FLOW_HOME: '/old' })).toBe('/new')
  expect(resolveRaindownHome({ RAINDOWN_HOME: ' ', FLOW_HOME: ' ~/old ' }, '/tmp/user')).toBe(
    '/tmp/user/old',
  )
  expect(raindownHomeSource({ RAINDOWN_HOME: '', FLOW_HOME: '/old' })).toBe('FLOW_HOME')
})

test('旧默认目录存在才复用；两个目录都有时选择新默认目录', () => {
  const home = mkdtempSync(join(tmpdir(), 'raindown-home-'))
  temporaryHomes.push(home)
  expect(raindownHomeSource({}, home)).toBe('default')
  expect(resolveRaindownHome({}, home)).toBe(join(home, 'raindown-home'))
  mkdirSync(join(home, 'flow-home'))
  expect(raindownHomeSource({}, home)).toBe('legacy-default')
  expect(resolveRaindownHome({}, home)).toBe(join(home, 'flow-home'))
  mkdirSync(join(home, 'raindown-home'))
  expect(raindownHomeSource({}, home)).toBe('default')
  expect(resolveRaindownHome({}, home)).toBe(join(home, 'raindown-home'))
})
