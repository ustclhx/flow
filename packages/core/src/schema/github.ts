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

/** worker 的 GitHub 身份：用户名，或 GitHub App 的 `<slug>[bot]`。 */
export const githubActorLogin = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/, 'GitHub 身份只能是用户名或 <app>[bot]')

export const githubConfigSchema = z
  .strictObject({
    watch: z
      .boolean()
      .default(false)
      .meta({ description: '是否轮询本 workspace 有订阅的 PR（CI、审查与评论）；默认 false' }),
    allowed_users: z.array(githubLogin).max(100).optional().meta({
      description:
        '其评论算请求的 GitHub 用户（按数字 id 比较）；缺省为该 PR 所属登记仓库 origin 的 owner（仅当 owner 是个人账号），否则为空名单。名单外用户与机器人的内容只作为不可信上下文',
    }),
    worker_identity: githubActorLogin.optional().meta({
      description:
        'worker 在 GitHub 上使用的独立身份（bot 账号或 App）；它发的内容标为 agent，永不算请求。当前版本该设置不解除共享身份限制：worker 仍以本机 gh 登录发评论，需等 bot 凭证注入 worker 的后续变更',
    }),
  })
  .meta({ title: 'Workspace GitHub settings' })
export type GithubConfig = z.infer<typeof githubConfigSchema>

export const defaultGithubConfig = (): GithubConfig => ({ watch: false })
