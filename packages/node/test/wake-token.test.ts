import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cleanWakeTokenDir,
  removeWakeTokenFile,
  wakeTokenDir,
  writeWakeTokenFile,
} from '../src/index.ts'

/** add-m1-supervisor 5.3：唤醒 token 文件（0700 目录、0600 文件、删除与启动清理）。 */

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})
const home = () => {
  const r = mkdtempSync(join(tmpdir(), 'flow-wake-file-'))
  roots.push(r)
  return join(r, 'flow-home')
}

describe('唤醒 token 文件', () => {
  test('写入 state/wake/<task>.<lease_id>.token：目录 0700、文件 0600；删除后不存在', async () => {
    const h = home()
    const token = `fwk_${'a'.repeat(43)}`
    const path = await writeWakeTokenFile(h, 't-1', 'l-1', token)
    expect(path).toBe(join(h, 'state', 'wake', 't-1.l-1.token'))
    expect(statSync(wakeTokenDir(h)).mode & 0o777).toBe(0o700)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readFileSync(path, 'utf8').trim()).toBe(token)
    // 同一租约再次写入时覆盖。
    await writeWakeTokenFile(h, 't-1', 'l-1', `fwk_${'b'.repeat(43)}`)
    expect(readFileSync(path, 'utf8')).toContain('bbbb')
    // 同一任务的新租约（重试）写自己的文件：旧租约收尾删除不影响新租约。
    const next = await writeWakeTokenFile(h, 't-1', 'l-2', `fwk_${'c'.repeat(43)}`)
    expect(next).not.toBe(path)
    await removeWakeTokenFile(path)
    expect(existsSync(path)).toBe(false)
    expect(readFileSync(next, 'utf8')).toContain('cccc')
    await removeWakeTokenFile(path)
  })

  test('不合法的任务 id 或租约 id 拒绝写入', async () => {
    const h = home()
    for (const id of ['../x', '.hidden', 'a/b', '']) {
      await expect(writeWakeTokenFile(h, id, 'l-1', 'x')).rejects.toThrow()
      await expect(writeWakeTokenFile(h, 't-1', id, 'x')).rejects.toThrow()
    }
  })

  test('启动清理：删除全部残留文件，目录不存在时不报错', async () => {
    const h = home()
    await cleanWakeTokenDir(h)
    const a = await writeWakeTokenFile(h, 't-a', 'l-a', 'x')
    writeFileSync(join(wakeTokenDir(h), 'junk'), 'y')
    await cleanWakeTokenDir(h)
    expect(existsSync(a)).toBe(false)
    expect(existsSync(join(wakeTokenDir(h), 'junk'))).toBe(false)
  })
})
