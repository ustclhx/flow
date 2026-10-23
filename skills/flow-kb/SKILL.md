---
name: flow-kb
description: >-
  Read and write the user's Flow knowledge base (flow-home brain: products, workspaces,
  resources such as domains / servers / data sources, runbooks, decisions, daily journal)
  through the `flow` CLI. Use before answering questions about the user's products,
  workspaces, infrastructure, accounts or past decisions; when you need facts you would
  otherwise guess; to log what you did (journal); to jot down an idea (capture); or to
  propose a correction to a shared fact (kb propose). Always call with --json --actor pi.
compatibility: Requires the `flow` CLI on PATH (Flow monorepo, packages/cli).
metadata:
  author: flow
  version: "0.1"
---

# Flow 知识库（CLI 用法）

Flow 把用户的长期知识放在 flow-home 里（`brain/` 是整理过的条目，`raw/` 是原始资料，`state/` 是提案与索引）。
你通过 `flow` CLI 访问它；MCP 工具（`flow mcp`）与这些命令一一对应、输入输出完全相同，但在 pi 里请用 CLI。

## 每次调用都要遵守

- **总是加 `--json --actor pi`**。`--actor pi` 让写入记在你名下，并按 AI 写入边界检查；不加就会被当成用户本人，越过边界，这是不允许的。
- stdout 只有一个 JSON 文档：成功是 `{"ok":true,"data":...}`，失败是 `{"ok":false,"error":{"kind","code","message","details"?,"retryable"}}`。看 `error.code` 判断原因，不要解析 `message`。
- 退出码：
  - `0` 成功；
  - `1` 操作失败或校验未通过（例如写入边界拒绝、条目不存在）——不要原样重试，按 `code` 调整；
  - `2` 用法错误（参数不合法、未知命令）——先跑 `flow <命令> --help` 修正参数；
  - `3` 可重试（例如写锁超时 `lock_timeout`，`retryable: true`）——稍等几秒后重试，最多 3 次。
- 参数以 `flow --help` 与 `flow <命令> --help` 的输出为准（下表的选项名可能随版本调整）。选项名是 kebab-case，例如 `--max-items`。

## 什么时候查

- 用户提到某个产品、workspace（`ws/<id>`）、域名、服务器、数据源、账号、部署方式，或问"我们之前怎么定的"——先查，再回答。
- 准备做会影响共享资源的操作（改 DNS、迁移服务器、换数据源）之前，先查该资源条目和相关 runbook、decision。
- 开始在某个 workspace 里干活时，先要一份简报：`flow ws brief <ws> --json --actor pi`。
- 查不到就如实说查不到，不要编造；可以用 `capture` 记下"缺少这条知识"。

## 命令清单

读取（随便用，不改任何东西）：

| 命令 | MCP 工具 | 用途 |
|---|---|---|
| `flow kb search <查询词> --json --actor pi` | `kb_search` | 全文检索 brain，按相关度返回条目 id、标题、摘要、片段；中文子串可直接搜 |
| `flow kb get <id> --json --actor pi` | `kb_get` | 读取一个条目的完整内容（id 形如 `resources/domains/ganjiday.com`） |
| `flow kb query key=value... --json --actor pi` | `kb_query` | 按 frontmatter 字段过滤，例如 `type=data-source owner=ws/xuanxue-saas` |
| `flow ws list --json --actor pi` | `ws_list` | 列出全部 workspace |
| `flow ws resources <ws> [--type <类型>] --json --actor pi` | `ws_resources` | 某个 workspace 拥有的资源，可按类型过滤（如 `--type domain`） |
| `flow ws brief <ws> [--budget <字符数>] --json --actor pi` | `ws_brief` | workspace 简报：描述、项目卡片、资源、最近 journal、可能过时的事实；超出预算会截断并注明省略了什么 |
| `flow kb proposals list --json --actor pi` | `kb_proposals_list` | 查看待确认的提案（例如确认自己的提案是否已提交） |

写入（按下面的写入规则）：

| 命令 | MCP 工具 | 用途 |
|---|---|---|
| `flow kb journal <正文> [--workspace ws/<id>] --json --actor pi` | `kb_journal` | 追加一条工作日志，直接写入、无需确认 |
| `flow capture <内容> --json --actor pi` | `capture` | 随手记，写进 `raw/inbox/`，不进 brain |
| `flow kb propose ... --json --actor pi` | `kb_propose` | 对事实类条目提交修改提案（目标条目、完整新内容、理由、出处），等用户确认；具体参数看 `flow kb propose --help` |

只有用户能做的（你不要调用，需要时请用户自己跑）：`flow kb proposals accept|reject`（`kb_proposals_accept` / `kb_proposals_reject`）、`flow resource transfer <资源> <目标 workspace>`（`resource_transfer`，改资源归属）。`flow kb proposals diff` 可以用来给用户展示差异。

## 写入规则（AI 写入边界）

1. **journal 直接写**：做完一件有意义的事（部署、排查结论、改了配置）就记一条，带上 `--workspace`。一条一件事，写清楚做了什么、结果如何。
2. **随手记**：想法、待核实的线索、用户顺口提的事，用 `flow capture`。它只追加到 `raw/inbox/`，不会改动 brain。
3. **事实走提案**：资源条目（域名、服务器、数据源等）、`product`、`project-card` 是共享事实，你**不能直接写**，只能 `flow kb propose`，并且**必须附出处**（链接、命令输出、文件路径等可核查的来源）；没有出处的提案会被拒绝（`sources_required`）。提案提交后 brain 暂时不变，等用户确认。
4. **不得写 decision 与 personal**：`type: decision` 的条目和 `scope: personal` 的条目只能由用户写入（`ai_forbidden_decision` / `ai_forbidden_personal`）。需要记录一个决定时，写 journal 或 capture，请用户自己落成 decision。
5. 不要修改 `brain/log.md`、`brain/index.md`、`brain/AGENTS.md`，也不要改 `raw/` 里已有的文件；不要绕过 `flow` 直接编辑 flow-home 下的文件。

## 示例

```sh
flow kb search 干支日 --json --actor pi
flow kb get resources/domains/ganjiday.com --json --actor pi
flow kb query type=data-source owner=ws/xuanxue-saas --json --actor pi
flow ws brief ws/xuanxue-saas --budget 4000 --json --actor pi
flow kb journal "东方站日语版部署完成，CDN 缓存已刷新" --workspace ws/product-res --json --actor pi
flow capture "用户提到想给东方站加日语" --json --actor pi
```

写锁超时时的输出（退出码 3，可重试）：

```json
{"ok":false,"error":{"kind":"retryable","code":"lock_timeout","message":"...","retryable":true}}
```
