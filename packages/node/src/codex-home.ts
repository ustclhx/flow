import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fail, ok, type Result, raindownPaths } from '@raindown/core'

/** 读任务继续使用原目录，保留已有会话以便恢复。 */
export const readCodexHome = (home: string) => join(raindownPaths(home).state, 'codex-read-home')

/**
 * 写任务与交互式 Codex 共用固定目录以便恢复会话；并发任务由独立 session 区分，
 * 无需再按角色划分目录，避免角色变化后丢失会话。
 */
export const workCodexHome = (home: string) => join(raindownPaths(home).state, 'codex-work-home')

const HOME_CONFIG = `# 由 Raindown 生成，每次启动 Codex 前覆盖。
# 不含 MCP、notify、hooks 与项目信任记录，角色设置由 permissions.config 经 -c 传入。
`

// 隔离目录由 Raindown 管理，不加载用户级扩展；尤其不能保留审批后积累的 allow 规则。
const HOME_EXTENSIONS = [
  'rules',
  'hooks.json',
  'AGENTS.md',
  'AGENTS.override.md',
  'skills',
  'plugins',
]

const bad = (message: string) => fail('failure', 'codex_home_failed', message)
const missing = (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOENT'

async function sameRealPath(a: string, b: string): Promise<boolean> {
  try {
    return (await realpath(a)) === (await realpath(b))
  } catch (err) {
    if (missing(err)) return false
    throw err
  }
}

/**
 * 实测 Codex 0.164：-c mcp_servers={} 与用户配置的表合并，无法清空已有 MCP；因此必须隔离整个目录。
 * 只从用户目录链接 auth.json；配置与扩展始终由 Raindown 控制，会话等运行状态保留。
 * Codex 若把 auth.json 链接替换成普通文件，保留该文件并拒绝启动，避免丢失刷新后的凭证。
 */
export async function prepareCodexHome(dir: string, authSource: string): Promise<Result<string>> {
  try {
    // 先拒绝根目录链接和认证来源别名，任何清理均不能影响用户自己的 CODEX_HOME。
    try {
      const stat = await lstat(dir)
      if (stat.isSymbolicLink() || !stat.isDirectory())
        return bad(`${dir} 必须是 Raindown 管理的普通目录，不能是符号链接或文件`)
    } catch (err) {
      if (!missing(err)) throw err
    }
    if (resolve(authSource) === resolve(dir) || (await sameRealPath(authSource, dir)))
      return bad(`CODEX_HOME（${authSource}）指向隔离目录 ${dir}，请改回用户自己的 Codex 目录`)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    // mkdir 后再次检查，避免使用刚被替换成链接的目录。
    const stat = await lstat(dir)
    if (stat.isSymbolicLink() || !stat.isDirectory())
      return bad(`${dir} 必须是 Raindown 管理的普通目录，不能是符号链接或文件`)

    const link = join(dir, 'auth.json')
    const target = join(resolve(authSource), 'auth.json')
    // 使用临时文件再原子替换，不跟随旧 config.toml 符号链接写入用户配置。
    const config = join(dir, 'config.toml')
    const configTmp = `${config}.${randomBytes(8).toString('hex')}.tmp`
    try {
      await writeFile(configTmp, HOME_CONFIG, { mode: 0o600, flag: 'wx' })
      await rename(configTmp, config)
    } finally {
      await rm(configTmp, { force: true })
    }
    // rm 不跟随符号链接，旧扩展即使链接到用户目录也只删除链接本身。
    for (const extension of HOME_EXTENSIONS)
      await rm(join(dir, extension), { recursive: true, force: true })

    // 清理可能耗时；结束后再检查凭证，保留并发 worker 刚刷新的普通文件。
    let current: string | undefined
    try {
      const authStat = await lstat(link)
      if (!authStat.isSymbolicLink())
        return bad(
          `${link} 是普通文件而不是指向 ${target} 的符号链接（可能是 Codex 刷新凭证时写入的）。请确认后把它合并回 ${target} 再删除，或直接删除后重新运行`,
        )
      current = await readlink(link)
    } catch (err) {
      if (!missing(err)) throw err
    }

    if (!existsSync(target)) {
      if (current !== undefined) await rm(link, { force: true })
      return ok(dir)
    }
    if (current === target) return ok(dir)
    // 先创建临时链接再原子替换，避免切换来源时出现没有 auth.json 的窗口。
    const authTmp = `${link}.${randomBytes(8).toString('hex')}.tmp`
    try {
      await symlink(target, authTmp)
      await rename(authTmp, link)
    } finally {
      await rm(authTmp, { force: true })
    }
    return ok(dir)
  } catch (err) {
    return bad(`无法准备 Codex 的 CODEX_HOME：${(err as Error).message}`)
  }
}
