import { chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { flowPaths } from '@flow/core'

/**
 * 唤醒绑定 token 文件（add-m1-supervisor D6；tasks 5.3）。
 *
 * 节点领到唤醒租约时把 `lease.wake_token` 写进 `state/wake/<task>.<lease_id>.token`（目录 0700、文件 0600），
 * 只把路径作为 `FLOW_HUB_TOKEN_FILE` 交给 Flow MCP 进程：token 本身不进任何进程的 argv 与 env
 * （Agent SDK 会把 MCP 配置以 `--mcp-config` 参数传给 Claude Code，`ps` 对所有用户可见）。
 * 任务结束（含失败、取消、放弃租约）时删除；节点启动时清理残留。
 * `state/` 在 flow-home 下，不在任何任务的 cwd 或私有目录中，`read_scope: cwd` 的会话读不到。
 */

/** 唤醒 token 文件目录。 */
export const wakeTokenDir = (home: string) => join(flowPaths(home).state, 'wake')

const SAFE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/

/**
 * 写入唤醒 token 文件 `state/wake/<task>.<lease_id>.token`，返回路径。按租约区分文件：同一任务重试时
 * 新旧租约各有自己的文件，旧租约收尾删除时不会删掉新租约的 token。taskId 与 leaseId 已由协议 schema
 * 校验（只含字母、数字、`_ . -`），这里再核对一次。
 */
export async function writeWakeTokenFile(
  home: string,
  taskId: string,
  leaseId: string,
  token: string,
): Promise<string> {
  for (const [what, v] of [
    ['任务 id', taskId],
    ['租约 id', leaseId],
  ] as const) {
    if (!SAFE_SEGMENT.test(v)) throw new Error(`不合法的${what}：${JSON.stringify(v)}`)
  }
  const dir = wakeTokenDir(home)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  // mkdir 的 mode 受 umask 影响，目录已存在时也不改，这里显式收紧。
  await chmod(dir, 0o700)
  const path = join(dir, `${taskId}.${leaseId}.token`)
  await rm(path, { force: true })
  await writeFile(path, `${token}\n`, { mode: 0o600, flag: 'wx' })
  await chmod(path, 0o600)
  return path
}

/** 删除唤醒 token 文件（不存在时忽略）。 */
export async function removeWakeTokenFile(path: string): Promise<void> {
  await rm(path, { force: true })
}

/** 节点启动时清理上次残留的唤醒 token 文件（上次进程被杀等）。调用方须持有节点单实例锁（`node-lock.ts`）。 */
export async function cleanWakeTokenDir(home: string): Promise<void> {
  const dir = wakeTokenDir(home)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  await Promise.all(names.map((n) => rm(join(dir, n), { force: true, recursive: true })))
}
