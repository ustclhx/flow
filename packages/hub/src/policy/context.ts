import type { PolicyContext, TaskView } from '@raindown/core'

/**
 * 登记仓库可接受的 remote 名。workspace 登记的仓库只有本地路径（`repos`），没有 remote 字段，
 * 因此缺省为 `origin`（D15："remote 名取自登记仓库，缺省 origin"）；节点核对推送地址时以同名 remote
 * 在登记仓库中的配置为准（见 `packages/node/src/push-env.ts`）。
 */
export function registeredRemotes(_task: Pick<TaskView, 'workspace'>): readonly string[] {
  return ['origin']
}

/** 节点随请求上报、只在调用方确为该任务租约持有者时才采信的字段（D15）。 */
export interface NodeReport {
  push_env_ok?: boolean | undefined
  gh_env_ok?: boolean | undefined
  command_cwd?: string | undefined
}

/**
 * `push_to`、`gh_scope` 条件的判定上下文（D15）；任何缺失的字段都使对应条件不满足。
 * - 任务分支、任务 worktree 与默认分支取自投影（`task.branch_reported` 及其登记仓库快照，只接受租约
 *   持有节点写入、一次、不可改）；默认分支不取每次请求上报的值，快照缺失即不满足；
 * - `push_env_ok`、`gh_env_ok`、`command_cwd` 只认节点上报：`trusted` 为 false
 *   （user 或其他身份、租约令牌不匹配）时一律视为缺失；
 * - realpath 在节点侧完成（`command_cwd` 与上报的 worktree 都是节点 realpath 后的路径），中枢只做
 *   字符串相等比较，不访问本机文件系统。
 */
export function policyContext(
  task: Pick<TaskView, 'workspace' | 'branch' | 'worktree' | 'repo_snapshot'>,
  report: NodeReport,
  trusted: boolean,
): PolicyContext {
  const from = trusted ? report : {}
  return {
    remotes: registeredRemotes(task),
    ...(task.branch ? { task_branch: task.branch } : {}),
    ...(task.worktree ? { task_worktree: task.worktree } : {}),
    ...(task.repo_snapshot?.default_branch
      ? { default_branch: task.repo_snapshot.default_branch }
      : {}),
    ...(from.command_cwd === undefined ? {} : { command_cwd: from.command_cwd }),
    push_env_ok: from.push_env_ok === true,
    gh_env_ok: from.gh_env_ok === true,
    realpath: (path) => path,
  }
}
