import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 用户数据目录（flow-home）的位置与布局。所有命令都必须从这里解析路径，
 * 不得在平台代码仓库内写入用户数据（flow-home spec）。
 */

export type Env = Record<string, string | undefined>

/** `FLOW_HOME` 优先（空串视为未设置），否则使用 `~/flow-home`。返回绝对路径。 */
export function resolveFlowHome(env: Env = process.env, home: string = homedir()): string {
  const raw = env.FLOW_HOME?.trim()
  if (!raw) return join(home, 'flow-home')
  if (raw === '~') return home
  if (raw.startsWith('~/')) return join(home, raw.slice(2))
  return resolve(raw)
}

export interface FlowPaths {
  home: string
  config: string
  brain: string
  raw: string
  state: string
  /** `config/workspaces/`：workspace 定义。 */
  workspaces: string
  /** brain 中的固定文件。 */
  brainAgents: string
  brainIndex: string
  brainLog: string
  /** `brain/journal/`：按天的日志文件，不是条目。 */
  journal: string
  /** `raw/inbox/`：随手记。 */
  inbox: string
}

/** 需要初始化为独立 git 仓库的子目录；`state/` 不进 git。 */
export const GIT_REPOS = ['config', 'brain', 'raw'] as const
export type RepoName = (typeof GIT_REPOS)[number]

export function flowPaths(home: string): FlowPaths {
  const config = join(home, 'config')
  const brain = join(home, 'brain')
  const raw = join(home, 'raw')
  return {
    home,
    config,
    brain,
    raw,
    state: join(home, 'state'),
    workspaces: join(config, 'workspaces'),
    brainAgents: join(brain, 'AGENTS.md'),
    brainIndex: join(brain, 'index.md'),
    brainLog: join(brain, 'log.md'),
    journal: join(brain, 'journal'),
    inbox: join(raw, 'inbox'),
  }
}

/** flow-home 位置的来源：`FLOW_HOME` 环境变量或默认值。 */
export const flowHomeSource = (env: Env = process.env): 'FLOW_HOME' | 'default' =>
  env.FLOW_HOME?.trim() ? 'FLOW_HOME' : 'default'
