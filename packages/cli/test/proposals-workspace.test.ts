import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { renderEntry } from '@flow/core'
import { initTempHome, writeText } from '../../core/test/helpers.ts'
import { commands } from '../src/commands/index.ts'
import { runCli } from '../src/run.ts'

setDefaultTimeout(20_000)

describe('提案与 workspace 自动生成的 CLI', () => {
  let home: string
  let previous: string | undefined
  beforeEach(async () => {
    home = await initTempHome('flow-proposals-cli-')
    previous = process.env.FLOW_HOME
    process.env.FLOW_HOME = home
  })
  afterEach(() => {
    if (previous === undefined) delete process.env.FLOW_HOME
    else process.env.FLOW_HOME = previous
    rmSync(join(home, '..'), { recursive: true, force: true })
  })

  const draft = (title: string) =>
    renderEntry({
      type: 'domain',
      title,
      summary: '测试域名',
      scope: 'work',
      owner: 'ws/xuanxue-saas',
      registrar: null,
      expires: null,
      sources: ['repo:wrangler.jsonc'],
    })

  test('propose --file、list、diff、accept --all、ws resources 与 transfer 的 JSON 契约', async () => {
    const file = join(home, 'draft.md')
    writeText(file, draft('ganjiday.com'))
    const proposed = await runCli(
      [
        'kb',
        'propose',
        'domains/ganjiday.com',
        '--file',
        file,
        '--reason',
        '核实',
        '--actor',
        'claude',
        '--json',
      ],
      commands,
    )
    expect(proposed.exitCode).toBe(0)
    const proposal = JSON.parse(proposed.stdout).data
    expect(proposal.base_hash).toBeNull()
    const listed = await runCli(['kb', 'proposals', 'list', '--json'], commands)
    expect(JSON.parse(listed.stdout).data.proposals[0].id).toBe(proposal.id)
    const diff = await runCli(['kb', 'proposals', 'diff', proposal.id], commands)
    expect(diff.stdout).toContain('+++ b/domains/ganjiday.com.md')
    const accepted = await runCli(['kb', 'proposals', 'accept', '--all', '--json'], commands)
    expect(accepted.exitCode).toBe(0)
    expect(JSON.parse(accepted.stdout).data.results).toEqual([
      { id: proposal.id, status: 'accepted' },
    ])
    const resources = await runCli(
      ['ws', 'resources', 'xuanxue-saas', '--type', 'domain', '--json'],
      commands,
    )
    expect(JSON.parse(resources.stdout).data.resources[0]).toMatchObject({
      id: 'domains/ganjiday.com',
      type: 'domain',
      title: 'ganjiday.com',
    })
    const transferred = await runCli(
      ['resource', 'transfer', 'domains/ganjiday.com', 'product-res', '--json'],
      commands,
    )
    expect(transferred.exitCode).toBe(0)
    expect(JSON.parse(transferred.stdout).data.owner).toBe('ws/product-res')
  })

  test('reject 多个 id 和 reason 经同一操作实现，AI 权限拒绝的退出码为 1', async () => {
    const ids: string[] = []
    for (const target of ['domains/a', 'domains/b']) {
      const r = await runCli(
        ['kb', 'propose', target, `--content=${draft(target)}`, '--reason', 'r', '--json'],
        commands,
      )
      expect(r.exitCode).toBe(0)
      ids.push(JSON.parse(r.stdout).data.id)
    }
    for (const command of [
      ['kb', 'proposals', 'accept', '--all'],
      ['kb', 'proposals', 'reject', '--all'],
      ['resource', 'transfer', 'domains/a', 'product-res'],
    ]) {
      const r = await runCli([...command, '--actor', 'codex', '--json'], commands)
      expect(r.exitCode).toBe(1)
      expect(JSON.parse(r.stdout).error.code).toBe('user_only')
    }
    const rejected = await runCli(
      ['kb', 'proposals', 'reject', ...ids, '--reason', '需要更多依据', '--json'],
      commands,
    )
    expect(rejected.exitCode).toBe(0)
    expect(
      JSON.parse(rejected.stdout).data.results.map((r: { status: string }) => r.status),
    ).toEqual(['rejected', 'rejected'])
    for (const id of ids)
      expect(
        JSON.parse(readFileSync(join(home, 'state/proposals/rejected', `${id}.json`), 'utf8'))
          .reason,
      ).toBe('需要更多依据')
  })

  test('ws list 与 brief --budget 的输出；human 直接打印 Markdown', async () => {
    const listed = await runCli(['ws', 'list', '--json'], commands)
    expect(JSON.parse(listed.stdout).data.workspaces).toHaveLength(3)
    const brief = await runCli(
      ['ws', 'brief', 'xuanxue-saas', '--budget', '64', '--json'],
      commands,
    )
    expect(brief.exitCode).toBe(0)
    const result = JSON.parse(brief.stdout).data
    expect(result.workspace).toBe('ws/xuanxue-saas')
    expect(result.text.length).toBeLessThanOrEqual(64)
    const human = await runCli(['ws', 'brief', 'xuanxue-saas', '--budget', '64'], commands)
    expect(human.stdout.trim()).toBe(result.text.trim())
  })
})
