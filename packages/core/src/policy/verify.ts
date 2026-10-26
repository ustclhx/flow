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
 * 相对路径段的形态：每个 `/` 分隔段都以字母数字或 `_` 开头和结尾，中间只含字母数字与 `_ . + -`
 * （段尾不能是 `-`、`+`、`.`，挡住 `a-/tmp`、`a+/tmp` 这类在某些工具里会被拆开的写法）。
 * 因此不能以 `/` 开头、不能有空段（`a//b`）或 `.` 开头的段（`a/./b`、`.hidden`），不能含 `:`、`@`、`~`、`%`、
 * 空白、`,`、`=` 等字符；另外不能含 `..`。
 */
export const VERIFY_PATH_RE =
  /^[A-Za-z0-9_](?:[A-Za-z0-9_.+-]*[A-Za-z0-9_])?(?:\/[A-Za-z0-9_](?:[A-Za-z0-9_.+-]*[A-Za-z0-9_])?)*$/
/** 选项名：点分隔的段（`--coverage.enabled`），每段以字母数字开头、只含字母数字与 `-`。 */
const OPTION_NAME = '[A-Za-z0-9][A-Za-z0-9-]*(?:\\.[A-Za-z0-9][A-Za-z0-9-]*)*'
/** 不带值的选项：`-u`、`-rfoo`、`--fix`、`--coverage.enabled`（值不能直接拼在后面，例如 `-r/tmp/x.js`）。 */
export const VERIFY_OPTION_RE = new RegExp(`^(?:-[A-Za-z0-9][A-Za-z0-9-]*|--${OPTION_NAME})$`)
/** `--name=值`：值按普通词校验。 */
const VERIFY_OPTION_VALUE_RE = new RegExp(`^--${OPTION_NAME}=(.*)$`, 's')

/** 一个相对路径：允许开头的 `./`，去掉后按 VERIFY_PATH_RE 校验，且不含 `..`。 */
const relativePath = (part: string) => {
  const rest = part.startsWith('./') ? part.slice(2) : part
  return VERIFY_PATH_RE.test(rest) && !rest.includes('..')
}

/**
 * 普通词（可执行文件、前缀词、位置参数、`--name=` 的值）：先按 `,` 与 `=` 切段，每段都必须是相对路径。
 * 很多工具会按逗号拆值（mocha `--require=a,/tmp/x.js`），也会把 `k=v` 的值当路径，所以每段单独校验。
 */
export function verifyPlainWord(word: string): boolean {
  return word.split(/[,=]/).every(relativePath)
}

/** 单个词是否在白名单内。 */
export function verifyWordAllowed(word: string): boolean {
  // 单独的 `--`：参数分隔符（`pnpm test -- --watch=false`），其后的词照样逐个校验。
  if (word === '--') return true
  if (VERIFY_OPTION_RE.test(word)) return true
  const withValue = VERIFY_OPTION_VALUE_RE.exec(word)
  if (withValue) return verifyPlainWord(withValue[1] ?? '')
  return verifyPlainWord(word)
}

/**
 * 第一个不符合白名单的词；全部符合时为 undefined。选项与它的值分成两个词写时（`--reporter ./x.js`）
 * 两个词分别校验。词法检查拦不住仓库内指向仓库外的符号链接（例如 `src/link-to-outside`），
 * 也拦不住引用仓库内相对路径执行代码（`--reporter=x.js`），这些是已接受的风险（design D15）。
 */
export function verifyRejectedWord(cmd: readonly string[]): string | undefined {
  return cmd.find((word) => !verifyWordAllowed(word))
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
