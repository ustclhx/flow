# Codex exec JSONL fixture

采集版本：本机 `codex-cli 0.164.0`，2026-10-25。

两轮均在临时工作目录中运行，使用独立临时 `CODEX_HOME`、`FLOW_HOME`，未加载用户配置与规则，沙箱为 `read-only`。只读取得本机认证文件的临时副本，采集后已删除副本，未修改真实认证或配置。

首轮：

```text
codex exec --json --ignore-user-config --ignore-rules --skip-git-repo-check -s read-only -m gpt-6.1-sol -c model_reasoning_effort="low" <prompt>
```

prompt：运行一次 `pwd`，回答 1+1，然后问接下来加哪个数字，不修改文件。

恢复轮：使用相同选项，在 `exec` 层设置沙箱，再追加 `resume <SESSION_ID> <PROMPT>`；prompt 为加 3，仅回复结果、不调用工具或提问。

- `question.jsonl`：首轮完整 stdout，含代理消息、命令执行与 token 用量。
- `resumed.jsonl`：恢复轮完整 stdout，会话 id 与首轮相同，最终回复为 5。
- 实测事件：`thread.started`、`turn.started`、`item.started`、`item.completed`、`turn.completed`。item 类型为 `agent_message`、`command_execution`。
- 脱敏：使用 core 的 `redactSecrets`，工作目录统一换成 `/Users/user/flow-codex-fixture/work`，会话 UUID 换成固定占位值；无账号、token 或真实用户名。
- `usage.input_tokens` 已包含缓存部分，直接映射；`cached_input_tokens` 等细分字段保留在 fixture。CLI 未报告美元费用，因此省略可选的 `TaskCost.usd` 字段。

测试使用 `process.execPath` 运行临时假脚本输出这些事件，绝不启动真实 Codex。
