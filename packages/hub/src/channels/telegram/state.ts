import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'

/**
 * 长轮询进度（telegram-channel "长轮询收取"）：`state/telegram.json` 保存下一次 getUpdates 的 offset，
 * 每处理完一条更新就原子写入（临时文件 + rename，0600），中枢重启后从下一条继续，不重复处理。
 *
 * 同时记下 bot id（token 中冒号前的数字，不是密钥）：换了另一个 bot 的 token 时，旧的 offset 没有意义，从 0 开始。
 */

const stateSchema = z.object({
  offset: z.number().int().min(0),
  bot_id: z.number().int().positive().nullable().default(null),
})
export type TelegramState = z.infer<typeof stateSchema>

export async function loadTelegramState(path: string): Promise<TelegramState> {
  try {
    const parsed = stateSchema.safeParse(JSON.parse(await readFile(path, 'utf8')))
    if (parsed.success) return parsed.data
  } catch {
    /* 不存在或损坏：从头开始 */
  }
  return { offset: 0, bot_id: null }
}

export async function saveTelegramState(path: string, state: TelegramState): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: 'wx' })
    await rename(tmp, path)
  } finally {
    await unlink(tmp).catch(() => {})
  }
}

/** token 中冒号前的 bot id；格式不对时为 null。 */
export function botIdOf(token: string): number | null {
  const m = /^(\d{1,20}):/.exec(token)
  if (!m?.[1]) return null
  const id = Number(m[1])
  return Number.isSafeInteger(id) && id > 0 ? id : null
}
