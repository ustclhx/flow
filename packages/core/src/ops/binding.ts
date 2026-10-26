import { fail, ok, type Result } from '../result.ts'
import { WS_REF_RE } from '../schema/common.ts'
import type { OpBinding, Operation } from './operation.ts'

/**
 * MCP 会话绑定（add-m1-supervisor D6；tasks 4.1；knowledge-access "MCP 会话按 workspace 绑定"）。
 *
 * `flow mcp --workspace <ws> --task <id>` 启动的会话：
 * - 写类操作只能作用于绑定的 workspace，否则 `workspace_mismatch`（各操作的 `bind` 负责）；
 * - `task_create` 未写 `parent` 时自动以绑定的任务为 parent（MCP 填写，中枢不代填）；
 * - reply 唤醒（`replyOnly`）只放行只读操作与 `replyAllowed` 的操作，其余 `reply_only_wake`。
 *
 * 这里只是本地预检：经中枢的写由中枢按唤醒绑定 token 独立校验；本地执行的 `kb_journal`
 * 只有这一层检查（D6 已接受的风险：写错 workspace 的 journal）。
 */

/** `ws/<id>` 或 `<id>` 统一为完整引用。 */
export const toWorkspaceRef = (value: string): string =>
  value.startsWith('ws/') ? value : `ws/${value}`

/** 校验并规范化绑定的 workspace；不合法时返回 undefined。 */
export function normalizeBindingWorkspace(value: string): string | undefined {
  const ref = toWorkspaceRef(value.trim())
  return WS_REF_RE.test(ref) ? ref : undefined
}

/** 写类操作的目标 workspace 是否与绑定一致；不一致时返回 `workspace_mismatch`。 */
export function checkBoundWorkspace(target: string, binding: OpBinding): Result<string> {
  const ref = toWorkspaceRef(target)
  if (ref === binding.workspace) return ok(ref)
  return fail('failure', 'workspace_mismatch', `本会话绑定 ${binding.workspace}，不能写 ${ref}`, {
    workspace: ref,
    bound: binding.workspace,
  })
}

/** reply 唤醒在本地拒绝的错误（与中枢同一错误码）。 */
export const replyOnlyWake = (name: string) =>
  fail(
    'failure',
    'reply_only_wake',
    `reply 唤醒只能调用 task_respond 与只读操作，不能调用 ${name}`,
    { tool: name },
  )

/** 按会话绑定检查并改写操作输入；没有绑定时原样返回。 */
export function applyBinding<I>(
  op: Pick<Operation<I, unknown>, 'name' | 'access' | 'replyAllowed' | 'bind'>,
  input: I,
  binding: OpBinding | undefined,
): Result<I> {
  if (!binding) return ok(input)
  if (op.access === 'read') return ok(input)
  if (binding.replyOnly && !op.replyAllowed) return replyOnlyWake(op.name)
  return op.bind ? op.bind(input, binding) : ok(input)
}
