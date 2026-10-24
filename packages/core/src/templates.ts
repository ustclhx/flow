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
