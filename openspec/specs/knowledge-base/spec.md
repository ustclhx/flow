# knowledge-base Specification

## Purpose
规定 brain 中知识条目的格式、类型和出处规则，以及 index 和 log 的维护方式，使人和各 harness 读写的是同一份结构一致、可以校验的知识。

## Requirements

### Requirement: 条目格式
每个知识条目 SHALL 是 `brain/` 下的一个 Markdown 文件，带 YAML frontmatter。frontmatter MUST 包含 `type`、`title`、`summary`（一句话），以及 `scope`（取值 `work` 或 `personal`）。条目的标识是它相对 `brain/` 的路径（不含扩展名）。

#### Scenario: 合法条目
- **WHEN** `brain/resources/domains/arcanumber.com.md` 含有 `type: domain`、`title`、`summary`、`scope: work`
- **THEN** 该条目以 `resources/domains/arcanumber.com` 为标识被识别

#### Scenario: 缺少必填字段
- **WHEN** 某条目缺少 `summary`
- **THEN** `flow kb validate` 报告该条目路径和缺失字段，并以非零状态退出

### Requirement: 条目类型
系统 SHALL 支持以下条目类型，每种类型有各自的必填字段：`product`、`domain`、`service`、`repo`、`data-source`、`account`、`runbook`、`decision`、`concept`、`note`、`project-card`。资源类型（`domain`、`service`、`repo`、`data-source`、`account`）的规则另见 `resource-registry`。未知类型 MUST 被校验报告为错误。

#### Scenario: 未知类型
- **WHEN** 某条目声明 `type: gadget`
- **THEN** `flow kb validate` 报告未知类型错误

### Requirement: Decision 字段
`decision` 类型的条目 MUST 包含 `status`（`proposed`、`approved`、`rejected`、`reviewed` 之一）、`expected_outcome`、`metric` 和 `review_date`。

#### Scenario: 缺少回看日期
- **WHEN** 某个 `decision` 条目缺少 `review_date`
- **THEN** `flow kb validate` 报告该错误

### Requirement: 事实出处
事实类条目（资源类型、`product`、`runbook`）中由 AI 写入的内容 SHALL 在 frontmatter 的 `sources` 字段中列出至少一个出处。出处可以是 raw 中的路径、项目仓库内的路径或 URL。用户手写的条目缺少出处时，校验 SHALL 只给出警告，不报错。`note` 和 `personal` 范围的条目不要求出处。

#### Scenario: AI 提案缺少出处
- **WHEN** AI 为某个 `domain` 条目提交修改提案，但没有附 `sources`
- **THEN** 该提案被拒绝，并返回"事实类条目需要出处"

#### Scenario: 用户手写缺少出处
- **WHEN** 用户手写的 `product` 条目没有 `sources`
- **THEN** `flow kb validate` 输出警告，退出状态不受影响

### Requirement: 核实时间
事实类条目 SHALL 支持 `last_verified` 字段（日期，可以为空）。校验 SHALL 统计已超过有效期（默认 90 天，可配置）或从未核实的事实条目数量，并在输出中列出。

#### Scenario: 过期条目
- **WHEN** 某个 `domain` 条目的 `last_verified` 是 120 天前
- **THEN** `flow kb validate` 把它列为"可能过时"

### Requirement: 索引维护
系统 SHALL 在每次通过 Flow 写入 brain 后重新生成 `brain/index.md`：按类型分组，列出每个条目的链接和 `summary`。用户 MUST NOT 需要手动编辑 `index.md`。

#### Scenario: 新条目进入索引
- **WHEN** 通过 Flow 新增一个 `runbook` 条目
- **THEN** `brain/index.md` 的 runbook 分组中出现该条目的链接和摘要

### Requirement: 变更日志
系统 SHALL 在每次通过 Flow 写入 brain 后，向 `brain/log.md` 追加一行。行首依次是固定格式的日期、操作类型（`journal`、`capture`、`propose`、`apply`、`reject`、`owner-change`、`sync`）和操作者，后面是简述。`log.md` 中已有的行 MUST NOT 被修改。

#### Scenario: 记录合入
- **WHEN** 用户确认合入一个修改提案
- **THEN** `log.md` 末尾新增一行以日期和 `apply` 开头的记录，此前的行保持不变

### Requirement: 写入即提交
通过 Flow 对 `brain/` 或 `raw/` 的每次写入 SHALL 生成一次 git 提交，提交信息标明操作类型与操作者（用户或具体角色）。

#### Scenario: journal 提交
- **WHEN** 某个 agent 追加了一条 journal
- **THEN** brain 仓库新增一次提交，提交信息中包含 `journal` 与该 agent 的标识
