import { HUB_TOKEN_ENV } from '@flow/core'

/**
 * 节点 spawn 执行器、worker 与验收命令时使用的环境变量（design D9）。
 *
 * 去掉中枢凭证 `FLOW_HUB_TOKEN`：它是节点自己的绑定 token，不能被任务里运行的任意代码继承。
 * 所有执行器都应通过它（或 `ExecutorContext.env`）拿 env，不要直接把 `process.env` 传给子进程。
 */
export const CHILD_ENV_DENYLIST: readonly string[] = [HUB_TOKEN_ENV]

export function executorEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  for (const key of CHILD_ENV_DENYLIST) delete env[key]
  return env
}
