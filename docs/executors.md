# 执行器与角色

节点按任务合同的 `executor` 选择执行器，按 `role` 读取 `$FLOW_HOME/config/roles/<name>.yaml`。
`flow init` 补齐下面的三个默认角色，以及 ④ 新增的 `supervisor`（AI 主管，见 [supervisor.md](supervisor.md)）、`pr-reviewer`（只读 PR 审查，claude-sdk）、`merger`（合并，pr-merge 执行器）和同名提示词文件，已有文件不覆盖。

| 执行器 | 默认角色 | 适用场景 | 依赖与交互 |
| --- | --- | --- | --- |
| `codex-orca` | `dev` | 交互式的长开发任务，在独立 worktree 中修改、提交、推送并开 PR | Codex CLI、Orca CLI 和正在运行的 Orca 应用；用 gh 检查 PR；提问或审批时保持终端和租约 |
| `claude-sdk` | `reviewer` | 审查等无头任务，不需要盯着终端 | Claude Agent SDK、SDK 随包安装的原生 claude CLI 和 Claude 凭证；需要审批时挂起等待 |
| `codex-exec` | `triage` | 在只读沙箱中收集证据、做分诊 | Codex CLI 的 `exec --json` 和 `exec resume`；提问后结束一轮，回复后恢复同一会话 |
| `pr-merge` | `merger` | 合并已审查通过的 PR 并等待主分支流水线；不调用模型，只由中枢（或 user）创建 | gh；只能在本机节点运行，见下文「merger：pr-merge」 |

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
| `role.<name>.creatable_by` | 角色的 `creatable_by` 缺省或为 `[]` 时给 info 提示：仅 user 可创建该角色的任务（见下文） |

Claude 配置目录取 `CLAUDE_CONFIG_DIR`，否则取用户目录的 `.claude`。凭证只查存在性，
不读取文件内容、不输出变量值、不运行 claude、不发起 API 调用；不能确认过期、权限或订阅额度。
macOS 登录可能仅在 Keychain 中：没有上述来源、但存在系统 security 命令时，报告 warning、请人工确认，
不访问 Keychain 凭证。其他平台缺少来源时按依赖缺失处理。

严重度按已成功加载的角色计算，消息会列出引用角色：

- 被引用的执行器缺少依赖、版本命令失败或输出无法解析：`error`，doctor 退出码 1；
- Codex / Orca 低于最低验证版本：`warning`，建议升级，不单独导致非零退出；这一下限来自现有实测 fixture，不代表历史版本一定不可用；
- 没有角色引用的执行器：`info` 并跳过探测；Codex 被 `codex-orca` 或 `codex-exec` 任一角色引用就需要检查；
- 角色的 `creatable_by` 缺省或为空数组：`info`，不影响退出码；
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
- 默认模板：dev 不写（只有 user 能派发开发任务，AI 不能借 dev 跳过审批和沙箱）；reviewer、triage 为 `["*"]`，
  任何非 user 身份都可以拆出审查、分诊子任务。
- 本机 AI 的身份由执行器设置的 `FLOW_ACTOR=<角色名>` 声明（claude-sdk 另注入 `flow mcp --actor <角色名>`）：reviewer 执行器的身份是 `reviewer`，不是 `node:*`。
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
    - NotebookEdit
  writable_paths:
    - "docs/**/*.md"
    - "docs/**/*.mdx"
    - "docs/**/*.txt"
    - "docs/**/*.png"
    - "docs/**/*.svg"
    - "docs/**/*.jpg"
    - "docs/**/*.jpeg"
    - "docs/**/*.gif"
    - "docs/**/*.webp"
    - "**/*.md"
    - "**/*.mdx"
```

- `permissionMode` 默认 `default`：未被 SDK 权限规则直接放行的调用进入 `canUseTool`。
  节点先做 Flow 策略预检，需要人决定时报告 `blocked(awaiting_approval)`，等待回复；
  `auto` 可能由 SDK 自动放行，`bypassPermissions` 跳过 SDK 权限审批，只有明确理解后才显式设置。
- `setting_sources` 传给 SDK 的 `settingSources`，可选 `user`、`project`、`local`，缺省为 `['project']`。
  reviewer 特意使用 `[]`：被审查仓库的 `.claude/settings.json` 可能包含直接执行命令的 hooks，
  或在 Flow 审批前就生效的 `permissions.allow`。不加载项目设置才能避免这些规则影响审查权限。
  不含 `project` 时，Flow 将 cwd 下 `CLAUDE.md`、`AGENTS.md` 作为限长、脱敏的纯文本追加到提示词。
- `allowedTools` 是 SDK 的免询问工具规则，`disallowedTools` 禁用指定工具，reviewer 保留 `NotebookEdit` 禁令。
- `writable_paths` 仅适用于 `claude-sdk`；其他执行器（包括 `codex-orca`、`codex-exec`）配置它会报配置错误。
  它是 Flow 的文件工具路径白名单，适用于 `Write`、`Edit`、`MultiEdit`；`NotebookEdit` 始终拒绝。
  路径相对合同 cwd，支持 `*`（不跨目录）、`**`（跨目录）、`?`（单字符），不支持花括号扩展，其余字符按字面匹配；默认模板已按扩展名展开。
  默认 reviewer 可直接写 `docs/` 下的 md、mdx、txt、png、svg、jpg、jpeg、gif、webp，
  以及任意目录（含根目录）的 `*.md`、`*.mdx`。
  原始路径与解析符号链接后的真实路径都必须匹配；允许 cwd 内绝对路径，拒绝任何 `..` 路径段、以 `~` 开头或首尾有空白的路径、
  cwd 外路径及无法确认真实位置的路径。新文件校验最近的已存在祖先。
  不论白名单如何配置，任何隐藏路径段（以 `.` 开头）和任意层级的 `CLAUDE.md`、`CLAUDE.local.md`、
  `AGENT.md`、`AGENTS.md`、`AGENTS.override.md`、`CONVENTIONS.md`、`GEMINI.md`、`copilot-instructions.md` 都硬性禁写。
  每个路径段在比较隐藏名称和指令文件名前，先做 `normalize('NFKC').toUpperCase().toLowerCase()`，
  防止 `AGENTſ.md`、`copilot-instructionſ.md`、全角字符等 Unicode 折叠变体绕过；实际写入路径保持原样，中文文档名仍允许。
  这也适用于符号链接目标，避免不可信 PR 诱导 reviewer 改写后续开发代理会加载的指令或命令。
  白名单以外的文件写入直接拒绝，不走 Flow 策略预检或用户审批；`[]` 禁止所有文件工具写入。
  字段缺省不新增写入授权，沿用旧角色的 SDK 权限和 Flow 审批行为；已有 reviewer 的 Edit/Write 禁令仍然生效。
- `canUseTool` 负责文件工具的直接放行或拒绝；同一校验也安装在 SDK `PreToolUse` hook 中，
  避免 `allowedTools`、权限模式或会话批准提前放行而跳过边界。SDK 的显式禁用规则仍生效。
  `PreToolUse` 省略 matcher，匹配所有工具：非 `mcp__` 前缀的未知工具只要输入包含 `file_path`、`notebook_path` 或 `path`，
  就直接拒绝，即使字段值不合法；已处理的文件写工具按白名单判定，已知只读工具仍走 SDK 原权限流程。
  只读清单按 SDK 0.3.310 内置名称列为 Read、Glob、Grep、LSP、ListMcpResourcesTool、ReadMcpResourceTool、
  ReadMcpResourceDirTool（当前 SDK 无 LS）。MCP 的 path 可能是资源标识，故不套用这个未知文件工具兜底，
  保留既有允许规则、Flow 策略和用户审批；这不意味着自动放行 MCP 调用。
  只在成功的 `PostToolUse` 后，将文件绝对路径去重列入 result 的 `artifacts`（`kind: file`）；
  仅获授权、被拒绝或执行失败的调用不算产物，不统计 Bash 或其他工具的写入。
- `read_scope: cwd`（add-m1-supervisor D6）仅适用于 `claude-sdk`；其他执行器配置它会报配置错误，取值目前只有 `cwd`。
  设置后同一个省略 matcher 的 `PreToolUse` hook 覆盖全部工具（`canUseTool` 中也做同样的兜底，检查出错一律拒绝），
  与 `writable_paths` 共用路径判定（`packages/node/src/claude-path-scope.ts`），用于防止读取
  `state/hub.token`、密钥存储、`~/.config/gh`、`~/.ssh` 后经任务目标外传：
  - 只认白名单工具并按字段白名单校验：Read、NotebookRead、Glob、Grep、Edit、MultiEdit、Write、NotebookEdit、TodoWrite、ToolSearch、
    WaitForMcpServers（只有服务器名列表 `servers`，按不涉及路径的值放行）；只产生输出的 StructuredOutput 只在会话配置了
    结构化输出（审查任务的 `outputFormat`）时放行，否则拒绝；带白名单外字段（包括 `FILE_PATH`、`filePath` 之类的变体）即拒绝。
    其他工具一律拒绝，包括 Bash、PowerShell、Monitor、Agent、WebFetch、WebSearch、LSP、Skill、MCP 资源工具和非 Flow 的 MCP 工具；
  - 路径字段只能落在合同 cwd（相对路径相对它解析，cwd 自身可读）或节点注入的任务私有目录（只按绝对路径匹配）内；
    拒绝以 `~` 开头（CLI 会展开为 home）、首尾有空白、含 `..` 段或 NUL、以 `.` 开头的路径段（按 NFKC 折叠比较）、越界，
    以及逐段解析后越界或落到隐藏段的符号链接；Read、NotebookRead 和 Glob/Grep 的 `path` 必须已存在。
    通过后用不带 `permissionDecision` 的 `updatedInput` 把路径改写为校验过的真实绝对路径（CLI 2.1.310 在没有决定时
    只替换输入、权限流程照常继续），确保 CLI 使用的就是检查过的路径；
  - Glob/Grep 未给 `path` 时显式补上合同 cwd 的真实路径；
  - Glob 的 `pattern`、Grep 的 `glob` 不得为绝对路径或以 `~` 开头，不得含 `..`、反斜杠或字符类 `[...]`；
    按空白拆开的每个片段中，任何段及花括号、括号分支都不得以 `.`、`/`、`?` 开头；
  - 隐藏条目：CLI 的 Grep 固定带 `--hidden`。Flow 在 `glob` 末尾追加 `!.*`；CLI 按空白（以及不含成对花括号时按逗号）
    把 `glob` 拆成多个 `--glob`，之后只再追加排除规则，而 rg 的 override 以最后命中的一条为准，因此用户片段不能覆盖这条排除。
    开启 `.github` 选项并在 cwd 根下搜索时，再追加 `/.github` 放回根下的 `.github`（没有正向片段时先补 `*`）。
    Glob 默认带 `--hidden --no-ignore`，Flow 为会话设置 `CLAUDE_CODE_GLOB_HIDDEN=false`、`CLAUDE_CODE_GLOB_NO_IGNORE=false`；
  - hook 收到的会话 cwd 与合同 cwd 的真实路径不一致时，拒绝全部非 Flow 工具；
  - Flow MCP 工具不受影响，条件是工具名为 `mcp__flow__*`，且 SDK 提供的 MCP 来源名为 `flow`、`source` 为 `dynamic`
    （执行器经 `--mcp-config` 注入的进程服务器）或 `sdk`；缺少来源信息时不豁免，`canUseTool` 也按同样的规则核对。
  读边界只拒绝或改写，从不放行：通过检查的调用仍走 SDK 权限、Flow 策略与审批；同时设置 `writable_paths` 时先判读边界，再按写白名单放行或拒绝。
  审查任务可由节点通过 `ExecutorContext.readScope` 注入私有目录，并打开 `allowDotGithub` 允许读 cwd 根下的 `.github/`（其中的隐藏段仍拒绝），默认关闭。
  残余风险（以 CLI 2.1.310 的实现为依据，未运行真实 Claude）：
  - Glob 的 `pattern` 本身作为 rg 的正向 `--glob` 传入，正向 override 优先于隐藏过滤，所以 `**/*` 这类模式仍可能列出 cwd 内隐藏文件的**名称**
    （读取其内容会被拒绝）；
  - `/.github` 按 rg 的锚定语义相对搜索根匹配，依赖 CLI 运行 rg 时的工作目录就是搜索根；若不是，`.github` 可能搜不到（只会更严），
    这一残余依赖保留，未改为绝对锚定；
  - 检查之后同一用户的其他进程仍可能并发替换文件或符号链接；这同样不是操作系统级隔离。
- reviewer 可以评论和提交 PR review，但其他 Bash 调用仍沿用策略预检与审批；不要用 Bash 或其他工具绕过文件白名单。
  这不是操作系统级文件隔离，任意命令、MCP 工具和外部进程的间接写入仍应结合沙箱与授权范围约束。
- 可选 `maxTurns` 限制轮次；`approval_timeout_minutes` 默认 1440（24 小时），超过后任务以 `approval_timeout` 失败。

`flow init` 不覆盖已有 `reviewer.yaml` 或 `reviewer.md`。已有用户需要手动更新：上面的完整 YAML
可以直接复制为角色文件；也可以在现有 `permissions` 中移除 `disallowedTools` 的 Edit、Write，并合并：

```yaml
permissions:
  permissionMode: default
  setting_sources: []
  disallowedTools:
    - NotebookEdit
  writable_paths:
    - "docs/**/*.md"
    - "docs/**/*.mdx"
    - "docs/**/*.txt"
    - "docs/**/*.png"
    - "docs/**/*.svg"
    - "docs/**/*.jpg"
    - "docs/**/*.jpeg"
    - "docs/**/*.gif"
    - "docs/**/*.webp"
    - "**/*.md"
    - "**/*.mdx"
```

保留原有 `allowedTools`。同时把 `reviewer.md` 更新为：可以新建或修改上述文档文件，不改代码，
不要通过 Bash 或其他工具绕过限制；除非合同明确要求，否则不提交、不推送；不合并 PR；
结论写在最终回复里，并列出本次写过的文件。

SDK 0.3.310（随包 Claude Code 2.1.310）的本地 `sdk.d.ts` 将两组工具规则声明为 `string[]`，
`README.md` 未详细定义路径匹配。官方[权限规则文档](https://code.claude.com/docs/en/permissions#read-and-edit)
说明 `Edit(path)` 覆盖所有内置文件编辑工具（包括 Write、NotebookEdit 和旧 MultiEdit）；
`Write(path)`、`NotebookEdit(path)`、`MultiEdit(path)` 规则会被接受但不匹配。
原生允许规则也不能表达白名单之外一律拒绝的补集，因此使用 Flow 的 `writable_paths`，不生成 SDK 路径允许规则。
官方 [SDK 权限流程](https://code.claude.com/docs/en/agent-sdk/permissions#how-permissions-are-evaluated)
说明 hooks 先于权限模式和允许规则，而 `canUseTool` 仅处理前序未决定的请求。
全工具 hook 使用省略 matcher 的写法：本地 SDK 0.3.310 的 `sdk.d.ts` 中 `HookCallbackMatcher.matcher?: string`
为可选字段，`Options.hooks` 的 PreToolUse 示例也没有 matcher；官方 [SDK hooks 文档](https://code.claude.com/docs/en/agent-sdk/hooks#matchers)
明确说明，无 matcher 的 hook 会接收该类型的每个事件。因此不依赖 `.*` 正则来表达全工具匹配。
以上由类型定义和文档确认，未运行真实 Claude 或调用模型 API。

执行器自动注入 `flow mcp --actor reviewer`（其他角色用各自名字）。Flow MCP 的固定放行清单为：
`kb_search`、`kb_get`、`kb_query`、`kb_journal`、`capture`、`kb_propose`、`ws_brief`、`brief_update`、`task_list`、`task_show`，
工具全名带 `mcp__flow__` 前缀。这些写入仍受 AI 写入边界限制，提交提案不等于接受提案；`brief_update` 只写 supervisor 自己的简报笔记，身份、workspace 与 `base_hash` 由中枢核对。
`task_create` 可借 dev 角色扩大权限（中枢另按 `creatable_by` 拒绝，见上文），`task_cancel`、`task_reply` 可干预任务，
接受/拒绝提案、转移资源及以后新增的工具也不在固定清单中。不要用宽泛的 allowedTools 绕过这层审批。
`task_reply` 另有用户身份限制：worker 不能代替用户批准自己。

### pr-reviewer：审查准备与结构化输出（add-m1-supervisor D10）

模板见 `flow init` 生成的 `pr-reviewer.yaml`：`kind: read`、`setting_sources: []`、`read_scope: cwd`，没有 Bash 与写工具。
合同带 `inputs.review = {pr, focus?}` 时，claude-sdk 执行器先读节点上的 workspace 配置（读不到该 workspace 时
`failed(review_prep_failed)`，不当作普通任务运行）。角色属于 `supervisor.reviewer_roles`（默认 `[pr-reviewer]`）时，
会话前由确定性代码完成准备，模型不参与：

0. **审查角色必须是只读配置（fail-closed）**：执行器为 claude-sdk、有效类别为 read、`setting_sources` 显式为 `[]`、
   `read_scope: cwd`，任一不满足即 `failed(review_role_not_read)`，不检出 PR、不启动会话。`flow doctor` 对
   `reviewer_roles` 中不满足的已有角色报 error（例如把默认 reviewer 加进去）；
1. 合同 cwd（或 `inputs.repo`）必须是本 workspace 登记的仓库；PR 链接的 host/owner/repo 必须等于该仓库 `remote.origin.url`
   配置原值解析出的仓库（不经 insteadOf 改写，必须恰好一个地址），否则任务启动前 `failed(repo_not_in_workspace)`。
   只认 `https://host/owner/repo`、`ssh://[user@]host/owner/repo`、`[user@]host:owner/repo` 三种形式，host 必须与 PR 链接的
   host 相同：**`~/.ssh/config` 中的主机别名（例如 `git@github-work:owner/repo`）会被判为 `repo_not_in_workspace`**，
   需要把 origin 改成真实主机名；
2. `gh pr view <链接>` 读取 PR，核对编号与链接（大小写不敏感），fork PR（`isCrossRepository`）一律 `failed(repo_not_in_workspace)`，记录当前 `headRefOid`；`gh pr diff` 写入任务私有目录的 `pr.diff`；
3. `git fetch origin +pull/<n>/head:refs/flow/review/<task-id>`（任务专用 ref，不依赖 FETCH_HEAD），该 ref 必须等于记录的
   head（准备期间有新提交时 `failed(head_moved)`），再 `git worktree add --detach` 检出到任务私有目录下的 `worktree/` 作为会话 cwd；
4. 检出时不运行任何由配置驱动的程序：`-c core.hooksPath=/dev/null`、`-c core.fsmonitor=false`，并对
   `git config --get-regexp '^filter\.'` 列出的每个 filter driver 加 `-c filter.<名>.smudge= -c filter.<名>.clean=
   -c filter.<名>.process= -c filter.<名>.required=false`（PR 的 `.gitattributes` 引用它们时原样检出）；对配置了
   `textconv` 或 `command` 的每个 diff driver 加 `-c diff.<名>.textconv= -c diff.<名>.command=`，并加 `-c diff.external=`
   （实测 git 对这些空值会报 `cannot run :` 而不执行任何程序，相关 diff 失败而不是运行配置里的命令）；环境设
   `GIT_LFS_SKIP_SMUDGE=1`。会话环境用 `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` 注入同样的覆盖
   （接在已有条目之后）与 `GIT_LFS_SKIP_SMUDGE=1`，Claude Code 自己运行的 `git status` 等也不会触发它们；
5. 会话无条件 `settingSources: []`、`strictMcpConfig: true`（只用注入的 Flow MCP），并设 `ENABLE_CLAUDEAI_MCP_SERVERS=false`
   关闭 claude.ai connector；`read_scope` 允许 worktree（含根下 `.github/`）与私有目录；首条消息写明 PR、head 与 diff 路径；
   项目约定（CLAUDE.md / AGENTS.md）从登记仓库读取，不从 PR 的检出读取，PR 不能借此改写系统提示词；
6. SDK `outputFormat: {type: 'json_schema'}`（schema 即 `schemas/tasks/review-output.schema.json`），`StructuredOutput`
   直接放行、不进审批。结果的 `verdict`、`blocking`、`notes` 取自结构化输出并按 zod 再校验（approve 时 blocking 必须为空，
   不允许多余字段），`reviewed_sha` 由执行器填入第 2 步记录的 head；结构化输出缺失、不合规或 `error_max_structured_output_retries`
   → `failed(review_output_invalid)`。`summary` 仍是最后一段文字（没有文字时由结论生成）；
7. 任务结束（任何结果）后移除 worktree、任务专用 ref 与私有目录；节点启动时清理本节点残留的私有目录并 `git worktree prune`。
   私有目录为 `<flow-home>/state/review/<node-id>/<task-id>/`。

审查任务恢复执行（回复后重新排队）时不恢复旧会话：旧会话可能看过另一个 head，回复附在新的任务说明之后，重新准备。
不在 `reviewer_roles` 中的角色即使带 `inputs.review` 也按普通任务运行，不做准备。中枢入账时，结果不是 done、合同没有
`inputs.review` 或执行器不是 claude-sdk 的任务提交的 `result.review` 一律丢弃；采信时（合并请求、pr-merge 再次核对）统一用 core 的
`trustedReview` / `reviewApproves` / `latestTrustedReview` 判断：同一 workspace、执行器 claude-sdk、角色在 `reviewer_roles` 中、
已 done、`inputs.review.pr` 等于该 PR，并且是该 PR 最新一次可信审查。

### 有效类别为 read 的角色由执行器强制只读（tasks 5.7）

有效类别（D9，doctor 显示）只是配置层判断，执行器另外强制：

- claude-sdk：SDK `tools` 选项只提供 Read、Grep、Glob、ToolSearch、WaitForMcpServers（Flow MCP 不受 `tools` 影响）；
  `allowedTools` 只保留 `readRoleMayUse` 为真的条目（规则取括号前的工具名），写工具、Bash 与 `mcp__flow__task_create` 之类的
  MCP 写操作即使写在 `allowedTools` 中也被滤掉；始终安装（不论有没有 `read_scope`）省略 matcher 的 PreToolUse 钩子，对
  `readRoleMayUse` 为假的调用直接拒绝；`canUseTool` 同样拒绝、不做策略预检、不进审批。允许的 Flow 工具只有自动放行清单中的那些；
  StructuredOutput 只在配置了结构化输出时可用。会话设 `strictMcpConfig: true` 与 `ENABLE_CLAUDEAI_MCP_SERVERS=false`：
  不加载 `.mcp.json`、用户设置、插件中的 MCP 服务器与 claude.ai connector。
- codex-exec：只读角色改用 Flow 管理的 `CODEX_HOME`（`<flow-home>/state/codex-read-home/`）：每次运行前覆盖其中的
  `config.toml`（只有注释，没有 `mcp_servers`、`notify` 与项目信任记录，因此项目级 `.codex/config.toml` 也不会加载）；
  会话记录保存在这里，`exec resume` 照常可用。
  - 凭证：`auth.json` 是指向用户 CODEX_HOME（worker 环境的 `CODEX_HOME`，缺省 `~/.codex`）中 `auth.json` 的符号链接，
    先建临时链接再 rename（原子替换）；Codex 原地改写凭证时写回用户的文件。隔离目录中的 `auth.json` 若是**普通文件**
    （例如 Codex 刷新凭证时替换了链接），执行器不删除它，以 `failed(codex_home_failed)` 结束并提示把它合并回用户目录后删除；
    `CODEX_HOME` 本身指向隔离目录时同样拒绝。用户的 CODEX_HOME 没有 `auth.json`（例如凭证存在钥匙串）时不创建链接，
    Codex 因未登录而失败，不会回退到用户配置。
  - 用户级 config.toml 中的模型、provider 等设置也不生效，只读角色需要的设置写在角色的 `permissions.config`
    （只允许 `model`、`model_reasoning_effort`，否则推断为 write）或 `model` / `effort` 中。
    `codexExecPermissions` 可用的键与 core 的 `CODEX_EXEC_KNOWN_PERMISSION_KEYS` 由防漂移测试保持一致。
  - **为什么不用 `-c`（Codex 0.164.0 实测，2026-10-26）**：在临时 `CODEX_HOME` 的 `config.toml` 中配置
    `[mcp_servers.userfoo] command = "/bin/sh", args = ["-c", "touch <标记>"]` 与一个指向 `http://127.0.0.1:1/v1` 的 provider，
    在临时 git 仓库中运行 `codex -c 'mcp_servers={}' -c 'notify=[]' exec --skip-git-repo-check -s read-only --json "say hi"`，
    标记文件照样出现（`codex -c 'mcp_servers={}' mcp list` 也仍列出 userfoo）：`-c` 对表是合并而不是替换。
    同样条件下 `-c mcp_servers.<名>.enabled=false` 能阻止该服务器启动，但需要预先知道所有服务器名；
    隔离的 CODEX_HOME 中没有项目信任记录时，项目级 `.codex/config.toml` 中的服务器不启动，加上信任记录后会启动。
    **升级 Codex 后需要按上述命令复测**这两项行为。

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

### merger：pr-merge（add-m1-supervisor D10 第 5 步）

```yaml
name: merger
kind: merge
executor: pr-merge
prompt: merger.md
no_progress_minutes: 35
```

pr-merge 执行器**不调用任何模型**，合同的 `inputs.merge = {pr, review_task}` 由中枢填写；执行器重新读取全部事实，
任何一项不满足或无法确认都以 `failed(<原因码>)` 结束、不合并：

| 核对 | 原因码 |
| --- | --- |
| `inputs.merge` 合法 | `invalid_inputs` |
| cwd 是本 workspace 登记仓库；PR 链接的仓库等于 `remote.origin.url`；GraphQL 报告的仓库一致 | `repo_not_in_workspace` |
| 读到 workspace 配置；本任务由 hub 或 user 创建、origin 为 instruction、`parent` 是审查任务、中枢记录的 `inputs.merge` 与合同一致 | `merge_not_eligible` |
| 审查任务：同一 workspace、claude-sdk、角色在 `reviewer_roles`、done、`inputs.review.pr` 等于该 PR、结论 approve，且是该 PR **最新一次**可信审查 | `review_not_approved` |
| 同一 PR 没有未结束（queued / running / verifying / blocked）的审查任务 | `review_not_approved` |
| 中枢不可达（可重试错误） | `merge_unverifiable`（摘要写明"未合并，中枢不可达，可重试"） |
| 合同 `timeout_s` 不小于 2400（40 分钟） | `timeout_too_short` |
| PR 快照读取成功、编号与链接（大小写不敏感）一致 | `pr_unverifiable` |
| 不是 fork PR（`isCrossRepository == false`） | `repo_not_in_workspace` |
| PR 的 head 分支等于 `inputs.merge.branch`（合并前重读时再核对一次） | `head_branch_mismatch` |
| PR 为 OPEN | `pr_not_open` |
| base 为仓库默认分支 | `base_not_default` |
| 目标分支没有启用合并队列 | `merge_queue_unsupported` |
| 当前 head 等于 `reviewed_sha`，快照中的检查就是这个提交的；读完检查、合并前再读一次 head 仍相等 | `head_moved` |
| 不是草稿且 `mergeable = MERGEABLE`（`UNKNOWN` 时每 5 秒重读，最多 3 次） | `not_mergeable` |
| 至少一项检查且全部 `pass`（`skipping` 不算失败，但不计入"至少一项"；结论为 SKIPPED 与 NEUTRAL 的检查都归为 `skipping`），没有进行中的；检查超过 100 项无法确认时判失败；`supervisor.allow_no_checks: true` 时允许没有检查 | `checks_not_green` |

PR 状态与检查来自**同一次** GraphQL 读取（`gh api graphql`：`headRefOid`、`mergeable`、`isMergeQueueEnabled`、
`autoMergeRequest` 与最新提交的 `statusCheckRollup`），不会出现"读检查之后 head 变了"的错位；合并前再读一次 head，
合并命令本身也带 `--match-head-commit`。`mergeStateStatus`（BLOCKED、BEHIND、UNSTABLE 等）只读取并记在活动里，
不作为判定依据。检查的判定完全 fail-closed：head 提交上 rollup 返回的每一条 CheckRun 与 StatusContext 都单独计入，只要有一条不是
pass / skipping 就不合并（进行中为 pending，其余为失败，都是 `checks_not_green`）。不按名称合并"较新的成功覆盖较早的失败"：
同一 workflow 中同名的不同 job（例如固定 name 的 matrix 分支）无法与重跑可靠区分，合并会把失败或进行中的检查遮住。
唯一的去重是同一个 check run id（`databaseId`）重复出现时只算一次。
**有意的后果**：flaky 检查重跑成功后，旧的失败记录仍在 rollup 中，pr-merge 不会合并；需要推一个新提交重新触发检查，
或由用户手动合并。**分支保护应把关键检查设为 required**：pr-merge 只能看到读取时已存在的检查，
之后才创建的检查不在核对范围内。

通过后执行 `gh pr merge <链接> --<merge_method> --match-head-commit <reviewed_sha>`（`supervisor.merge_method`，默认 squash）。
不带 `--auto`、分支没有合并队列时 gh 不会改为启用自动合并（gh 只在合并队列分支上这样做，这类分支已在合并前拒绝）；为防万一，
合并后 PR 仍为 OPEN、且出现了合并前没有的自动合并请求时，执行器用 `--disable-auto` 关掉它（别人事先设置的不动）。
合并后必须读到 MERGED、合并提交与 `headRefOid == reviewed_sha`，否则 `failed(merge_failed)`；一直读不回状态时
`failed(merge_unverified)`，摘要写明 PR 可能已合并、需要人工确认。

合并后用 `gh run list -R <host/owner/repo> --commit <合并提交> --branch <默认分支>` 轮询（默认每 15 秒，不超过 2 分钟），
只计 `push` 与 `workflow_run` 事件的 run；每次轮询都上报一条活动（心跳），节点不会把等待判为无进展（merger 模板另设
`no_progress_minutes: 35`）。全部结束且结论都是 success / skipped / neutral，并在下一次查询中没有新出现的 run → `done`，
结果附 run 链接；有其他结论 → `failed(pipeline_failed)`，其中 cancelled 的 run 附说明（可能是被同一并发组中更新的提交取代，
请确认默认分支最新提交的流水线）；30 分钟仍未结束 → `failed(pipeline_timeout)`，附 run 链接；合并后 2 分钟内一直没有任何 run →
`done`，注明未发现发布流水线（查询失败不算"没有 run"）。合并后被取消时，cancelled 的结果带合并提交与 artifacts。

**谁建 merger**（D10 第 4 步，tasks 4.8）：supervisor 不能直接建（`task_create` 返回 `role_not_allowed`），只能调用
`pr_merge_request{pr, review_task}`。中枢按账本核对资格，任一项拿不准即 403 `merge_not_eligible`（`details.reasons` 列出原因）：
PR 是本 workspace 内某个已 done、origin 为 instruction、有效类别恰为 write、上报过任务分支的任务的 `kind: pr` 产物（唤醒、审查、合并任务的产物不算）；
PR 的 owner/repo 等于登记仓库 `remote.origin.url` 的仓库；
`review_task` 同 workspace、角色在 `reviewer_roles`、执行器 claude-sdk、done、审查同一 PR、结论 approve，且是该 PR 最新一次可信审查；
同一 PR 没有未结束的审查任务；该审查的合并请求没有被驳回过（`rejected_before`）；merger 的工作目录能唯一确定为登记仓库；有且只有一个有效类别为 merge、执行器为 pr-merge 的角色。
通过后 `supervisor.auto_merge: true` 且请求来自 instruction 唤醒时中枢以 hub 直接建 merger；否则（含 autonomous 唤醒）生成
`merge_request` 收件箱条目，只有用户能批准（再核对一次资格，`merge_request.approved`、merger 的创建与条目关闭在同一事务中写入）
或驳回（写 `merge_request.rejected`，按请求所在唤醒的 origin 唤醒 supervisor）。supervisor 停用后旧条目仍可批准。
merger 合同：`parent` 为审查任务、origin 取自开出 PR 的任务（instruction）、`inputs.merge = {pr, review_task, branch}`（`branch`
取自该任务投影的任务分支）、`timeout_s` 3600、
幂等键 `merge:<审查任务>`（同一次审查最多一个 merger；要重试合并需要重新审查）。合并审批条目不轮询 PR 状态。

**timeout_s**：merger 合同的 `timeout_s` 不得小于 2400 秒（40 分钟：核对与合并之外还要等最长 30 分钟的流水线），
否则执行器在合并前以 `timeout_too_short` 失败；角色文件不支持 `timeout_s`，由创建 merger 任务的中枢保证（缺省 3600）。

**pr-merge 只能在本机节点上运行**：远程节点、以及用绑定 token（`FLOW_HUB_TOKEN`，`node:<id>` 身份）运行的节点读不到审查任务与
任务列表，核对必然失败（`merge_not_eligible` / `review_not_approved`），不能执行合并。

审查任务与任务列表（`status=done` 的可信审查，以及各未结束状态的同 PR 审查）经中枢 `GET /v1/tasks/:id`、`GET /v1/tasks`
读取。执行器自己按 flow-home 构造中枢客户端，不声明 `X-Flow-Actor`：本机节点以 user token 访问，身份为 user
（与 G5 "节点接口只允许 user 与 node:*" 的要求一致；这两个是任务接口，不是节点协议接口）；用绑定 token
（`FLOW_HUB_TOKEN`，`node:<id>` 身份）运行的节点读不到它们，按核对失败处理。pr-merge 应在本机节点上运行。

gh 版本：按已验证的 gh 2.102.0 要求（需要 `gh api graphql --hostname`、`gh pr merge --match-head-commit`、
`gh run list --commit`、`gh pr view --json autoMergeRequest`）；更早的版本未测试，`flow doctor` 不检查 gh 版本。

## 安全边界

以 [policy README 的“信任边界与局限”](../packages/core/src/policy/README.md#信任边界与局限) 为准：
节点属于可信计算基，中枢判定之后由节点实际放行。Bash / CodexCommand 的静态识别只能尽力识别常见写法；
宽泛的 Bash 自动放行实质上允许任意代码，真正的边界应放在沙箱、工具权限和文件系统/网络隔离上。

默认 dev 会跳过 Codex 审批和沙箱，可以以节点的系统用户权限执行命令、读写文件和访问网络，
不会保证每个危险动作都经过 Flow。只给可信仓库和已授权任务使用，收紧时使用上面的临时角色。
同一系统用户下能读取中枢 user token 的进程还可以取得用户身份，见 [中枢鉴权的信任边界](hub-auth.md#信任边界)。
角色、workspace 和 policies 配置本身也属于提权面。

reviewer 直接在合同 cwd 中写文档，通常就是用户的主检出；不会自动创建独立 worktree，写入会让工作区变脏。
审查报告类任务建议明确写到 `docs/reviews/` 等目录，合同中说明是否允许提交和推送。
默认提示词要求不改代码、不提交、不推送（合同明确要求提交或推送时除外），并在最终回复列出写过的文件。
`docs/` 只默认放行上述文档及图片扩展名；目录外只允许 `.md`、`.mdx`，隐藏路径和代理指令文件仍禁止。
文档目录也可能包含会执行代码的配置，例如 `docs/conf.py`、`docs/.vitepress/config.ts`，不能因它位于 docs 下就信任。
默认白名单不放行这些配置，角色提示词仍要求内容属于文档。
指令文件清单是尽力而为的防护，不能完整识别所有代理输入：代理可能经 `@引用` 间接读取普通文档作为指令。
敏感仓库可将白名单收窄到 `docs/**` 范围内，保留 docs 下逐项展开的文档及图片规则，移除跨目录的 `**/*.md`、`**/*.mdx`；
这样仍保留扩展名限制，不会重新放行 `docs/conf.py` 等可执行配置。
路径校验不隔离同一用户下其他进程，无法阻止其他进程在校验后并发替换文件或符号链接。

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
   三种执行器共用合同工作目录规则：显式 `cwd` 优先；否则使用属于该 workspace repos 的 `inputs.repo`；
   两者都没有时，取 workspace 唯一仓库。没有仓库或有多个仓库时必须写 `cwd` 或 `inputs.repo`，
   否则任务以 `failed`（`repo_not_in_workspace`）结束，不再回退到 flow-home。
   合同 `cwd` 必须是绝对路径，允许 `~/` 开头并由节点展开；相对路径在合同校验时拒绝。codex-orca 仍以 `inputs.repo`（其次 `cwd`）选择基础仓库并校验归属，再创建 worktree。
   可加 `inputs.scope: ["README.md"]` 明确修改范围，`context` 引用知识，
   `verify: [{"cmd":["bun","test"]}]` 指定验收命令（应换成该仓库实际的检查）。
   verify 是 argv，不经过 shell；有验收命令时成功后先进入 verifying，全部通过才 done。
   验收目录依次取单条 verify 的 `cwd`、执行器返回的工作目录（codex-orca 的 worktree）、上述合同工作目录。
   策略预检的相对路径也按上述合同工作目录解析。
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

7.1 只完成 doctor 和 fake 冒烟，不能代表 6.1、6.2；两者已于 2026-10-26 在真实 harness 上完成，见下方实测记录。真实验证要另外记录任务 id、版本、PR、
信任提示与授权请求片段、回复和最终验收结果；不要把 fake 的结果当作真实 harness 的证据。

### 2026-10-26 实测记录

环境：codex-cli 0.164.0、Orca 1.4.218、Claude Code 2.1.310（Agent SDK 0.3.310）；单节点、`concurrency: 1`；
workspace `ws/product-res`。四个任务都由 user 创建，最终全部 `done`。

| 任务 | 角色 / 执行器 | 过程 | 结果 |
| --- | --- | --- | --- |
| 6.1 `t-20261026-042354-7f36df` | dev / codex-orca | 自动建 worktree 与分支 `ustclhx/t-…-7f36df` → Codex 修改 README、跑 `pnpm check` → 开 PR，约 2 分钟 | product-res PR #28，`done` |
| 6.2 `t-20261026-042354-690b74` | dev-approval（临时角色，`approval: on-request`、`approvals_reviewer: user`）/ codex-orca | ① 授权请求：沙箱内 `pnpm check` 不能监听 127.0.0.1，请求越出沙箱重跑（seq 101）→ `--approve`；② 提问：`pnpm test:create-project` 有 1 项既有失败，问 A/B（seq 108）→ 文字回复选 A；③ 授权请求：沙箱内连不上 api.github.com，请求越出沙箱执行 `gh pr create`（seq 115）→ `--approve` | product-res PR #29，`done` |
| 6.2 `t-20261026-042608-f7fe9d` | reviewer / claude-sdk | ① canUseTool 审批 `gh pr view 28 … && gh pr diff 28`（seq 126）→ `--approve`；② 审批 `git fetch … pull/28/head:pr28; …`（seq 134）→ 文字回复"不要 fetch 或建本地分支"，会话按回复改用已有 diff 完成；两次卡住同一 SDK 会话 | 审查结论"修改后再合并"，`done`，约 0.39 美元 |
| 6.2 `t-20261026-082121-5e127c` | triage / codex-exec（`sandbox: read-only`） | 最后一条消息被识别为提问（seq 145）→ 文字回复 → `task.requeued_with_reply`，第二次尝试以 `exec resume` 恢复同一会话 `01a1774c-…` | 分诊结论，`done`，attempt 2 |

结论：codex-orca 的授权请求与提问识别、审批送达，claude-sdk 的审批挂起与恢复（批准和文字回复两种），
codex-exec 的提问与 resume，均在真实 harness 上走通。挂起中的任务（codex-orca、claude-sdk）在节点下一次续约时收到回复；codex-exec 没有挂起的进程，回复后重新排队并以 resume 恢复。

未覆盖与发现：

- **信任提示没有出现**：本机 Codex 已信任 home 目录，新 worktree 不弹信任提示，6.1 没有覆盖信任提示的自动处理；
  该路径仍只有 fixture 测试。
- **卡住的任务占住并发槽**：`concurrency: 1` 时，690b74 等用户批准期间，reviewer 任务排队约 2 小时 40 分钟。
  ④ `add-m1-supervisor` 的预留执行槽（D12）处理这个问题。
- **默认 reviewer 在用户主检出里跑 shell**：它请求 `git fetch … :pr28`，会在用户的仓库里留下本地分支。
  ④ 的 pr-reviewer 改由节点准备私有临时 worktree，角色本身没有 shell（D10）。
- **Codex 沙箱内的常见越界**：本地端口监听（测试）和访问 GitHub API（开 PR）都需要越出沙箱，
  使用 `on-request` 的 dev-approval 任务因此出现了两次授权请求。④ 的代回复（D15，见 PR #43）把这类白名单内的请求交给 supervisor。
- 6.2 的提问暴露出 product-res 自身的既有测试失败（`scripts/create-project.test.mjs` 期望值），与 Flow 无关，
  triage 的建议是修正测试期望。

临时角色 `dev-approval` 在验证后已从 `config/roles/` 删除，未提交到 config 仓库。

本机已知环境：`~/.codex/config.toml` 信任了 home 目录，并启用了 `approvals_reviewer = "auto_review"`。
因此新 worktree 不一定出现信任提示，`on-request` 角色也不一定出现需要用户答复的授权请求。
这不能用来证明信任提示处理或审批送达已被覆盖。为 6.2 另建上面的 dev-approval 角色，
在 `permissions.config` 中显式设 `approvals_reviewer: user`，并选择确实需要越出沙箱的操作，
再用 task reply 的 approve 走完闭环。不要为此修改个人 Codex 配置或取消现有 home 信任。

reviewer 的 canUseTool 审批需要选择不在 allowedTools 中、也未被 Flow 策略自动放行的工具请求；
triage 则需先得到一条真实提问，再用文字回复验证 exec resume。Codex TUI 文本会随版本变化，
识别问题应附脱敏的终端片段，更新 fixture 后再验证。
