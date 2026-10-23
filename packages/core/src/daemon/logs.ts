import { rename, rm, stat } from 'node:fs/promises'
import { fail, ok, type Result } from '../result.ts'

/** 启动时轮转：保留 keep 份归档，大小等于阈值时不轮转；缺少日志是正常情况。 */
export async function rotateLog(
  path: string,
  { maxBytes = 10 * 1024 * 1024, keep = 3 }: { maxBytes?: number; keep?: number } = {},
): Promise<Result<boolean>> {
  try {
    let size: number
    try {
      size = (await stat(path)).size
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ok(false)
      throw err
    }
    if (size <= maxBytes) return ok(false)
    await rm(`${path}.${keep}`, { force: true })
    for (let i = keep - 1; i >= 0; i--) {
      try {
        await rename(i === 0 ? path : `${path}.${i}`, `${path}.${i + 1}`)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
    }
    return ok(true)
  } catch (err) {
    return fail('failure', 'log_rotation_failed', `无法轮转 ${path}：${(err as Error).message}`)
  }
}
