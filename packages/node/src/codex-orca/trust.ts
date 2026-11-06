import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { fail, ok, type Result } from '@raindown/core'

/** 防止 Codex 回溯祖先项目或激活项目配置；只检查文件元信息。 */
export async function checkProjectCodexTrust(worktree: string): Promise<Result<void>> {
  const git = join(worktree, '.git')
  try {
    const stat = await lstat(git)
    if (!stat.isFile() && !stat.isDirectory())
      return fail(
        'failure',
        'worktree_git_missing',
        `${git} 必须是普通文件或目录，拒绝启动或恢复 Codex`,
      )
  } catch (err) {
    return fail(
      'failure',
      'worktree_git_missing',
      `无法确认 worktree 的 Git 标记 ${git} 存在，Codex 可能向上加载祖先仓库配置，拒绝启动或恢复：${(err as Error).message}`,
    )
  }
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
