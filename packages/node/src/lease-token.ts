import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { raindownPaths } from '@raindown/core'

const SAFE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/
const TOKEN_FILE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.token$/
const TOKEN_DIR = 'dispatch-tokens'

/** 派工凭证存放在任务私有目录，按租约隔离；适配器只向受管 MCP 传文件路径。 */
export const leaseTokenDir = (home: string, taskId: string) =>
  join(raindownPaths(home).state, 'tasks', taskId, TOKEN_DIR)

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('派工凭证目录不是普通目录')
  await chmod(path, 0o700)
}

export async function writeLeaseTokenFile(
  home: string,
  taskId: string,
  leaseId: string,
  token: string,
): Promise<string> {
  if (!SAFE_SEGMENT.test(taskId) || !SAFE_SEGMENT.test(leaseId)) {
    throw new Error('派工凭证的任务或租约 id 不合法')
  }
  const tasks = join(raindownPaths(home).state, 'tasks')
  await privateDirectory(tasks)
  await privateDirectory(join(tasks, taskId))
  const dir = leaseTokenDir(home, taskId)
  await privateDirectory(dir)
  const path = join(dir, `${leaseId}.token`)
  // 同目录原子替换：MCP 每次读取同一路径时只会看到完整的旧 token 或新 token。
  const pending = join(dir, `${leaseId}.${randomUUID()}.token`)
  try {
    await writeFile(pending, `${token}\n`, { flag: 'wx', mode: 0o600 })
    await chmod(pending, 0o600)
    await rename(pending, path)
  } finally {
    await rm(pending, { force: true })
  }
  return path
}

export async function removeLeaseTokenFile(path: string): Promise<void> {
  await rm(path, { force: true })
}

/** 节点已持有单实例锁。只清理受管目录中的凭证文件，不递归删除任务产物或跟随符号链接。 */
export async function cleanLeaseTokenFiles(home: string): Promise<void> {
  const tasks = join(raindownPaths(home).state, 'tasks')
  const info = await lstat(tasks).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return undefined
    throw err
  })
  if (!info?.isDirectory() || info.isSymbolicLink()) return
  for (const task of await readdir(tasks, { withFileTypes: true })) {
    if (!task.isDirectory() || !SAFE_SEGMENT.test(task.name)) continue
    const dir = leaseTokenDir(home, task.name)
    const tokens = await lstat(dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return undefined
      throw err
    })
    if (!tokens?.isDirectory() || tokens.isSymbolicLink()) continue
    for (const file of await readdir(dir, { withFileTypes: true })) {
      if (TOKEN_FILE.test(file.name) && (file.isFile() || file.isSymbolicLink())) {
        await rm(join(dir, file.name), { force: true })
      }
    }
  }
}
