# 执行器与角色

节点按任务合同的 `executor` 选择执行器，按 `role` 读取 `$FLOW_HOME/config/roles/<name>.yaml`。
`flow init` 补齐下面的三个默认角色及同名提示词文件，已有文件不覆盖。

| 执行器 | 默认角色 | 适用场景 | 依赖与交互 |
| --- | --- | --- | --- |
| `codex-orca` | `dev` | 交互式的长开发任务，在独立 worktree 中修改、提交、推送并开 PR | Codex CLI、Orca CLI 和正在运行的 Orca 应用；用 gh 检查 PR；提问或审批时保持终端和租约 |
| `claude-sdk` | `reviewer` | 审查等无头任务，不需要盯着终端 | Claude Agent SDK、SDK 随包安装的原生 claude CLI 和 Claude 凭证；需要审批时挂起等待 |
| `codex-exec` | `triage` | 在只读沙箱中收集证据、做分诊 | Codex CLI 的 `exec --json` 和 `exec resume`；提问后结束一轮，回复后恢复同一会话 |

中枢和节点需要运行；前台命令分别是 `flow hub start`、`flow node start`，各占一个终端。
常驻方式见 [守护进程](daemon.md)。Orca 模式的仓库必须登记在合同所属 workspace 的 `repos` 中，
并已导入 Orca；节点还需要能访问远端仓库的 git、gh 环境。Flow 不负责合并 PR 或清理 worktree。

## doctor 检查

在**节点实际使用的环境**中运行：

```sh
flow doctor
flow doctor --json
```

| 检查标识 | 检查内容 |
| --- | --- |
| `tool.codex` | PATH 中的可执行文件、`codex --version` 的退出码与版本；最低验证版本 `0.164.0` |
| `tool.orca` | PATH 中的可执行文件、`orca --version` 的退出码与版本；最低验证版本 `1.4.218` |
| `orca.app` | `orca terminal list --json` 返回成功信封和 terminals 数组；失败时提示启动 Orca 应用 |
| `tool.claude-sdk` | 能 import `@anthropic-ai/claude-agent-sdk`、存在 query 导出、包版本可解析；从 `@flow/node` 的 package.json 位置解析 SDK，并读取其中声明的期望版本 |
| `tool.claude` | SDK 默认使用的当前平台原生 CLI 文件存在且可执行；PATH 上另装的 claude 不会替代缺失的 SDK 原生包 |
| `claude.credentials` | `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`CLAUDE_CODE_OAUTH_TOKEN` 之一非空，或 Claude 配置目录下存在 `.credentials.json` |
| `role.<name>.creatable_by` | 角色没有 `creatable_by` 时给 info 提示：只有 user 可以创建该角色的任务（见下文） |

Claude 配置目录取 `CLAUDE_CONFIG_DIR`，否则取用户目录的 `.claude`。凭证只查存在性，
不读取文件内容、不输出变量值、不运行 claude、不发起 API 调用；不能确认过期、权限或订阅额度。
macOS 登录可能仅在 Keychain 中：没有上述来源、但存在系统 security 命令时，报告 warning、请人工确认，
不访问 Keychain 凭证。其他平台缺少来源时按依赖缺失处理。

严重度按已成功加载的角色计算，消息会列出引用角色：

- 被引用的执行器缺少依赖、版本命令失败或输出无法解析：`error`，doctor 退出码 1；
- Codex / Orca 低于最低验证版本：`warning`，建议升级，不单独导致非零退出；这一下限来自现有实测 fixture，不代表历史版本一定不可用；
- 没有角色引用的执行器：`info` 并跳过探测；Codex 被 `codex-orca` 或 `codex-exec` 任一角色引用就需要检查；
- 角色缺少 `creatable_by`：`info`，不影响退出码；
- 原有的目录、git、gitleaks、角色配置错误仍为 `error`。只有 info / warning 时退出码为 0。

`flow init` 默认生成三个真实角色，所以刚初始化的环境会要求全部依赖。
仅用 fake 的测试环境可以移除临时目录中的默认角色 YAML，改为 fake 角色。
每条外部探测命令有 10 秒超时；测试通过注入命令执行、二进制查找与 SDK 探测来运行，不依赖 CI 安装这些工具。

## 谁能创建该角色的任务：`creatable_by`

角色 YAML 可选字段 `creatable_by` 列出除 `user` 之外允许创建该角色任务的身份，中枢在创建任务时校验
（规则、错误码和生效时机见 [中枢鉴权的角色创建权限](hub-auth.md#角色创建权限creatable_by)）：

```yaml
creatable_by:
  - reviewer        # 精确值：reviewer 执行器（flow mcp --actor reviewer）的身份
  - "agent:claude"  # 精确值
# - "*"            # 任意非 user 身份
```

- `user` 永远可以创建；字段缺省时只有 `user` 可以创建，AI 和节点会得到 403 `role_not_allowed`。
- 默认模板：dev 不写（只有 user 能派发开发任务，AI 不能借 dev 跳过审批和沙箱）；只读的 reviewer、triage 为 `["*"]`，
  任何非 user 身份都可以拆出审查、分诊子任务。
- 本机 AI 的身份就是执行器注入的 `flow mcp --actor <角色名>`：reviewer 执行器的身份是 `reviewer`，不是 `node:*`。
  要只放开某个执行器，写它的角色名，例如 `creatable_by: [reviewer]`。
- 节点 token 和 remote token 在本机端口都不能创建任务（`scope_denied`、`remote_not_allowed`），`*` 不会放开它们。
- `flow init` 不覆盖已有角色文件，升级前创建的 reviewer、triage 没有这个字段（只有 user 能创建），
  需要时手动补上；`flow doctor` 会对缺少字段的角色给出 info 提示（不是错误，不影响退出码）。
- 给高权限角色（例如跳过审批的 dev）加 `creatable_by` 等于允许这些身份间接取得该权限，应和 `permissions` 一起审查。


### dev：codex-orca

`config/roles/dev.yaml`（提示词来自同目录 `dev.md`）：

```yaml
# 没有 creatable_by：只有 user 可以创建 dev 任务（AI 与节点不能借 dev 提权）。
name: dev
executor: codex-orca
model: gpt-6.1-sol
effort: high
prompt: dev.md
permissions:
  approval: never
  sandbox: danger-full-access
```

`approval` 对应 Codex 的 `-a` 审批模式，`sandbox` 对应 `-s` 沙箱模式。
这两个默认值组合会变成 `--dangerously-bypass-approvals-and-sandbox`，沿用用户原来的脚本做法。
`permissions.config` 是额外的 Codex `-c key=value`，值支持字符串、数字和布尔值。
它会影响 Codex 的实际权限和行为，应与审批、沙箱字段一起审查。

收紧权限时可以另建临时角色 `dev-approval.yaml`，并复制一份 dev 提示词或继续引用 `dev.md`：

```yaml
name: dev-approval
executor: codex-orca
model: gpt-6.1-sol
effort: high
prompt: dev.md
permissions:
  approval: on-request
  sandbox: workspace-write
  config:
    approvals_reviewer: user
```

### reviewer：claude-sdk

```yaml
name: reviewer
executor: claude-sdk
model: claude-opus-5-5
prompt: reviewer.md
creatable_by:
  - "*"
permissions:
  permissionMode: default
  setting_sources: []
  allowedTools:
    - Read
    - Glob
    - Grep
    - "Bash(gh pr comment:*)"
    - "Bash(gh pr review:*)"
  disallowedTools:
    - Edit
    - Write
    - NotebookEdit
```

- `permissionMode` 默认 `default`：未被 SDK 权限规则直接放行的调用进入 `canUseTool`。
  节点先做 Flow 策略预检，需要人决定时报告 `blocked(awaiting_approval)`，等待回复；
  `auto` 可能由 SDK 自动放行，`bypassPermissions` 跳过 SDK 权限审批，只有明确理解后才显式设置。
- `setting_sources` 传给 SDK 的 `settingSources`，可选 `user`、`project`、`local`，缺省为 `['project']`。
  reviewer 特意使用 `[]`：被审查仓库的 `.claude/settings.json` 可能包含直接执行命令的 hooks，
  或在 Flow 审批前就生效的 `permissions.allow`。不加载项目设置才能避免这些规则影响审查权限。
  不含 `project` 时，Flow 将 cwd 下 `CLAUDE.md`、`AGENTS.md` 作为限长、脱敏的纯文本追加到提示词。
- `allowedTools` 是 SDK 的免询问工具规则，`disallowedTools` 禁用写文件类工具。
  reviewer 可以评论和提交 PR review，但其他 Bash 调用仍可能需要审批；这不等于操作系统级只读隔离。
- 可选 `maxTurns` 限制轮次；`approval_timeout_minutes` 默认 1440（24 小时），超过后任务以 `approval_timeout` 失败。

执行器自动注入 `flow mcp --actor reviewer`（其他角色用各自名字）。Flow MCP 的固定放行清单为：
`kb_search`、`kb_get`、`kb_query`、`kb_journal`、`capture`、`kb_propose`、`ws_brief`、`task_list`、`task_show`，
工具全名带 `mcp__flow__` 前缀。这些写入仍受 AI 写入边界限制，提交提案不等于接受提案。
`task_create` 可借 dev 角色扩大权限（中枢另按 `creatable_by` 拒绝，见上文），`task_cancel`、`task_reply` 可干预任务，
接受/拒绝提案、转移资源及以后新增的工具也不在固定清单中。不要用宽泛的 allowedTools 绕过这层审批。
`task_reply` 另有用户身份限制：worker 不能代替用户批准自己。

### triage：codex-exec

```yaml
name: triage
executor: codex-exec
prompt: triage.md
creatable_by:
  - "*"
permissions:
  sandbox: read-only
```

`sandbox` 可取 `read-only`（缺省）、`workspace-write`、`danger-full-access`，控制初始执行与恢复执行的 Codex 沙箱。
此执行器没有交互审批通道；分诊角色保持只读。也支持标量形式的 `permissions.config`。
最后一条代理消息若是提问，任务进入 `blocked(question)`；用户文字回复后重新排队，带会话 id 用 exec resume 继续。

## 安全边界

以 [policy README 的“信任边界与局限”](../packages/core/src/policy/README.md#信任边界与局限) 为准：
节点属于可信计算基，中枢判定之后由节点实际放行。Bash / CodexCommand 的静态识别只能尽力识别常见写法；
宽泛的 Bash 自动放行实质上允许任意代码，真正的边界应放在沙箱、工具权限和文件系统/网络隔离上。

默认 dev 会跳过 Codex 审批和沙箱，可以以节点的系统用户权限执行命令、读写文件和访问网络，
不会保证每个危险动作都经过 Flow。只给可信仓库和已授权任务使用，收紧时使用上面的临时角色。
同一系统用户下能读取中枢 user token 的进程还可以取得用户身份，见 [中枢鉴权的信任边界](hub-auth.md#信任边界)。
角色、workspace 和 policies 配置本身也属于提权面。

## 从 orca-codex 脚本迁移

原来的 `~/.claude/scripts/orca-codex/dispatch-codex.sh` 负责建 worktree、写任务说明和启动 Codex，
`watch-codex.sh` 负责读终端、发现停止后手工处理。迁移后对应为：

| 原来的步骤 | Flow 对应 |
| --- | --- |
| dispatch-codex.sh 手工派发 | `flow task create --file <合同>`；节点按 dev 角色建 worktree、渲染说明并启动 Codex |
| watch-codex.sh 循环读终端 | 节点默认每 30 秒轮询；连续两次无忙碌标记后判断 PR、审批、提问等状态 |
| 人工看终端是否完成 | `flow task show <id>` 查看合同、结果、PR 产物、验收与事件；任务说明保存在 `state/tasks/<id>/spec.md` |
| 人工向终端回答 | `flow task reply <id> "用方案 A"`，或 `--approve` / `--deny` |
| 分散查看卡住的 worker | `flow inbox` 集中查看待处理条目 |

迁移步骤：

1. 在选定的 FLOW_HOME 初始化角色；确认 `config/workspaces/product-res.yaml` 的 `repos` 包含实际仓库绝对路径，
   仓库也已导入 Orca。启动 Orca 应用、中枢和节点，再运行 doctor。
2. 将原来传给脚本的说明保存为 `contract.json`。下面是 dev 合同的最小结构，目标应明确范围与完成条件：

```json
{
  "goal": "只修正 README.md 的一处模板残留，提交并开 PR，不合并。",
  "workspace": "ws/product-res",
  "role": "dev",
  "executor": "codex-orca"
}
```

3. 运行 `flow task create --file contract.json`，记下返回的任务 id。
   仓库唯一时从 workspace 推导；多个仓库时在合同中加 `cwd` 或 `inputs.repo` 的绝对路径。
   可加 `inputs.scope: ["README.md"]` 明确修改范围，`context` 引用知识，
   `verify: [{"cmd":["bun","test"]}]` 指定验收命令（应换成该仓库实际的检查）。
   verify 是 argv，不经过 shell；有验收命令时成功后先进入 verifying，全部通过才 done。
   合同 `executor` 是必填字段且优先于角色值，换角色时应一起检查。
4. 用返回的 id 替换下面的 `<id>`。仅 blocked 任务能回复；提问必须用文字，批准不能附带文字，拒绝可以附理由：

```sh
flow task show <id>
flow inbox
flow task reply <id> "用方案 A"
flow task reply <id> --approve
flow task reply <id> --deny "不要推送，先补测试"
```

交互式执行器在下一次续约送达回复并恢复运行；codex-exec 会重新排队恢复会话。
原脚本可以保留，但不要同时监控或向同一个任务发送输入。确认流程可用后，用户再自行更新个人派发约定；
Flow 不调用、不修改 `~/.claude/scripts` 或个人 CLAUDE.md。

## 临时环境验证命令

在仓库根目录、有 bun / git / gitleaks 的环境中，下面的冒烟流程只使用 fake 执行器，
不运行 Codex、Orca 或 Claude，不访问个人 `.codex` / `.claude`；不安装或调整 launchd 服务。
`flow` 函数指向当前 checkout 的 CLI。doctor 仍会只读检查已安装的 Flow plist 路径。
端口 17477 需要空闲；两个后台 PID 只用于停止本次启动的前台进程。

```sh
FLOW_DEMO_DIR="$(mktemp -d)"
export FLOW_HOME="$FLOW_DEMO_DIR/home"
flow() { bun packages/cli/src/main.ts "$@"; }
flow init
rm "$FLOW_HOME/config/roles/dev.yaml" "$FLOW_HOME/config/roles/reviewer.yaml" "$FLOW_HOME/config/roles/triage.yaml"
cat > "$FLOW_HOME/config/roles/demo.yaml" <<'YAML'
name: demo
executor: fake
prompt: 临时验证，不调用真实执行器
YAML
cat > "$FLOW_HOME/config/workspaces/demo.yaml" <<'YAML'
id: demo
kind: product
name: 演示
description: 临时验证
repos: []
YAML
printf 'port: 17477\nlease_ttl_s: 5\n' > "$FLOW_HOME/config/hub.yaml"
flow doctor
flow doctor --json
bun packages/cli/src/main.ts hub start > "$FLOW_DEMO_DIR/hub.log" 2>&1 &
FLOW_DEMO_HUB_PID=$!
until flow hub status >/dev/null 2>&1; do sleep 0.1; done
bun packages/cli/src/main.ts node start > "$FLOW_DEMO_DIR/node.log" 2>&1 &
FLOW_DEMO_NODE_PID=$!
cat > "$FLOW_DEMO_DIR/contract.json" <<'JSON'
{
  "goal": "验证提问后回复的流程",
  "workspace": "ws/demo",
  "role": "demo",
  "executor": "fake",
  "inputs": {
    "fake": {
      "outcome": "blocked",
      "blocked_reason": "question",
      "message": "使用方案 A 吗？",
      "resume": { "message": "已按方案 A 完成" }
    }
  }
}
JSON
flow task create --file "$FLOW_DEMO_DIR/contract.json" --json > "$FLOW_DEMO_DIR/task.json"
FLOW_DEMO_TASK_ID="$(bun -e 'console.log((await Bun.file(process.argv[1]).json()).data.task.id)' "$FLOW_DEMO_DIR/task.json")"
until flow task show "$FLOW_DEMO_TASK_ID" --json | bun -e 'process.exit((await Bun.stdin.json()).data.task.status === "blocked" ? 0 : 1)'; do sleep 0.1; done
flow task show "$FLOW_DEMO_TASK_ID"
flow inbox
flow task reply "$FLOW_DEMO_TASK_ID" "用方案 A"
until flow task show "$FLOW_DEMO_TASK_ID" --json | bun -e 'process.exit((await Bun.stdin.json()).data.task.status === "done" ? 0 : 1)'; do sleep 0.1; done
flow task show "$FLOW_DEMO_TASK_ID"
kill "$FLOW_DEMO_NODE_PID" "$FLOW_DEMO_HUB_PID"
wait "$FLOW_DEMO_NODE_PID" "$FLOW_DEMO_HUB_PID"
```

成功时 doctor 退出 0，真实执行器检查为 info；create 返回 queued，随后 blocked(question)，
文字回复后重新排队，最终 done，摘要为“已按方案 A 完成”。重新领取可能需等待一次默认 30 秒长轮询。
临时目录保留供检查日志。
执行完后应在新的终端继续日常工作，避免沿用本次导出的临时 FLOW_HOME。

## 真实环境验证（任务 6.1、6.2）

本次 7.1 只完成 doctor 和 fake 冒烟，不代表 6.1、6.2 已通过。真实验证要另外记录任务 id、版本、PR、
信任提示与授权请求片段、回复和最终验收结果；不要把 fake 的结果当作真实 harness 的证据。

本机已知环境：`~/.codex/config.toml` 信任了 home 目录，并启用了 `approvals_reviewer = "auto_review"`。
因此新 worktree 不一定出现信任提示，`on-request` 角色也不一定出现需要用户答复的授权请求。
这不能用来证明信任提示处理或审批送达已被覆盖。为 6.2 另建上面的 dev-approval 角色，
在 `permissions.config` 中显式设 `approvals_reviewer: user`，并选择确实需要越出沙箱的操作，
再用 task reply 的 approve 走完闭环。不要为此修改个人 Codex 配置或取消现有 home 信任。

reviewer 的 canUseTool 审批需要选择不在 allowedTools 中、也未被 Flow 策略自动放行的工具请求；
triage 则需先得到一条真实提问，再用文字回复验证 exec resume。Codex TUI 文本会随版本变化，
识别问题应附脱敏的终端片段，更新 fixture 后再验证。
