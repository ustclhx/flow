import { z } from 'zod'

/**
 * workspace 配置中的 `github` 一节（add-harness-neutral-coordination D11；tasks 8.2）。
 *
 * - `watch`：是否由中枢的 pr-watcher 轮询本 workspace 有订阅的 PR；缺省 false，此时行为与没有这一节完全相同。
 * - `allowed_users`：哪些 GitHub 用户的人类评论算"请求"（能恢复已结束任务、被交回或唤醒 supervisor）。
 *   缺省为登记仓库 origin 的 owner；无法解析时为空名单（没有人的评论算请求）。
 *   名单外用户与机器人的内容只作为不可信上下文送达运行中的任务。
 */

/** GitHub 登录名：字母数字开头，字母数字或连字符，最多 39 个字符。 */
export const GITHUB_LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
export const githubLogin = z
  .string()
  .regex(GITHUB_LOGIN_RE, 'GitHub 用户名只能包含字母、数字与连字符（最多 39 个字符）')

export const githubConfigSchema = z
  .strictObject({
    watch: z
      .boolean()
      .default(false)
      .meta({ description: '是否轮询本 workspace 有订阅的 PR（CI、审查与评论）；默认 false' }),
    allowed_users: z.array(githubLogin).max(100).optional().meta({
      description:
        '其评论算请求的 GitHub 用户（不区分大小写）；缺省为登记仓库 origin 的 owner，无法解析时为空名单。名单外用户与机器人的内容只作为不可信上下文',
    }),
  })
  .meta({ title: 'Workspace GitHub settings' })
export type GithubConfig = z.infer<typeof githubConfigSchema>

export const defaultGithubConfig = (): GithubConfig => ({ watch: false })
