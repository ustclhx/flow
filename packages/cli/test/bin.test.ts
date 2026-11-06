import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 使用真实 bin 符号链接，确保 Bun 解析入口路径后仍保留别名提示。 */
test('flow bin 只增加 stderr 改名提示，JSON stdout 与退出码保持一致', () => {
  const root = mkdtempSync(join(tmpdir(), 'raindown-bin-'))
  try {
    const bin = join(root, 'flow')
    symlinkSync(new URL('../src/flow.ts', import.meta.url).pathname, bin)
    const env = { ...process.env, RAINDOWN_HOME: join(root, 'home') }
    for (const args of [
      ['--version', '--json'],
      ['unknown-command', '--json'],
    ]) {
      const current = Bun.spawnSync(
        [process.execPath, new URL('../src/main.ts', import.meta.url).pathname, ...args],
        { env },
      )
      const legacy = Bun.spawnSync([process.execPath, bin, ...args], { env })
      expect(legacy.stdout.toString()).toBe(current.stdout.toString())
      expect(current.exitCode).toBe(args[0] === '--version' ? 0 : 2)
      expect(legacy.exitCode).toBe(current.exitCode)
      expect(legacy.stderr.toString()).toBe(`flow 命令已更名为 raindown\n${current.stderr}`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
