# Tasks

> 前置条件：`add-m1-inbox` 的 1.1–1.3（密钥提供器、按 token 绑定身份）已合并；`add-m1-executors` 的 1.2、1.3 已合并。
> 依赖与并行：第 1 组决定第 3 组的分支和第 4 组是否要做。第 2 组可以和第 1 组同时进行。第 3 组依赖第 2 组。第 4 组依赖第 3 组。第 5 组最后进行。

## 1. 账号验证（用户与协调者一起，不写产品代码）

- [ ] 1.1 用户确认：Grok Bot 的 Tailscale 插件已开通；tailnet 类型（个人还是公司）；在 ACL 中加入 `tag:grokbot → <Mac>:443`，并删除默认的全放行规则（如果公司 tailnet 不允许删，记录现状）
- [ ] 1.2 协调者用一个临时的 echo MCP 服务（只返回固定文本，不接触 flow-home），经 `tailscale serve` 发布，验证以下三项，并记入 `docs/grok.md`：
  - Grok 自定义 MCP 能否填固定的 Bearer 请求头；
  - Bot 在聊天中能否调用该服务；
  - 由 webhook 触发的 routine 运行中能否调用该服务。
  验证结束后执行 `tailscale serve reset`
- [ ] 1.3 根据 1.2 的结果在 design 中定下 D4 的分支，以及第 4 组是否要做；有变化时更新 proposal 和 specs

## 2. MCP 服务端与传输解耦

- [ ] 2.1 抽出 `createFlowMcpServer({ actor, home, filter })`，stdio 入口改为使用它，行为不变；验证现有 MCP 测试与 CLI/MCP 一致性测试全部通过
- [ ] 2.2 `OpContext.visibility`，以及各读取路径的 workspace 过滤（检索的 SQL 层、读取、查询、简报、任务列表）、个人条目排除；先盘点现有条目的 frontmatter 归属字段（在临时 fixture 中复现真实的字段分布，不读真实 flow-home），在 PR 中写明归属规则覆盖了哪些类型；验证 remote-mcp 的"检索不会越过白名单""个人条目不外流"场景

## 3. 远程入口

- [ ] 3.1 `config/remote.yaml` 的 schema 与加载（单个调用方出错不影响其他调用方，actor 不能为 user）、能力到操作的映射表（新增操作默认不开放）、导出 JSON Schema；验证"actor 写成 user"场景，并做映射表的快照测试
- [ ] 3.2 中枢的第二个监听端口（没有调用方时不监听）、streamable HTTP 无状态传输、远程凭证校验（只接受标注了远程调用方的 token），按调用方裁剪工具列表；验证 remote-mcp 的"不暴露中枢 API""没有远程调用方""用 user token 访问远程入口""调用未授权的工具""远程调用方不能审批"场景，以及 stdio 与远程入口的一致性测试
- [ ] 3.3 （仅在 1.3 决定走 OAuth 时）最小 OAuth 2.1：元数据、动态客户端注册、授权码加 PKCE、本机确认页（需要 `flow ui` 会话）、令牌摘要存储与撤销；验证"OAuth 授权需要用户本人确认"场景，以及 PKCE 校验失败、redirect_uri 不匹配、令牌撤销的测试
- [ ] 3.4 `remote.call` 事件与合并规则、`flow remote status`、doctor 的 Tailscale 发布检查（注入假的 `tailscale` 二进制，用 fixture 输出）；验证"被拒的调用可追溯""误开了 Funnel"场景

## 4. grok-routine 执行器（视 1.3 的结论决定是否做）

- [ ] 4.1 `task_report` 操作、`task.reported` 事件、中枢校验（actor 一致、执行器为 `grok-routine`、任务在 running、只回报一次）、续约响应中携带回报；验证 executor-grok-routine 的"为别人的任务回报""重复回报"场景，以及 knowledge-access 的"用户从 CLI 调用"场景
- [ ] 4.2 执行器：派发正文渲染与脱敏、webhook 调用（带 Idempotency-Key，非 2xx 判为失败，网络错误可重试）、等待回报、超时、取消、重新排队时先检查已有回报；验证 executor-grok-routine 其余场景（用假的 webhook 服务）

## 5. 真实环境上线

- [ ] 5.1 用户完成：`flow hub token issue grok --remote grok`、写 `config/remote.yaml`（只授权一个 workspace）、`tailscale serve`、在 Grok 中添加连接器、`flow secrets set grok/webhook-key`。协调者把步骤写入 `docs/grok.md`
- [ ] 5.2 端到端验证：在 Grok 聊天中让 Bot 检索 Flow 知识库并提交一个提案 → 用户在 Flow 中看到并处理；建一个 `grok-research` 角色的任务 → Grok 运行 → `task_report` → 任务 `done`；`flow remote status` 显示调用记录；`flow doctor` 通过
