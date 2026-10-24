import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { execCommand, initFlowHome, ok } from '@flow/core'
import { connect } from '../../mcp/test/helpers.ts'
import { commands } from '../src/commands/index.ts'
import { createSecretsCommands, readSecretValue } from '../src/commands/secrets.ts'
import { runCli } from '../src/run.ts'

const roots: string[] = []
const savedActor = process.env.FLOW_ACTOR
afterEach(async () => {
  if (savedActor === undefined) delete process.env.FLOW_ACTOR
  else process.env.FLOW_ACTOR = savedActor
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })))
})
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'flow-secrets-cli-'))
  roots.push(root)
  const home = join(root, 'home')
  expect((await initFlowHome(home)).ok).toBe(true)
  return { home, ageKeyFile: join(root, 'age/keys.txt') }
}

describe('flow secrets', () => {
  test('AI 读取被拒绝：--actor、FLOW_ACTOR、显式 --actor user 都不能覆盖非用户身份', async () => {
    const { home, ageKeyFile } = await setup()
    let called = false
    const secretCommands = createSecretsCommands({
      home,
      ageKeyFile,
      exec: async () => {
        called = true
        throw new Error('不应解密')
      },
    })
    delete process.env.FLOW_ACTOR
    const denied = await runCli(
      ['secrets', 'get', 'telegram/bot-token', '--actor', 'codex', '--json'],
      secretCommands,
    )
    expect(JSON.parse(denied.stdout)).toMatchObject({ ok: false, error: { code: 'user_only' } })
    expect(denied.exitCode).toBe(1)
    process.env.FLOW_ACTOR = 'codex'
    for (const args of [[], ['--actor', 'user']]) {
      const out = await runCli(
        ['secrets', 'get', 'telegram/bot-token', ...args, '--json'],
        secretCommands,
      )
      expect(JSON.parse(out.stdout).error.code).toBe('user_only')
    }
    expect(called).toBe(false)
  })

  test('不接受 argv 值；先检查参数再读取 stdin，默认注册四个独立命令', async () => {
    const { home, ageKeyFile } = await setup()
    let read = false
    const secretCommands = createSecretsCommands({
      home,
      ageKeyFile,
      readValue: async () => {
        read = true
        return ok('test-value-not-a-secret-0001')
      },
    })
    for (const args of [
      [],
      ['a', 'test-value-not-a-secret-0001'],
      ['a', '--value', 'test-value-not-a-secret-0001'],
      ['a//b'],
    ]) {
      const out = await runCli(['secrets', 'set', ...args, '--json'], secretCommands)
      expect(out.exitCode).toBe(2)
    }
    expect(read).toBe(false)
    expect(commands.filter((c) => c.name.startsWith('secrets ')).map((c) => c.name)).toEqual([
      'secrets init',
      'secrets set',
      'secrets list',
      'secrets get',
    ])
  })

  test('任何 MCP 调用方都没有 secrets 工具', async () => {
    const { home } = await setup()
    const client = await connect({ home, actor: 'codex' })
    try {
      const tools = await client.listTools()
      expect(tools.tools.some((t) => /secret/i.test(t.name))).toBe(false)
      expect(
        (await client.callTool({ name: 'secrets_get', arguments: { path: 'telegram/bot-token' } }))
          .isError,
      ).toBe(true)
    } finally {
      await client.close()
    }
  })

  test('非 TTY 读到 EOF、去掉末尾换行，保留内部换行和空格', async () => {
    const input = new PassThrough()
    const result = readSecretValue(input as unknown as NodeJS.ReadStream)
    input.write(' test-value-not-a-secret-0001\n第二行 ')
    input.end('\r\n\n')
    expect(await result).toEqual(ok(' test-value-not-a-secret-0001\n第二行 '))
  })

  test('TTY 不回显，支持退格；Ctrl-C 恢复终端并取消', async () => {
    for (const cancelled of [false, true]) {
      const input = Object.assign(new PassThrough(), {
        isTTY: true,
        setRawMode: (_mode: boolean) => input,
      })
      const modes: boolean[] = []
      input.setRawMode = (mode) => {
        modes.push(mode)
        return input
      }
      const output = new PassThrough()
      let shown = ''
      output.on('data', (chunk) => {
        shown += chunk.toString()
      })
      const result = readSecretValue(
        input as unknown as NodeJS.ReadStream,
        output as unknown as NodeJS.WriteStream,
      )
      input.write('test-value-not-a-secret-0001X\u007f')
      input.write(cancelled ? '\u0003' : '\r')
      expect(await result).toEqual(
        cancelled
          ? {
              ok: false,
              error: { kind: 'failure', code: 'secret_input_cancelled', message: '已取消密钥输入' },
            }
          : ok('test-value-not-a-secret-0001'),
      )
      expect(shown).toContain('不回显')
      expect(shown).not.toContain('test-value-not-a-secret-0001')
      expect(modes.at(-1)).toBe(false)
    }
  })
})

const hasSops = (await execCommand('sops', ['--version'])).code === 0
if (!hasSops) console.info('跳过 CLI 真实 sops 测试：PATH 中未找到 sops')

test.skipIf(!hasSops)('CLI 真实 sops：初始化提示、stdin set、list 不含值、user get', async () => {
  delete process.env.FLOW_ACTOR
  const { home, ageKeyFile } = await setup()
  const value = 'test-value-not-a-secret-0001'
  const input = new PassThrough()
  input.end(`${value}\n`)
  const secretCommands = createSecretsCommands({
    home,
    ageKeyFile,
    readValue: () => readSecretValue(input as unknown as NodeJS.ReadStream),
  })
  const run = (...args: string[]) => runCli(['secrets', ...args], secretCommands)
  expect((await run('init')).stdout).toContain('离线备份')
  expect((await run('set', 'telegram/bot-token')).exitCode).toBe(0)
  const list = await run('list')
  expect(list.stdout).toBe('telegram/bot-token\n')
  expect(list.stdout).not.toContain(value)
  expect(JSON.parse((await run('list', '--json')).stdout).data).toEqual(['telegram/bot-token'])
  expect((await run('get', 'telegram/bot-token')).stdout).toBe(`${value}\n`)
  expect(JSON.parse((await run('get', 'missing', '--json')).stdout).error.code).toBe(
    'secret_not_found',
  )
  console.info('CLI 真实 sops 集成通过：init/set/list/get、默认 user 与无明文列表')
})
