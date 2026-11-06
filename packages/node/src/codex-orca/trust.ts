import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { fail, ok, type Result } from '@raindown/core'

/** 信任会激活项目配置；启动、恢复及确认弹窗前都检查，不读取或删除项目文件。 */
export async function checkProjectCodexTrust(worktree: string): Promise<Result<void>> {
  const path = join(worktree, '.codex')
  try {
    // lstat 同样拒绝文件和悬空链接，不能用 existsSync 跳过悬空链接。
    await lstat(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ok(undefined)
    return fail(
      'failure',
      'project_codex_config',
      `无法确认项目配置 ${path} 不存在，拒绝自动信任或恢复 Codex：${(err as Error).message}。请用户检查后重试`,
    )
  }
  return fail(
    'failure',
    'project_codex_config',
    `发现项目配置 ${path}，信任后可能加载 rules、mcp_servers、hooks 或 notify，绕过 Raindown 授权。拒绝自动信任或恢复 Codex，请用户检查并移出该目录后重试`,
  )
}
