# Tasks

> 前置条件：`add-m1-ledger-daemon` 已合并；`add-m1-executors` 的 1.3 节（回复机制）已合并。
> 依赖与并行：第 1 组完成后，第 2、3、4 组可以并行；第 5 组依赖第 1、4 组；第 6 组依赖第 1、2、5 组；第 7 组最后进行。

## 1. 密钥提供器

- [ ] 1.1 `flow secrets init|set|list|get`：生成 age 密钥（0600）、写入 `.sops.yaml` 与加密文件并提交；`set` 从标准输入读取值，不经过 argv；`get` 只允许 user 调用；显式设置 `SOPS_AGE_KEY_FILE`；验证 secret-provider spec 的前两个场景（测试中使用临时生成的 age 密钥和临时 config 仓库）
- [ ] 1.2 中枢运行时解析 `secret://`，加上内存中的脱敏名单（账本写入前、日志、外发内容；长度小于 8 的值不入名单）；缺少密钥时只停用依赖它的功能；验证 secret-provider 的"token 未配置"和 secret-hygiene 增量的场景

## 2. 策略引擎

- [ ] 2.1 `config/policies.yaml` 的 schema 与加载（单条规则出错不影响其他规则）；core 中的动作识别映射表（工具名，以及 git push、gh pr create、gh pr merge、wrangler deploy 等命令前缀）；导出 JSON Schema；验证 policy-engine 的"一条规则写错"和"命令映射"场景
- [ ] 2.2 判定算法（具体程度排序、并列时取保守档位）、`pr.merge` 和 `deploy` 的特殊规则、`policy.decided` 事件，以及 `POST /v1/policy/check`；验证 policy-engine 的其余场景，并用表驱动测试覆盖优先级组合
- [ ] 2.3 节点侧的预检：执行器发起审批请求时先调用 policy check，结果为 auto 或 auto-report 时在本地放行，调用失败时按需要用户处理；codex-orca 把 approve 和 deny 映射为 Codex 授权提示的按键；验证 fake 执行器和 codex-orca 的 fixture 测试

## 3. 收件箱核心

- [ ] 3.1 收件箱事件与投影；反应器（task.blocked、unblocked、终态、policy auto-report 到条目的转换，以源事件 seq 作为幂等键，重建时不重复）；提案目录的监听与扫描；`config/inbox.yaml` 中的分级覆盖；验证 inbox spec 的"条目来源""默认分级""自动关闭"场景，并验证投影重建后条目一致
- [ ] 3.2 操作映射与 `inbox_list`、`inbox_act` 操作（AI 只能忽略自己发起的条目），以及 `flow inbox` 的表格输出；验证 inbox 的"操作"和"查询"场景，且 CLI 与 MCP 一致性测试自动覆盖这两个新操作
- [ ] 3.3 推送节奏：Interrupt 立即推送、静默时段顺延、Decide 按时间点或数量合并推送、每日摘要内容；验证用注入时钟测试 inbox 的"推送节奏"场景

## 4. 渠道接口

- [ ] 4.1 渠道插件接口（发送、更新、入站操作），中枢内的渠道管理器（隔离失败、退避重试、补推 pending 条目），外发内容的脱敏与截断；验证 notify-channel spec 的全部场景（用一个内存中的假渠道）

## 5. Telegram 渠道

- [ ] 5.1 Bot API 客户端（getUpdates 长轮询、sendMessage HTML 转义、editMessageText、answerCallbackQuery、代理配置）、offset 持久化、`flow telegram link` 绑定流程与 chat 白名单；验证用假的 Telegram HTTP 服务测试绑定、陌生 chat 被忽略、重启后不重复处理
- [ ] 5.2 条目消息的渲染与内联按钮（callback_data 不超过 64 字节）、按钮操作与消息回改、回复消息到条目的映射、命令 `/inbox`、`/status`、`/capture`、`/ask`；验证 telegram-channel spec 的全部场景（假服务）

## 6. Web 页面

- [ ] 6.1 `/ui` 页面（服务端渲染、按级别分组、操作按钮、局部刷新）、`flow ui` 一次性登录与会话 cookie、Origin 校验；验证 inbox-web spec 的全部场景（用 `app.request` 加上 cookie 流程的测试）

## 7. 真实环境上线

- [ ] 7.1 用户完成：安装 sops、`flow secrets init`、离线备份 age 私钥、通过 @BotFather 创建 bot、`flow secrets set telegram/bot-token`、`flow telegram link`。协调者把实际步骤写入 `docs/inbox.md`
- [ ] 7.2 端到端验证：用 fake 执行器制造一个 `blocked(question)` 的任务，手机收到推送 → 在 Telegram 中回复 → 任务恢复并完成 → 消息被改为已处理；再用 `/capture` 记一条随手记；在 Web 页面批准一个审批条目，同时观察手机上的消息同步更新
