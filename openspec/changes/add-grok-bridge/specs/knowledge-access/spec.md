# Spec Delta

## MODIFIED Requirements

### Requirement: 两种接口等价
每个知识访问操作 SHALL 同时以 CLI 子命令（`flow kb ...`）和 MCP 工具的形式提供。MCP 工具 SHALL 经由两种传输提供：本机的 `flow mcp`（stdio）和中枢的远程 MCP 入口（streamable HTTP）。同一个操作在 CLI 和两种 MCP 传输上的输入、输出和权限规则 MUST 一致；远程入口只是按调用方配置裁剪可用工具和可见 workspace，不改变单个工具的行为。MCP 调用方 MUST 有一个操作者标识：stdio 由 `--actor` 声明，远程入口由凭证决定。CLI 默认的操作者是用户本人。

#### Scenario: CLI 与 MCP 结果一致
- **WHEN** 用同一个查询词分别调用 `flow kb search` 和 MCP 工具 `kb_search`
- **THEN** 两者返回同样的条目，顺序也相同

#### Scenario: stdio 与远程入口结果一致
- **WHEN** 白名单包含 `product-res` 的远程调用方，与本机 `flow mcp --actor claude` 用同一个查询词在 `product-res` 中检索
- **THEN** 两者返回同样的条目，顺序也相同

## ADDED Requirements

### Requirement: 任务结果回报
操作注册表 SHALL 包含 `task_report` 操作，供外部执行的智能体为派给自己的任务交回结果（输入为任务 id、状态、摘要、可选的提案 id 列表）。该操作 MUST 只对远程调用方和 stdio MCP 调用方开放，并由中枢按 `executor-grok-routine` 的规则校验；CLI 上以 `user` 身份调用时返回 `forbidden`，用户应使用 `flow task cancel` 或等待超时。

#### Scenario: 用户从 CLI 调用
- **WHEN** 用户运行 `flow task report <id> --status done`
- **THEN** 返回 `forbidden`，提示该操作只供执行任务的智能体使用
