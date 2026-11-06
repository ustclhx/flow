# Harness 接入

各 harness 访问 Raindown 知识库的方式。MCP 服务通过 `raindown mcp --actor <name>` 以 stdio 启动；
actor 用于提交记录和写入规则判断，MCP 下不允许使用 `user`。

| Harness | 方式 | 注册命令 / 配置位置 | actor |
|---|---|---|---|
| Claude Code | MCP | `claude mcp add --scope user raindown -- raindown mcp --actor claude`（写入 `~/.claude.json`） | `claude` |
| Codex | MCP | `codex mcp add raindown -- raindown mcp --actor codex`（写入 `~/.codex/config.toml`） | `codex` |
| oh-my-pi | MCP | `~/.omp/agent/mcp.json`（见下） | `omp` |
| pi | CLI + skill | 把 `skills/raindown-kb/` 复制到 `~/.pi/agent/skills/raindown-kb/` | `pi` |

oh-my-pi 的用户级 MCP 配置（`~/.omp/agent/mcp.json`）：

```json
{
  "mcpServers": {
    "raindown": { "type": "stdio", "command": "raindown", "args": ["mcp", "--actor", "omp"] }
  }
}
```

## 验证（2026-10-24）

每个 harness 以非交互模式调用一次 `ws_list`，都返回 `ws/global, ws/product-res, ws/xuanxue-saas`：

```bash
echo "Call the mcp__raindown__ws_list tool once ..." | claude -p --allowedTools mcp__raindown__ws_list
codex exec --skip-git-repo-check "Call the ws_list tool from the MCP server named raindown ..."
omp -p --no-session "Call ws_list from the raindown MCP server ..."
pi -p --no-session --model gemini-2.5-flash "Using the raindown-kb skill: search 域名, append a journal entry ..."
```

pi 的默认模型（gemini-3.1-pro 免费档）当天额度已用尽，验证时改用 `gemini-2.5-flash`。

## 卸载

```bash
claude mcp remove --scope user raindown
codex mcp remove raindown
rm ~/.omp/agent/mcp.json          # 若其中还有其他服务器，只删除 raindown 一项
rm -r ~/.pi/agent/skills/raindown-kb
```
