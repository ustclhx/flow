import { describe, expect, test } from 'bun:test'
import { fail, ok, VERSION } from '@flow/core'
import { defineCommand } from '../src/command.ts'
import { runCli } from '../src/run.ts'

const echo = defineCommand({
  name: 'kb echo',
  summary: '回显参数',
  options: { upper: { type: 'boolean' } },
  run: async ({ args, options, actor }) => {
    const text = args.join(' ')
    return ok({ text: options.upper ? text.toUpperCase() : text, actor })
  },
  human: (d) => d.text,
})
const busy = defineCommand({
  name: 'kb busy',
  summary: '模拟写锁超时',
  run: async () => fail('retryable', 'lock_timeout', '写锁被占用'),
})
const broken = defineCommand({
  name: 'kb broken',
  summary: '抛出异常',
  run: async () => {
    throw new Error('boom')
  },
})
const commands = [echo, busy, broken] as never[]

describe('runCli', () => {
  test('--version 与 --version --json', async () => {
    expect(await runCli(['--version'], commands)).toEqual({
      stdout: `${VERSION}\n`,
      stderr: '',
      exitCode: 0,
    })
    const out = await runCli(['--version', '--json'], commands)
    expect(JSON.parse(out.stdout)).toEqual({ ok: true, data: { version: VERSION } })
    expect(out.exitCode).toBe(0)
  })

  test('人类可读输出与默认 actor', async () => {
    const out = await runCli(['kb', 'echo', 'hello', '--upper'], commands)
    expect(out.stdout).toBe('HELLO\n')
    expect(out.exitCode).toBe(0)
  })

  test('--json 输出唯一 JSON 文档，并带 actor', async () => {
    const out = await runCli(['kb', 'echo', 'x', '--json', '--actor', 'codex'], commands)
    expect(JSON.parse(out.stdout)).toEqual({ ok: true, data: { text: 'x', actor: 'codex' } })
  })

  test('可重试错误退出码为 3，JSON 中标明 retryable', async () => {
    const out = await runCli(['kb', 'busy', '--json'], commands)
    expect(out.exitCode).toBe(3)
    const body = JSON.parse(out.stdout)
    expect(body.ok).toBe(false)
    expect(body.error).toMatchObject({ code: 'lock_timeout', retryable: true })
  })

  test('未知命令与未知选项为用法错误，退出码 2', async () => {
    expect((await runCli(['nope'], commands)).exitCode).toBe(2)
    expect((await runCli(['kb', 'echo', '--bogus'], commands)).exitCode).toBe(2)
  })

  test('命令抛出的异常转为失败，退出码 1', async () => {
    const out = await runCli(['kb', 'broken'], commands)
    expect(out.exitCode).toBe(1)
    expect(out.stderr).toContain('internal_error')
  })
})
