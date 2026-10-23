import { randomBytes } from 'node:crypto'
import { chmod, link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { fail, flowPaths, ok, type Result } from '@flow/core'
import { z } from 'zod'

const tokenSchema = z
  .string()
  .min(43)
  .regex(/^[A-Za-z0-9_-]+$/)

/** 先完整写入 0600 临时文件，再原子发布，兼容同时进行的首次初始化。 */
export async function ensureHubToken(home: string): Promise<Result<string>> {
  const { state, hubToken: path } = flowPaths(home)
  try {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      await mkdir(state, { recursive: true })
      const tmp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
      await writeFile(tmp, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 })
      try {
        await link(tmp, path)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      } finally {
        await unlink(tmp)
      }
      text = await readFile(path, 'utf8')
    }
    await chmod(path, 0o600)
    const token = tokenSchema.safeParse(text.trim())
    if (!token.success) return fail('failure', 'invalid_hub_token', '中枢 token 文件格式不合法')
    return ok(token.data)
  } catch (err) {
    return fail(
      'failure',
      'hub_token_failed',
      `无法读取或创建中枢 token：${(err as Error).message}`,
    )
  }
}
