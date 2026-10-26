import { renderEntryFieldDocs } from './schema/index.ts'

/**
 * `flow init` 写入的模板文件。内容是确定性的（不含时间戳），且不包含任何密钥，
 * 因此初始化提交可以安全地跳过提交前钩子。
 */

/** 各仓库的 gitleaks 配置：在默认规则之上放行 `secret://` 引用（design D7）。 */
export const GITLEAKS_TOML = `# 由 flow init 生成。在 gitleaks 默认规则之上，放行 secret:// 引用。
# 公开 token 被误报时，可在下方 regexes 中按需逐条加入允许项。
[extend]
useDefault = true

[allowlist]
description = "secret:// 是密钥引用，不是密钥本身"
regexTarget = "match"
regexes = ['''secret://[A-Za-z0-9._/-]+''']
`

/** 仅放行 sops 元数据中的加密 MAC，不放行整个文件或任何明文业务字段。 */
export const SOPS_ALLOWLIST = `
[[allowlists]]
description = "flow: sops 加密 MAC 元数据"
regexTarget = "line"
regexes = ['''^\\s*mac: ENC\\[AES256_GCM,.*\\]$''']
`

export const CONFIG_GITLEAKS_TOML =
  GITLEAKS_TOML.replace('[allowlist]', '[[allowlists]]') + SOPS_ALLOWLIST

/** 钩子中用于识别 Flow 管理的标记，`flow doctor` 据此检查钩子是否就位。 */
export const HOOK_MARKER = 'flow-managed: gitleaks pre-commit'

/** 提交前钩子：用 gitleaks 扫描暂存区，脱敏输出，发现疑似密钥时阻止提交（secret-hygiene）。 */
export const PRE_COMMIT_HOOK = `#!/bin/sh
# ${HOOK_MARKER}
# 由 flow init 生成：提交前扫描暂存内容中的密钥。
if ! command -v gitleaks >/dev/null 2>&1; then
  echo "flow: 未找到 gitleaks，提交已阻止。安装：brew install gitleaks" >&2
  exit 1
fi
exec gitleaks git --pre-commit --staged --redact --no-banner --verbose .
`

export function brainAgentsMd(): string {
  return `# brain 知识库约定

> 由 \`flow init\` 生成。本文件说明 brain 中知识条目的写法，供人和各 AI harness 共同遵守。
> 修改本文件不会被 Flow 覆盖。

## 分层（LLM-Wiki 式）

- \`raw/\`：原始资料，**只追加**。随手记写入 \`raw/inbox/\`，已有文件不得修改。
- \`brain/\`：由 Flow 维护的结构化知识。每个条目是一个带 YAML frontmatter 的 Markdown 文件，
  条目标识是相对 \`brain/\` 的路径（不含 \`.md\`），例如 \`resources/domains/arcanumber.com\`。
- \`brain/index.md\`：按类型分组的条目索引，由 Flow 自动重新生成，**不要手动编辑**。
- \`brain/log.md\`：变更日志，每次 Flow 写入追加一行，**已有行不得修改**。
  行格式：\`YYYY-MM-DD <操作> <操作者> <简述>\`，操作为
  \`journal\`、\`capture\`、\`propose\`、\`apply\`、\`reject\`、\`owner-change\`、\`sync\` 之一。
- \`brain/journal/\`：按天分文件的工作日志（\`journal/YYYY-MM-DD.md\`），不是条目。

## 写入分级

- **journal、随手记**：任何操作者都可以直接追加。
- **事实修改**（新增或修改条目）：AI 通过修改提案提交，由用户确认后合入。
- **decision 与 \`scope: personal\` 的条目**：AI 不得直接写入。
- 所有 Flow 写入都会先做密钥扫描，再提交到 git；提交作者为 \`Flow (<操作者>)\`。

## 出处规则

- 事实类条目（资源类型 \`domain\`、\`service\`、\`repo\`、\`data-source\`、\`account\`，以及 \`product\`、\`runbook\`）
  必须在 \`sources\` 中列出至少一个出处：raw 中的路径、项目仓库内的路径或 URL。
  用户口头确认的事实写作"用户确认（YYYY-MM-DD）"。
- AI 提交的事实类条目缺少出处会被拒绝；用户手写的缺少出处只给出警告。
- \`note\` 和 \`scope: personal\` 的条目不要求出处。
- 找不到依据的字段留空（null），不要猜测；\`last_verified\` 为空表示"从未核实"。
- 事实类条目的 \`last_verified\` 超过 90 天会被列为"可能过时"。

## 资源归属

- 资源条目必须有唯一的 \`owner\`，值为 \`config/workspaces/\` 中定义的 workspace（\`ws/<id>\`），
  或隐式存在的 \`ws/global\`。职能（\`kind: function\`）workspace 不能拥有资源。
- 归属只能通过 \`flow resource transfer\` 或经确认的修改提案更改。

## 密钥

- 不要在任何条目中写入密钥明文。需要引用凭据时写 \`secret://<路径>\`，例如 \`secret://stripe/readonly\`。

## 条目类型与字段

日期一律写作 \`YYYY-MM-DD\`。以下字段说明由 Flow 的 schema 生成。

${renderEntryFieldDocs()}

## 校验

运行 \`flow kb validate\` 检查全部条目；\`flow doctor\` 检查 flow-home 是否完整。
`
}

export const BRAIN_INDEX_MD = `# 索引

> 由 Flow 自动生成，请勿手动编辑。

（暂无条目）
`

export const BRAIN_LOG_MD = `# 变更日志

> 由 Flow 追加，已有行不得修改。格式：\`YYYY-MM-DD <操作> <操作者> <简述>\`

`

/**
 * `config/policies.yaml` 的初始内容：规则全部注释掉，未配置的动作一律交给用户。
 * 以 `# ` 开头的行是可直接取消注释的规则，`## ` 开头的行是说明（测试据此逐条验证模板）。
 */
export const POLICIES_YAML = `## 由 flow init 生成。策略规则数组，语法与判定规则见 packages/core/src/policy/README.md。
## 未被规则覆盖的动作一律交给用户。以下模板默认全部注释掉：按 workspace 取消注释，
## 并把 ws/<id> 换成实际的 workspace id。
##
## —— supervisor 建任务（add-m1-supervisor D5）——
## 允许 supervisor 角色直接创建任务（中枢仍按 D5 校验唤醒 parent、origin、仓库与数量上限）。
## scope 用角色名而不是 ws/<id>：workspace scope 会同时放行该 workspace 内所有角色的建任务请求。
# - scope: supervisor
#   action: task.create
#   level: auto
##
## —— 卡住时代用户回复的白名单（D15）——
## level: supervisor 表示委托给本 workspace 的 supervisor 判断，不是直接放行；
## supervisor 拿不准时转交用户，超时或无法唤醒时同样转交用户。
## 只写具体 scope 加精确 action 的 supervisor 规则，不要写 scope: * 或通配 action 的 supervisor 规则。
## 命令前缀严格按原始词匹配（pnpm test --x 命中；pnpm test:e2e、sudo pnpm test、./pnpm test、
## FOO=1 pnpm test、pnpm test > file、pnpm test $X 都不命中；只允许 2>&1），串联命令的每段都须满足同一前缀。
## 风险：批准 pnpm test 等命令，等于批准在沙箱外执行仓库中的脚本，包括 worker 改过的 package.json
## scripts、测试配置与 --reporter、--preload 等参数引入的代码；supervisor 需结合 diff_stat 判断。
# - scope: ws/<id>
#   action: tool:CodexCommand
#   level: supervisor
#   when: {command_prefix: pnpm check}
# - scope: ws/<id>
#   action: tool:CodexCommand
#   level: supervisor
#   when: {command_prefix: pnpm test}
# - scope: ws/<id>
#   action: tool:CodexCommand
#   level: supervisor
#   when: {command_prefix: pnpm lint}
# - scope: ws/<id>
#   action: tool:Bash
#   level: supervisor
#   when: {command_prefix: pnpm check}
# - scope: ws/<id>
#   action: tool:Bash
#   level: supervisor
#   when: {command_prefix: pnpm test}
# - scope: ws/<id>
#   action: tool:Bash
#   level: supervisor
#   when: {command_prefix: pnpm lint}
##
## gh 只作用于本 workspace 的登记仓库：不带 -R/--repo、无环境变量前缀、节点核对 gh 解析出的仓库，
## 命令须在任务 worktree 中执行；不接受 --body-file / -F（正文用 --body 或 --fill），--head 只能是任务分支；
## gh pr view / diff 不接受 --jq / -q / --template / -t。
## 注意：gh 在有 TTY 时可能提示推送分支，supervisor 批准 pr create 不等于批准推送。
# - scope: ws/<id>
#   action: pr.create
#   level: supervisor
#   when: {gh_scope: workspace_repo}
# - scope: ws/<id>
#   action: tool:CodexCommand
#   level: supervisor
#   when: {command_prefix: gh pr view, gh_scope: workspace_repo}
# - scope: ws/<id>
#   action: tool:CodexCommand
#   level: supervisor
#   when: {command_prefix: gh pr diff, gh_scope: workspace_repo}
# - scope: ws/<id>
#   action: tool:Bash
#   level: supervisor
#   when: {command_prefix: gh pr view, gh_scope: workspace_repo}
# - scope: ws/<id>
#   action: tool:Bash
#   level: supervisor
#   when: {command_prefix: gh pr diff, gh_scope: workspace_repo}
##
## 只推到执行器上报的任务分支（非默认分支），单段 git push、无全局选项与强推，节点核对推送环境。
# - scope: ws/<id>
#   action: git.push
#   level: supervisor
#   when: {push_to: task_branch}
`
