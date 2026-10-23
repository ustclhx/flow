import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BEGIN_MARKER, ok, type SyncTarget } from '@flow/core'
import { createAgentsSyncCommand } from '../src/commands/agents-sync.ts'
import { commands } from '../src/commands/index.ts'
import { runCli } from '../src/run.ts'

describe('agents sync CLI', () => {
  let root: string
  let previousFlowHome: string | undefined

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'flow-agents-cli-'))
    previousFlowHome = process.env.FLOW_HOME
    process.env.FLOW_HOME = join(root, 'flow-home')
  })

  afterEach(async () => {
    if (previousFlowHome === undefined) delete process.env.FLOW_HOME
    else process.env.FLOW_HOME = previousFlowHome
    await rm(root, { recursive: true, force: true })
  })

  async function repository(name: string, content: string | null): Promise<SyncTarget> {
    const repoPath = join(root, name)
    await mkdir(repoPath)
    if (content !== null) await writeFile(join(repoPath, 'AGENTS.md'), content)
    return {
      workspaceId: 'ws/demo',
      repoPath,
      input: {
        workspace: { id: 'ws/demo', name: '演示', kind: 'product' },
        projectCardId: null,
        resources: [],
      },
    }
  }

  test('--check --json 过时时退出码 1，JSON 包含稳定错误结构与逐仓库报告', async () => {
    const target = await repository('stale', '# 项目约定\n')
    const command = createAgentsSyncCommand(async () => ok([target]))
    const output = await runCli(['agents', 'sync', '--check', '--json'], [command])
    expect(output.exitCode).toBe(1)
    expect(output.stderr).toBe('')
    expect(JSON.parse(output.stdout)).toEqual({
      ok: false,
      error: {
        kind: 'failure',
        code: 'agents_stale',
        message: 'AGENTS.md 受管区块已过时、缺失或标记损坏',
        retryable: false,
        details: {
          repositories: [{ workspaceId: 'ws/demo', repoPath: target.repoPath, status: 'stale' }],
        },
      },
    })
    expect(await readFile(join(target.repoPath, 'AGENTS.md'), 'utf8')).toBe('# 项目约定\n')
  })

  test('--check --json 缺少文件时报告 created 且不创建文件', async () => {
    const target = await repository('missing', null)
    const output = await runCli(
      ['agents', 'sync', '--check', '--json'],
      [createAgentsSyncCommand(async () => ok([target]))],
    )
    expect(output.exitCode).toBe(1)
    expect(JSON.parse(output.stdout).error.details.repositories).toEqual([
      { workspaceId: 'ws/demo', repoPath: target.repoPath, status: 'created' },
    ])
    expect(await readdir(target.repoPath)).toEqual([])
  })

  test('人类可读输出逐仓库列出状态，修改后提醒提交，重复运行不提醒', async () => {
    const updated = await repository('updated', '# 原文')
    const created = await repository('created', null)
    const command = createAgentsSyncCommand(async () => ok([updated, created]))
    const first = await runCli(['agents', 'sync'], [command])
    expect(first).toEqual({
      stdout: `updated  ${updated.repoPath}\ncreated  ${created.repoPath}\n请审阅后在对应仓库提交 AGENTS.md\n`,
      stderr: '',
      exitCode: 0,
    })
    const second = await runCli(['agents', 'sync'], [command])
    expect(second.stdout).toBe(`unchanged  ${updated.repoPath}\nunchanged  ${created.repoPath}\n`)
    expect(second.exitCode).toBe(0)
    const check = await runCli(['agents', 'sync', '--check', '--json'], [command])
    expect(check.exitCode).toBe(0)
    expect(JSON.parse(check.stdout)).toEqual({
      ok: true,
      data: {
        repositories: [updated, created].map((target) => ({
          workspaceId: target.workspaceId,
          repoPath: target.repoPath,
          status: 'unchanged',
        })),
      },
    })
  })

  test('check 失败时人类可读输出仍逐仓库列出 stale 与 corrupt', async () => {
    const stale = await repository('stale', '# 项目')
    const corrupt = await repository('corrupt', BEGIN_MARKER)
    const output = await runCli(
      ['agents', 'sync', '--check'],
      [createAgentsSyncCommand(async () => ok([stale, corrupt]))],
    )
    expect(output.stdout).toBe(`stale  ${stale.repoPath}\ncorrupt  ${corrupt.repoPath}\n`)
    expect(output.stderr).toContain('error[agents_stale]')
    expect(output.stderr).toContain('缺少 END 标记')
    expect(output.exitCode).toBe(1)
  })

  test('部分更新失败时仍输出完成的仓库与提交提醒，并显示损坏原因', async () => {
    const corrupt = await repository('corrupt', BEGIN_MARKER)
    const updated = await repository('updated', '# 项目')
    const output = await runCli(
      ['agents', 'sync'],
      [createAgentsSyncCommand(async () => ok([corrupt, updated]))],
    )
    expect(output.stdout).toBe(
      `corrupt  ${corrupt.repoPath}\nupdated  ${updated.repoPath}\n请审阅后在对应仓库提交 AGENTS.md\n`,
    )
    expect(output.stderr).toContain('缺少 END 标记')
    expect(output.exitCode).toBe(1)
  })

  test('默认命令已注册并读取 FLOW_HOME：未初始化时返回 not_initialized', async () => {
    const prev = process.env.FLOW_HOME
    process.env.FLOW_HOME = join(mkdtempSync(join(tmpdir(), 'flow-cli-sync-')), 'home')
    try {
      const output = await runCli(['agents', 'sync', '--json'], commands)
      expect(output.exitCode).toBe(1)
      expect(JSON.parse(output.stdout).error.code).toBe('not_initialized')
    } finally {
      if (prev === undefined) delete process.env.FLOW_HOME
      else process.env.FLOW_HOME = prev
    }
  })

  test('多余位置参数返回用法错误且不调用 loader', async () => {
    let called = false
    const output = await runCli(
      ['agents', 'sync', 'extra', '--json'],
      [
        createAgentsSyncCommand(async () => {
          called = true
          return ok([])
        }),
      ],
    )
    expect(output.exitCode).toBe(2)
    expect(JSON.parse(output.stdout).error.code).toBe('invalid_arguments')
    expect(called).toBe(false)
  })
})
