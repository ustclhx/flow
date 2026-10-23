# Proposal

## Why

目前用户的 AI 协作背景散落在各处：两个产品仓库的 AGENTS.md、各 harness 自带的记忆，以及用户自己的头脑里。每次开工都要重新给 AI 讲一遍背景，而且没有一份记录"有哪些产品、哪些域名、谁负责什么"的共享事实。

M0 先把这份共享事实建起来。后续里程碑（M1 内核、M2 运维闭环）都要读写它，所以它是 Flow 的地基（PRD §8、§16）。

## What Changes

- **初始化用户数据目录**：新增 `flow init`，创建 `~/flow-home`，包含 `config/`、`brain/`、`raw/`、`state/`。其中 `config/`、`brain/`、`raw/` 各自是独立的 git 仓库；目录位置可以通过 `FLOW_HOME` 覆盖。
- **定义知识条目格式**：Markdown 加 frontmatter，规定条目类型、必填字段、出处要求，以及自动维护的 `index.md` 和 `log.md`；提供 `flow kb validate`。
- **定义 workspace 与资源注册表**：
  - workspace 定义在 `config/workspaces/` 下；
  - 资源（域名、服务、仓库、数据源、账号）是 brain 里的条目，每个资源只归属一个 workspace；
  - 首批录入 `product-res` 和 `xuanxue-saas` 两个产品的资源。
- **提供知识访问接口**：同一套能力同时提供 CLI（`flow kb ...`）和 MCP server（`flow mcp`），包括：
  - 检索、读取、结构化查询；
  - 追加 journal；
  - 随手记写入 `raw/inbox/`；
  - 提交事实修改提案，经用户确认后合入。

  写入按分级规则执行。
- **同步 AGENTS.md 受管区块**：在各产品仓库的 AGENTS.md 中生成并更新一个 `flow-managed` 区块，区块外的内容不动；提供 `--check` 来检测是否过时。
- **密钥卫生**：`config/`、`brain/`、`raw/` 三个仓库在提交前强制做密钥扫描；所有 Flow 写入在落盘前也要先扫描。约定 `secret://` 引用语法，解析放到 M1 实现。
- 建立平台 monorepo 脚手架（Bun + TypeScript）。
- **不在本次范围**：
  - 账本、调度、执行器、收件箱、Web 工作台（M1 及以后）；
  - 资源归属变更时的任务迁移（M1）；
  - LLM Wiki 的 ingest 和 lint 工作流、向量检索、qmd 集成（M3）；
  - sops + age 的密钥解析（M1）；
  - Notion 或 Obsidian 镜像。

## Capabilities

### New Capabilities

- `flow-home`：用户数据目录的布局、初始化，以及与平台代码的分离。
- `knowledge-base`：知识条目的格式、类型、出处规则、校验，以及 index 和 log 的维护。
- `resource-registry`：workspace 定义、资源条目、单一归属规则和归属变更记录。
- `knowledge-access`：通过 CLI 和 MCP 检索、读取、查询知识，以及按写入分级规则执行的写入操作（journal、随手记、修改提案及其确认）。
- `agent-context-sync`：在项目 AGENTS.md 中生成、更新和检查 Flow 受管区块。
- `secret-hygiene`：知识和配置仓库的密钥扫描，以及 `secret://` 引用约定。

### Modified Capabilities

无，本仓库尚无已有能力。

## Impact

- **本仓库**：新增 monorepo，包含 `packages/core`、`packages/cli`、`packages/mcp`，使用 Bun 和 TypeScript，测试用 `bun test`，代码检查用 Biome。
- **用户机器**：
  - 新建 `~/flow-home`；
  - 需要安装 gitleaks；
  - 在 Claude Code、Codex、oh-my-pi 中注册 `flow mcp`；pi 通过 CLI 和 skill 使用。
- **产品仓库**：`~/workspace/product-res` 和 `~/workspace/xuanxue-saas` 的 AGENTS.md 会新增一个受管区块。Flow 只修改工作区文件，不自动提交，由用户审阅后提交。
- **外部服务**：无。
