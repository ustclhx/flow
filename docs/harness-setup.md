# Harness 接入

各 harness 访问 Flow 知识库的方式。MCP 服务通过 `flow mcp --actor <name>` 以 stdio 启动；
actor 用于提交记录和写入规则判断，MCP 下不允许使用 `user`。

| Harness | 方式 | 注册命令 / 配置位置 | actor |
|---|---|---|---|
| Claude Code | MCP | `claude mcp add --scope user flow -- flow mcp --actor claude`（写入 `~/.claude.json`） | `claude` |
| Codex | MCP | `codex mcp add flow -- flow mcp --actor codex`（写入 `~/.codex/config.toml`） | `codex` |
| oh-my-pi | MCP | `~/.omp/agent/mcp.json`（见下） | `omp` |
| pi | CLI + skill | 把 `skills/flow-kb/` 复制到 `~/.pi/agent/skills/flow-kb/` | `pi` |

oh-my-pi 的用户级 MCP 配置（`~/.omp/agent/mcp.json`）：

```json
{
  "mcpServers": {
    "flow": { "type": "stdio", "command": "flow", "args": ["mcp", "--actor", "omp"] }
  }
}
```

## 验证（2026-10-24）

每个 harness 以非交互模式调用一次 `ws_list`，都返回 `ws/global, ws/product-res, ws/xuanxue-saas`：

```bash
echo "Call the mcp__flow__ws_list tool once ..." | claude -p --allowedTools mcp__flow__ws_list
codex exec --skip-git-repo-check "Call the ws_list tool from the MCP server named flow ..."
omp -p --no-session "Call ws_list from the flow MCP server ..."
pi -p --no-session --model gemini-2.5-flash "Using the flow-kb skill: search 域名, append a journal entry ..."
```

pi 的默认模型（gemini-3.1-pro 免费档）当天额度已用尽，验证时改用 `gemini-2.5-flash`。

## 卸载

```bash
claude mcp remove --scope user flow
codex mcp remove flow
rm ~/.omp/agent/mcp.json          # 若其中还有其他服务器，只删除 flow 一项
rm -r ~/.pi/agent/skills/flow-kb
```
