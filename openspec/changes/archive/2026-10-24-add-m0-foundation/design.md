# Design

## Context

- 本仓库目前只有 `docs/prd.md` 和 OpenSpec 配置，没有代码。动机见 proposal.md 的 Why 部分；整体设计见 PRD §8 和 §16–§18。
- **两个产品仓库的现状**（已核实）：
  - 都基于同一套 SaaS 模板：pnpm 加 turbo，部署在 Cloudflare Workers 上（web 和 jobs 两个 Worker），数据库是 Neon，监控用 Sentry，都提供 `/api/health`。
  - 都有 `docs/runbooks/`。
  - 根目录的 `CLAUDE.md` 只有一行 `@AGENTS.md`，所以只需要维护 AGENTS.md 一个文件。
  - AGENTS.md 里已经有一个 turborepo 的受管区块（`<!-- BEGIN:turborepo-agent-rules -->`），Flow 的区块采用同样的标记风格，并且必须和它共存。
- **xuanxue-saas**：生产环境的路由是 `ganjiday.com` 和 `arcanumber.com`（见 `apps/web/wrangler.jsonc`），已接入 Stripe、Turnstile 和 Cloudflare Web Analytics。
- **product-res**：生产域名是 `product.ezarouter.cc`（`template.config.ts` 的 `app.url`，用户已于 2026-10-24 确认配置完毕）。`wrangler.jsonc` 中的生产路由仍是占位值 `configure-production-domain.invalid`，说明自定义域名不是通过 wrangler 配置的。这个差异记录在资源条目里，交给 M2 的 Cloudflare 插件核实。
- **本机工具**：Bun 1.4、Node 26、age、git-lfs、Claude Code、Codex、pi、oh-my-pi 都已安装；gitleaks、sops、qmd 还没有安装。
- **并发**：多个 harness 会各自启动一个 `flow mcp` 进程，所以对 brain 的写入可能来自多个进程同时进行。

## Goals / Non-Goals

**Goals：**
- 文件是真相来源：brain、raw、config 都是纯文本，可以用 git 管理；`state/` 里的东西都能重建，只有待确认的提案例外。
- 只有一条写入路径：CLI 和 MCP 的所有写操作都经过同一个写入模块，校验、扫描、加锁、提交、更新 index 和 log 都在这里完成。
- 让 pi 这类不依赖 MCP 的 harness 也能完整使用知识库。

**Non-Goals：**
- 不做常驻守护进程。M0 的所有命令都是一次性进程，MCP 使用 stdio 传输。
- 不做向量检索和语义检索。
- 操作者标识不是安全边界：这是单用户系统，标识只用于记录和规则判断，不做身份认证。

## Decisions

### D1 以 CLI 为主，MCP 只是一层薄封装
- 核心逻辑放在 `packages/core`；`packages/cli` 和 `packages/mcp` 都只是适配层，从而保证两种接口行为一致。
- pi 的设计思路偏向用 CLI 和 skill 而不是 MCP，具体以实测为准，所以给 pi 提供一个 skill 文件，说明 CLI 的用法。
- 备选方案是只做 MCP，但那样会排除 pi，也不方便你自己在终端里用。

### D2 检索：SQLite FTS5 trigram 索引，放在 `state/index.db`
- 文件是真相来源，索引按文件修改时间加内容哈希做增量重建，随时可以删掉重建。
- trigram 分词器无需额外分词就能匹配中文子串。它的限制是查询少于 3 个字符时无法匹配，所以短查询改为对 frontmatter 和正文做 `LIKE` 扫描。按 PRD 的估计，brain 只有几百个条目，扫描代价可以忽略。
- frontmatter 的字段同时写入一张键值表，用来支持结构化查询。
- **备选方案是现在就接 qmd**：能力更强，有混合检索和 rerank，但会多一个外部依赖，而且向量检索在这个规模下用处不大。按 PRD 的路线，放到 M3 实现，届时作为可替换的检索后端接入。

### D3 Schema 用 zod 定义，每种类型一个
- frontmatter 用 `yaml` 包解析。
- 类型定义集中在 `packages/core/schema`，同一份定义同时用于校验、生成 brain/AGENTS.md 里的字段说明，以及生成 MCP 工具的参数描述，避免文档与实现不一致。

### D4 提案存放在 `state/proposals/<id>.json`
- 提案包含 `base_hash`：创建时目标文件的内容哈希；新建条目时为空。接受时如果哈希对不上，就报告冲突。
- 提案存在 `state/` 而不是 brain，是为了让未经确认的内容不进入知识库的 git 历史。被拒绝的提案移到 `state/proposals/rejected/`，连同理由一起保留。
- **已知代价**：`state/` 不进 git，待确认的提案需要和账本一起备份（M1）。

### D5 跨进程写锁
- 写入模块在 `state/write.lock` 上加文件锁，同一时间只有一个写入者。锁等待设有超时，超时后返回可重试的错误。
- 单用户场景下写入频率很低，串行化的代价可以接受。这也和 PRD 中"知识管理员串行合入"的模型一致。

### D6 git 操作调用 git 命令行
- 不用 isomorphic-git，是为了让提交前钩子（密钥扫描）自然生效。
- Flow 提交的作者统一为 `Flow (<actor>) <flow@localhost>`，用户自己的提交不受影响。

### D7 密钥扫描用 gitleaks，分两处
- **提交前钩子**：调用 gitleaks 扫描暂存区。
- **写入前扫描**：把待写内容通过 stdin 交给 gitleaks，并开启脱敏输出，保证错误里不出现原文。
- 各仓库放一份 `.gitleaks.toml`，允许 `secret://` 引用通过。
- 公开的 token 在扫描时可能被误报，比如 Cloudflare Web Analytics 的 site token，按需逐条加入允许列表。
- `flow doctor` 负责检查 gitleaks 是否已安装、版本是否满足要求。gitleaks 的子命令在不同版本之间有变化，所以实现时要固定一个最低版本。

### D8 操作者标识由启动参数决定
- 各 harness 的 MCP 配置中写入 `flow mcp --actor <name>`，CLI 默认是 `user`，也可以用 `--actor` 指定。
- 规则判断（例如"AI 不能写决策"）以 `actor != user` 作为 AI 的判定依据。

### D9 受管区块的生成必须是确定性的
- 区块内容按固定顺序排序，不含时间戳。这样 `--check` 的结果是稳定的，重复同步也不会产生无意义的差异。
- 区块大小设上限（默认 2000 字符），超出时只保留资源摘要，并给出查询命令。原因是这个区块会进入每一次 harness 会话的上下文。

### D10 首批资源通过提案流程录入
- 不专门写一个 seed 功能。录入工作由一个 agent（Claude）读取两个产品仓库，以修改提案的形式提交，用户再批量确认。
- 这样做同时实地检验了提案、校验、出处、确认这一整条链路。
- 仓库里找不到依据的字段留空，比如域名到期日、注册商。用户口头确认的事实，出处写成"用户确认（日期）"。

### D11 Monorepo 布局
- `packages/core`、`packages/cli`、`packages/mcp`，使用 Bun workspaces。
- 代码检查用 Biome，与两个产品仓库一致；测试用 `bun test`。
- 开发时通过 `bun link` 暴露 `flow` 命令；单文件打包（`bun build --compile`）放到 M1。

### D12 实现语言用 TS，并为以后改用 Rust 预留接口
- MVP 全部使用 TypeScript。决定性的因素是 harness SDK（Claude Agent SDK、Codex SDK、pi）和插件生态都在 TS 一侧，而且产品形态还在变化，迭代速度最重要。
- 用户看重可靠性、资源占用和分发体验，以后可能逐步迁到 Rust。比较可能先迁的是节点守护进程；开源以后，也可能把内核核心迁过去，换成"Rust 内核 + TS 插件宿主"的结构。所以从 M0 开始，凡是跨越组件边界的契约，都必须与语言无关：
  - **磁盘格式**：brain 条目的 frontmatter、提案文件、`config/` 下的 YAML，都由 zod 定义导出为 JSON Schema，放在 `schemas/` 目录下并纳入版本管理。以后 Rust 实现可以直接用这些 JSON Schema 做校验或生成类型。
  - **CLI 契约**：所有 `flow` 子命令都支持 `--json`，输出结构稳定，退出码含义固定。这样任何一个子命令都可以单独用别的语言重写，脚本和别的 agent 也能可靠地调用。
  - **MCP 工具**：参数与返回值同样由 JSON Schema 描述。
  - **`state/` 中可以重建的内容**（比如索引）不属于契约，可以自由改动。
- **保持 Node 兼容**：不使用 Bun 专有、又没有 Node 替代品的 API。`bun:sqlite` 这类依赖要通过一层薄封装隔离开，必要时可以切到 Node 运行。
- **备选方案**：Rust 内核加 TS 插件宿主。它的优点是可靠、占用小、分发方便，但一开始就要维护两种语言和一套跨进程协议，对单人 MVP 来说成本过高，推迟到开源阶段再评估。

## Risks / Trade-offs

- **[风险] AI 写入的 journal 增长得很快，导致检索噪音变大。**
  对策：journal 按天分文件；检索时默认降低 journal 的权重，也可以选择排除。
- **[风险] 受管区块在用户提交之前，不会出现在新开的 worktree 里。**
  对策：同步命令在输出中提醒用户提交；M1 的执行器在创建 worktree 前先检查区块是否过时。
- **[风险] gitleaks 误报阻止了正常写入。**
  对策：拒绝信息里给出规则 ID，用户可以把它加入该仓库 `.gitleaks.toml` 的允许列表。
- **[权衡] 检索只做关键词匹配，同义词和语义相近的内容检索不到。**
  在 M0 的规模下可以接受，M3 再接入 qmd 改善。
- **[权衡] 待确认的提案放在 `state/`，不在 git 中，丢失后只能重新生成。**
  提案本身可以由 agent 重新生成，丢失的代价不高。

## Migration Plan

- 这是全新功能，不需要迁移。
- **回滚**：删除 `~/flow-home`；从两个产品仓库的 AGENTS.md 中删掉 `flow-managed` 区块；从各 harness 的配置中移除 `flow` MCP。三处互相独立。

## Open Questions

- brain、raw、config 三个仓库是否推送到私有远端（比如 GitHub 私有仓库）作为异地备份？推送与否不影响本变更的行为，可以以后用 `git remote add` 补上。
- 事实条目"可能过时"的默认有效期暂定为 90 天，使用一段时间后再调整。
