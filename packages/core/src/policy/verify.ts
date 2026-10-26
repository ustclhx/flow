import { type ClassifyOptions, classifyAction } from './actions.ts'
import type { IndexedPolicyRule } from './config.ts'
import { decide, type PolicyDecisionLevel } from './decide.ts'

/**
 * 合同 `verify` 的建任务时策略判定（add-m1-supervisor D5、D9）。
 *
 * 验收命令由节点在执行器沙箱之外、以合同角色身份直接运行，不经过任何运行时审批，
 * 所以非 user 身份建任务时，中枢在**创建时**把每条命令交给策略引擎：动作取 `tool:Verify`
 * 加上 `classifyAction` 的识别结果，scope 为新任务的 workspace 与角色，`command_prefix`
 * 按严格的原始词匹配。只有 `auto` 或 `auto-report` 才放行。`tool:Verify` 是受保护的工具，
 * 通配 scope 或通配 action 的规则最多判为 draft-approve。
 */

export const VERIFY_TOOL = 'Verify'

const PLAIN_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/

/**
 * 把 argv 拼成供策略识别的 shell 文本：普通词原样，其余用单引号包起（内部单引号写成 `'\''`），
 * 这样 `['sh', '-c', '…']` 中的嵌套脚本照样被识别，`['pnpm', 'test']` 与 `command_prefix: pnpm test` 严格匹配。
 */
export function verifyCommandText(cmd: readonly string[]): string {
  return cmd
    .map((word) => (PLAIN_WORD.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`))
    .join(' ')
}

export interface VerifyVerdict {
  /** verify 数组中的序号。 */
  index: number
  command: string
  level: PolicyDecisionLevel
  allowed: boolean
}

/** 逐条判定；`allowed` 只在 auto / auto-report 时为 true。 */
export function decideVerifySteps(
  rules: readonly IndexedPolicyRule[],
  scope: { workspace: string; role: string },
  steps: readonly { cmd: readonly string[] }[],
  opts: ClassifyOptions = {},
): VerifyVerdict[] {
  return steps.map((step, index) => {
    const command = verifyCommandText(step.cmd)
    const actions = classifyAction({ tool: VERIFY_TOOL, command }, undefined, opts)
    const { level } = decide(rules, { scope, actions, command })
    return { index, command, level, allowed: level === 'auto' || level === 'auto-report' }
  })
}
