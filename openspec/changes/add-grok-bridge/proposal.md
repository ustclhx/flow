# Proposal

## Why

用户在用 Grok Bot：SpaceXAI 的常驻 AI 智能体，每个 Bot 有自己的云端电脑，能跑定时任务（routine），有 iPhone 端。用户希望它也能成为 Flow 的一个"干活的 AI"，与 Codex、Claude 并列：能查 Flow 的知识库和任务状态，能接 Flow 派的活，干完把结果交回来。

2026-10-25 的调研结论（详见 design 的 Context）：
- Grok Bot 不能连本机或 localhost 上的 MCP，只能连远程 MCP（streamable HTTP / SSE）。Cursor 的官方 Tailscale 插件（2026-10-12 合入，灰度开放）让 Bot 以 `tag:grokbot` 设备加入用户的 tailnet，由 Cursor 后端经 tailnet 连接 MCP。
- 外部系统没有 API 往 Bot 的对话里发消息；但 routine 可以由 webhook 触发（`POST` 加 Bearer key），结果写进 Bot 的聊天。

Grok Bot 运行在第三方云上，提示词和数据会发送给 xAI 及其模型提供商。因此本变更的前提是：**Grok 只能以 AI 身份接入，只能读被授权的 workspace 和写提案，永远不能代用户审批或回复任务**。这依赖变更 ③ 的 D9（按 token 绑定操作者身份）。

## What Changes

- **远程 MCP 入口**：中枢新增一个独立的本机监听端口（默认 `127.0.0.1:7478`），只提供 MCP（streamable HTTP），不暴露中枢的 `/v1` API。用户用 `tailscale serve` 把它发布到 tailnet 内，绝不使用 Funnel。
- **远程调用方（remote client）**：`config/remote.yaml` 定义每个远程调用方：
  - 绑定的 actor（例如 `grok`）；
  - 可访问的 workspace 白名单；
  - 可用的操作集合：`read`（知识检索、workspace 简报、任务查询）、`propose`（写提案、随手记）、`report`（为派给它的任务交结果）。
  
  凭证用 ③ 的 `flow hub token issue` 签发，身份由中枢强制。不在白名单里的操作在工具列表中不出现，调用时返回 `forbidden`。
- **认证方式**：优先使用固定 Bearer token。Grok 的自定义 MCP 如果不支持固定请求头，就在中枢内实现一个最小的 OAuth 2.1 授权端点（授权码 + PKCE + 动态客户端注册），由用户在本机 Web 页面上确认授权，签发的访问令牌同样绑定 actor。实际采用哪一种，由第 1 组的账号验证决定。
- **派活给 Grok**：新增执行器 `grok-routine`。节点调用用户配置的 routine webhook，附上任务 id、目标、上下文摘要；Grok 干完后，通过 MCP 工具 `task_report` 为这个任务交结果（只能为派给自己的、仍在运行中的任务提交一次）。超时没交结果则任务失败。webhook key 存在 ③ 的密钥提供器中。
- **审计与可见性**：远程调用全部入账（actor、工具、workspace），`flow remote status` 显示每个远程调用方最近的调用和被拒次数；`flow doctor` 检查 `tailscale serve` 只发布了 MCP 端口，且没有开启 Funnel。
- **不在本次范围**：Grok 的聊天消息转发到 Flow 收件箱；Grok 在用户 Mac 上执行命令；其他云端智能体的适配（接口按通用的远程调用方设计，以后可复用）。

## Capabilities

### New Capabilities
- `remote-mcp`：远程 MCP 入口的监听方式、认证、远程调用方配置（actor、workspace 白名单、操作集合）与审计。
- `executor-grok-routine`：通过 routine webhook 把任务派给 Grok Bot，并经 `task_report` 收回结果的执行器行为。

### Modified Capabilities
- `knowledge-access`：MCP 工具集合增加按调用方裁剪的规则；新增 `task_report` 工具。

## Impact

- **代码**：`packages/hub`（新监听端口、MCP over HTTP、可选的 OAuth 端点、远程调用方配置）、`packages/mcp`（抽出与传输无关的工具注册，供 stdio 与 HTTP 共用）、`packages/node`（`grok-routine` 执行器）、`packages/core`（`config/remote.yaml` schema、`task_report` 操作、doctor 检查）。
- **依赖**：`@modelcontextprotocol/sdk` 已有，使用其 streamable HTTP 服务端传输；不新增依赖。
- **前置条件**：变更 ③ 的 1.1–1.3（密钥提供器、按 token 绑定身份）已合并；变更 ② 的执行器接口（1.2）已合并。
- **用户需要做的**：确认账号已开通 Grok Bot 的 Tailscale 插件；在 tailnet ACL 中只放行 `tag:grokbot → <Mac>:443`；在 Mac 上运行 `tailscale serve`；在 Grok 里添加 Flow 的 MCP 连接器；为要派活的 Bot 建一个 routine 并拿到 webhook key。
- **数据外流**：Grok 读到的知识条目会发送到 xAI。workspace 白名单默认为空，用户需要显式授权。
