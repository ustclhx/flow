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
  /** 不放行的额外原因（例如参数中有路径），档位本身可能是 auto。 */
  reason?: string
}

/**
 * 验收命令中每个词（含可执行文件与前缀词）允许的形态：白名单，逐段的相对路径或普通词。
 * 不能以 `-` 开头（选项可以用 `=`、拼接等方式夹带路径，例如 `-r/tmp/x.js`、`--preload=/tmp/x.js`），
 * 不能含 `:`、`@`、`~`、`%` 等字符（`file:///tmp/x`、`@/tmp/x`、`~/x`），不能以 `/` 开头，不能含 `..`，
 * `=` 之后也不能紧跟 `/`。
 */
export const VERIFY_WORD_RE = /^[A-Za-z0-9_][A-Za-z0-9_.,=+-]*(\/[A-Za-z0-9_.,=+-]+)*$/

/**
 * 第一个不符合白名单的词；全部符合时为 undefined。
 * 词法检查拦不住仓库内指向仓库外的符号链接（例如 `src/link-to-outside`），这是已接受的风险。
 */
export function verifyRejectedWord(cmd: readonly string[]): string | undefined {
  // `=` 之后紧跟 `/`（`a=b=/tmp`、`x=/etc/y`）：值是绝对路径，同样拒绝。
  return cmd.find(
    (word) => !VERIFY_WORD_RE.test(word) || word.includes('..') || word.includes('=/'),
  )
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
    const rejected = verifyRejectedWord(step.cmd)
    if (rejected !== undefined) {
      return { index, command, level, allowed: false, reason: `参数不在白名单内：${rejected}` }
    }
    return { index, command, level, allowed: level === 'auto' || level === 'auto-report' }
  })
}
