# Tasks

> 依赖与并行：第 1 组完成后，第 2 组和第 6 组可以并行；第 3 组依赖第 2 组；第 4 组和第 5 组依赖第 3 组，二者之间可以并行；第 7 组最后进行。

## 1. 脚手架

- [x] 1.1 建立 Bun workspaces monorepo：`packages/core`、`packages/cli`、`packages/mcp`，配置 TS strict 和 Biome；验证 `bun install`、`bun test`、`bunx biome check .` 在空项目上都能通过
- [x] 1.2 用 `bun link` 暴露 `flow` 命令，先只有 `flow --version`；建立 CLI 公共层，统一处理 `--json` 输出和退出码约定（0/1/2/3），并为 `bun:sqlite` 加一层薄封装；验证在任意目录下运行 `flow --version` 和 `flow --version --json` 都输出正确，CLI 公共层有单元测试
- [x] 1.3 安装 gitleaks，确定最低版本并写入 README 的依赖说明；验证 `gitleaks version` 满足这个最低版本

## 2. flow-home 与条目格式

- [x] 2.1 实现数据目录的解析逻辑（`FLOW_HOME` 优先，默认 `~/flow-home`）；验证单元测试覆盖默认和覆盖两种情况
- [x] 2.2 实现 `flow init`：创建四个子目录、初始化三个 git 仓库、写入 `brain/AGENTS.md`、`index.md`、`log.md`，以及各仓库的 `.gitleaks.toml` 和提交前钩子；行为必须幂等；验证集成测试在临时 `FLOW_HOME` 下初始化两次，第二次不改动任何已有文件
- [x] 2.3 用 zod 定义 11 种条目类型及各自的必填字段，包括 decision 的字段、事实条目的 `sources` 与 `last_verified`；由同一份定义生成 `brain/AGENTS.md` 中的字段说明，并导出 JSON Schema 到 `schemas/`（纳入版本管理，CI 检查是否与定义一致）；验证每种类型都有合法和非法的样例测试，且运行 `bun run schemas:check` 时没有差异
- [x] 2.4 实现 `flow kb validate`：报告必填字段缺失、未知类型、owner 无效、出处缺失（用户手写时只警告）、可能过时和从未核实的条目；验证测试覆盖 knowledge-base 与 resource-registry 两份 spec 中的全部校验场景
- [x] 2.5 实现 `flow doctor`；验证缺少 gitleaks 或钩子时以非零状态退出，并给出修复提示

## 3. 写入路径（核心）

- [x] 3.1 实现跨进程写锁（`state/write.lock`，带超时）；验证测试中两个进程并发写 journal，最终两条记录都完整写入
- [x] 3.2 实现写入前的密钥扫描（通过 stdin 调用 gitleaks，脱敏输出），并允许 `secret://` 引用通过；验证测试中含假 Stripe key 的写入被拒绝且错误里不含原文，含 `secret://` 引用的写入正常通过
- [x] 3.3 实现统一的写入模块，流程为：校验 → 扫描 → 写文件 → 重新生成 index → 追加 log → git 提交（作者为 `Flow (<actor>)`）；验证一次写入恰好产生一次提交，index 和 log 也都更新
- [x] 3.4 在写入模块中加入 AI 写入边界：拒绝 AI 直接写入 decision 和 personal 条目，禁止修改 log 的已有行和 raw 的已有文件，runbook 必须附出处；验证测试覆盖 knowledge-access spec 中"AI 写入边界"的全部场景

## 4. 知识访问：CLI

- [x] 4.1 实现 FTS5 trigram 索引（`state/index.db`），支持增量重建，并为少于 3 个字符的查询提供 `LIKE` 兜底；`flow kb search`；验证中文查询"干支日"（3 字）和"域名"（2 字）都能命中测试条目
- [x] 4.2 实现 `flow kb get <id>` 和 `flow kb query key=value...`；验证 `type=data-source owner=ws/xxx` 的过滤测试
- [x] 4.3 实现 `flow kb journal`、`flow capture`；验证 journal 写入当天文件，capture 只写 `raw/inbox/` 且 brain 没有变化
- [x] 4.4 实现提案功能：`flow kb propose`（提交时做校验和出处检查），`flow kb proposals list|diff|accept|reject [--all] [--reason]`，接受时用 base_hash 检测冲突，被拒绝的提案连同理由一起归档；验证测试覆盖批量接受和冲突两个场景
- [x] 4.5 实现 `flow ws list`、`flow ws resources <ws> [--type]`、`flow resource transfer`，以及 workspace 简报 `flow ws brief <ws> [--budget]`；验证 transfer 产生 owner-change 日志，简报超出预算时截断并注明省略了什么

## 5. 知识访问：MCP 与 harness 接入

- [x] 5.1 实现 `flow mcp --actor <name>`（stdio 传输），把第 4 组的每个操作暴露为 MCP 工具，参数描述由 schema 生成；验证对每个工具做一次 CLI 与 MCP 结果一致的对比测试
- [x] 5.2 在 Claude Code、Codex、oh-my-pi 中注册 `flow` MCP，各自使用对应的 actor；验证在每个 harness 中都能调用 `kb_search` 并得到结果，实际使用的注册命令记录到 `docs/harness-setup.md`
- [x] 5.3 为 pi 编写一个 skill 文件，说明 `flow kb` CLI 的用法和写入规则；验证在 pi 会话里能按 skill 的说明完成一次检索和一次 journal 追加

## 6. 受管区块

- [x] 6.1 实现受管区块的确定性渲染：包括所属 workspace、项目卡片位置、资源摘要、访问方式、写入规则，大小不超过 2000 字符；验证同样的输入两次渲染结果逐字节相同
- [x] 6.2 实现 `flow agents sync [--check]`：只替换区块内部、不提交、检测标记损坏；验证测试 fixture 中 turborepo 区块逐字节不变，`--check` 在内容过时时以非零状态退出且不写入任何文件

## 7. 首批录入与端到端验收

- [x] 7.1 在真实的 `~/flow-home` 上运行 `flow init`，编写 `config/workspaces/product-res.yaml` 和 `xuanxue-saas.yaml`；验证 `flow doctor` 通过，`flow ws list` 列出 3 个 workspace
- [x] 7.2 让 Claude 读取两个产品仓库（README、`template.config.ts`、`wrangler.jsonc`、`docs/`），以提案形式提交以下条目：项目卡片、product、domain（arcanumber.com、ganjiday.com、product.ezarouter.cc；后者的出处写"用户确认 2026-10-24"，并注明 wrangler 中的生产路由是占位值）、service（各自的 web 和 jobs Worker）、repo、data-source（Sentry、Stripe、Cloudflare Web Analytics、`/api/health`），以及指向 `docs/runbooks/` 的条目；查不到依据的字段一律留空；验证每个提案都带出处
- [ ] 7.3 用户审阅后批量接受提案；验证 `flow kb validate` 没有错误，只列出"从未核实"的条目，`flow ws resources xuanxue-saas --type domain` 返回两个域名
- [ ] 7.4 对两个产品运行 `flow agents sync`，用户审阅差异后在产品仓库中提交；验证 `flow agents sync --check` 以零状态退出，turborepo 区块没有变化
- [ ] 7.5 端到端检验：在 product-res 中新开一个 Claude Code 会话，只问"这个项目的生产域名和监控数据源是什么"，验证它通过受管区块和 `flow` MCP 答对了（product.ezarouter.cc，以及 Sentry 和 `/api/health`）
