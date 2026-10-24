# 策略纯逻辑

`loadPoliciesConfig(home)` 读取 `config/policies.yaml` 的规则数组，返回 `Result<PolicyConfig>`。
缺失或空文件等同空数组；文件读取、YAML 语法、顶层类型错误返回失败。单条规则错误收集到
`errors`，不影响其他规则。`rule_index` 为从 0 开始的原始数组索引，错误消息同时给出从 1
开始的序号；`field: '$'` 表示整条规则。schema 不检查角色或 workspace 是否已注册。

```yaml
- scope: dev
  action: 'tool:*'
  level: auto
- scope: ws/xuanxue-saas
  action: git.push
  level: auto-report
  when:
    command_prefix: git push
    paths: ['src/**/*.ts']
```

`classifyAction({ tool, command?, paths? })` 始终包含 `tool:<原工具名>`；提供命令时按
`COMMAND_ACTION_MAPPINGS` 识别，调用方可传第二个参数扩展映射表。支持环境变量赋值、
`sudo` / `env` / `command` / `timeout` / `nice` / `nohup` / `time` / `exec` /
`stdbuf` / `xargs` 包装、执行文件绝对路径、空格、引号、反斜杠续行与串联命令。
先按 git、gh 的全局选项表及包装命令的选项表跳过选项和取值，再匹配命令前缀，支持
分离的值、短选项紧贴的值和长选项 `=value`；未知选项、缺失值、未闭合引号等解析不确定
情形加入 `shell.opaque`。选项表依据 [Git 文档](https://git-scm.com/docs/git)、
[gh 文档](https://cli.github.com/manual/gh_pr_merge)、
[GNU timeout 文档](https://www.gnu.org/software/coreutils/manual/html_node/timeout-invocation.html)
及 [xargs 文档](https://www.gnu.org/software/findutils/manual/html_node/find_html/xargs-options.html)。

这是**尽力而为的静态识别**，不执行 shell，也不展开别名、变量或外部脚本。
shell 解释器、`eval`、`source`、点号命令与 Python/Node/Ruby/Perl 解释器调用按
`shell.opaque` 处理，范围保守覆盖 `-c` / `-e`、脚本文件及其他调用方式。
命令文本包含 `$()`、反引号或进程替换 `<()` / `>()` 时也标记为不透明，即使位于引号或
注释中。只要出现 `shell.opaque`，结果同时包含 `pr.merge`、`deploy`、`secrets`、
`policy.edit`、`config.edit`；能提取的 shell `-c` 字符串和 `eval` 文本继续递归识别，结果取并集，
始终保留不透明标记，不以递归识别成功为自动放行依据。

路径由适配器完整提供；归一后的路径等于或以 `/config/policies.yaml` 结尾时增加
`policy.edit`。此外，命令文本只要包含 `policies.yaml` 就增加 `policy.edit`，包括读取、
输出文字或备份文件名等可能的误报。路径与命令文本的这些比较都**不区分大小写**
（APFS 默认不区分大小写，`CONFIG/Policies.yaml` 指向同一个文件）。
命令或路径中出现 glob 字符（`*` `?` `[`）、变量展开（`$x`、`${…}`）或命令替换，并且同时
出现 `polic`、`/config/` 路径段、`flow-home` 或实际 flow-home 的 basename（不区分大小写）时，
实际作用的文件无法静态确定（`polic*.yaml`、`${p}ies.yaml`、`policies.yam?`），按
`shell.opaque` 处理，因而包含 `policy.edit`。不再用宽泛的 `config` 子串，`tsconfig.json`、
`vite.config.*` 与 glob 同时出现不算不透明。
命令或路径含非打印字符（换行、回车、制表符之外的控制字符、零宽与双向覆盖等格式字符）时
同样按不透明处理。

第三个参数 `{ flowHomes, userHome, hubPorts }`（中枢传入自身 home 及其 realpath、
`os.homedir()` 与配置的端口）：
- 路径：落在 flow-home 的 `config/` 目录下的任何路径增加 `config.edit`；
- 命令：先做词法归一（`normalizeCommandText`：去掉引号与反斜杠，展开 `~`、`$HOME`、
  `${HOME}`，合并 `//` 与 `/./`，转小写），之后只要出现 flow-home 的绝对路径、它的 `~`
  写法，或 flow-home 的 basename（包括默认的 `flow-home`）作为一个路径段出现，就增加
  `config.edit`。这是保守的：`cd ~/flow-home && echo > config/roles/dev.yaml` 这类相对路径
  写法无法静态解析 cwd，所以只要提到 flow-home 就算；
- 命令文本中出现 `127.0.0.1` / `localhost` / `0.0.0.0` / `[::1]` 加中枢端口，或 `/v1/`
  加中枢端口（总是包含 7477 与 7478）时，视为直接访问中枢，按 `shell.opaque` 处理。

roles、remote.yaml 等与策略文件一样是提权面，不只 policies.yaml。
core 不访问文件系统或解析符号链接；节点在预检前对每个路径做 realpath（文件不存在时对
最近的已存在祖先目录做 realpath 再拼回其余部分），原路径与解析后的路径都送去判定。

flow MCP 工具（`mcp__flow__<操作名>`）中会扩大权限或替用户做决定的操作额外识别为具体
动作（`FLOW_TOOL_ACTIONS`）：`task_create` → `task.create`、`task_cancel` → `task.cancel`、
`task_reply` → `task.reply`、`kb_proposals_accept` / `kb_proposals_reject` → `proposal.decide`、
`resource_transfer` → `resource.transfer`。Bash 调 flow CLI 时识别为同样的动作
（`flow task create|cancel|reply`、`flow kb proposals accept|reject`、`flow resource transfer`）；
`flow hub`、`flow policy`、`flow daemon`、`flow mcp`、`flow node`、`flow init` 识别为
`flow.admin`，`flow secrets` 识别为 `secrets`。flow 可执行文件按 basename 识别
（`/Users/x/.bun/bin/flow`），`bunx|npx|pnpx flow`、`bun x flow`、`bun [run] <脚本>.ts`、
`npm|pnpm|yarn exec|run|dlx flow` 同样识别；选项（以及 `--actor` 的值）不影响匹配，
与 CLI 的命令匹配方式一致。`bun -e` / `--eval` / `-p` / `--print` 按不透明处理。

### 信任边界与局限

- **策略执行点在节点**：判定在中枢，放行（allow / 回车）由节点上的执行器完成，节点属于
  可信计算基。节点被攻破或节点代码有误，策略就不再成立。
- **对 Bash 和 CodexCommand 的识别是尽力而为的静态分析**。`tool:Bash` 的 `auto` 实质上等于
  允许执行任意代码：worker 一旦有 shell，就能用识别不到的方式（脚本文件、编译后的程序、
  别名、网络请求、写入后再执行……）做任何事，上面的映射只能挡住常见写法与误操作。
  因此对能写代码的角色，不建议配置宽泛的 Bash auto；安全边界应当放在沙箱和角色权限
  （允许的工具、文件系统与网络范围）上，策略只用来减少打扰。

`decide(config.rules, request)` 是纯函数。workspace 使用完整的 `ws/<id>`。
`tool:<名称>` 只作为兜底：请求中存在任何非 `tool:` 开头的具体动作（包括 `shell.opaque`）
时，只按具体动作判定，工具动作明细的 `level` 为 `skipped`、命中规则为空，不参与档位
合并或汇总命中规则。没有具体动作时才按工具动作判定，例如 `ls` 可由 `tool:Bash` 的
`auto` 规则放行。每个参与判定的动作分别按 workspace、角色、全局排序，同层精确 action
优先，其余通配模式一律并列，最后
取最保守档位。`when` 不增加具体程度：条件之间按且组合，命令前缀按归一后的词边界匹配，
串联请求的每段命令都须满足；每个请求路径须匹配至少一个模式。路径 `*` 不跨 `/`，
`**` 跨目录，`?` 匹配单字符，其余字符按字面处理。缺少条件输入时不匹配该规则。

每个参与判定的动作都必须命中规则，否则该动作返回 `user`，最终取最保守的结果。
只配置 workspace 的 `pr.merge: auto` 即可放行直接的 `gh pr merge`，无需另配工具规则；
但 `gh pr create && gh pr merge` 必须同时覆盖两个具体动作。`bash -c 'gh pr merge'`
还包含 `shell.opaque` 等敏感动作，只配置 `pr.merge` 仍交给用户处理。
合并次序为 `notify > user > draft-approve > auto-report > auto`，空动作也返回 `user`。
**安全底线是：敏感动作只能由显式规则放行，识别不确定时按敏感处理。**
**受保护的动作**（`GUARDED_ACTIONS`）：`shell.opaque`、`pr.merge`、`deploy`、`secrets`、
`policy.edit`、`config.edit`、`flow.admin`，以及上述 flow 工具的具体动作，均只有具体 workspace 或角色
scope 加精确 action（不含通配符）的规则才能自动放行；不透明请求必须逐一满足全部动作的
显式授权。

**受保护的工具**（`GUARDED_TOOLS` / `isGuardedTool`）：`tool:CodexCommand`（Codex 请求越出
沙箱执行）、所有 `tool:mcp__*`（flow 自己的工具与以后接入的第三方 MCP）、`tool:WebFetch`、
`tool:WebSearch`（外发数据）、`tool:Task` / `tool:Agent`（派生子 agent，继承并放大权限）。
请求涉及这些工具时，参与判定的每个动作（工具本身或从命令识别出的具体动作）都只有 action
不含通配符的规则才能自动放行；`*`、`tool:*`、`tool:mcp__*` 这类通配规则最多判为
`draft-approve`。原因：通配的 auto 规则通常是为本地读写工具写的，不应顺带放行越出沙箱、
外发或提权的请求；例如 `rm -rf ~`、`curl -d @dist …` 经 Codex 请求时只有工具动作，
`scope: * action: tool:* level: auto` 不能放行它们，需要显式写出
`scope: ws/<id> action: tool:CodexCommand`。

上述两类中，不满足条件的自动档位提升为 `draft-approve`，以 `guarded` 标明。每个动作的 `matched_rules` 保留最高具体程度的全部
规则，按档位和原始序号排序；汇总按动作顺序去重。保留原始规则内容供后续审计，判定
本身不写事件、不调用 HTTP、不生成收件箱条目。

中枢的 `POST /v1/policy/check` 接受 `{ task_id, tool, command?, paths?, dry_run? }`，从任务合同取得
workspace 和角色，每次请求重新读取策略文件，返回原有 `decide` 结果。`dry_run` 默认 false，先写入
`policy.decided`。事件载荷为 `{ task_id, request: { tool, actions, command?, paths? },
level, matched_rules, actions }`：`request.actions` 是动作 id，外层 `actions` 是逐动作明细，
规则含原始的从 0 开始的 `rule_index` 和 `rule` 内容。事件操作者为 `policy`，任务信封中
也带 `task_id` 与 workspace；不修改投影，可从任务详情或事件流查询，重建只重放审计记录。

仅 user 或持有该任务未过期活动租约的节点能调用；权限表见 `docs/hub-auth.md`。
请求命令最多 8192 字符、路径最多 200 项且每项最多 2000 字符，超出返回 400，不把
截断输入用于判定。入账时命令、路径与命中规则的同类条件按自由文本脱敏，并限长到
2000 字符；响应采用同样脱敏、限长后的规则明细，dry run 也不例外。超长命令仍使用完整的合法输入判定。
单条规则错误跳过并由 `flow hub status` 报告；文件级读取、YAML 或顶层类型错误使
检查返回 500 `internal_error`，status 报告加载错误，节点按 D2 保守交给用户。

人工调试使用 `flow policy check --task <id> --tool Bash --command "git push"`，
路径通过可重复的 `--path` 传入。CLI 默认传 `dry_run: true`，只返回判定，不写事件，避免
把调试的 auto-report 结果记为真实放行并产生 Digest；加 `--record` 才传 false 并入账。
只有 user 能使用 dry run；节点省略该字段或传 false 均入账，传 true 返回 400
`invalid_arguments`，不能绕过审计。此命令走 HubClient，属于管理命令，不注册为知识访问操作。
Digest 和收件箱条目由任务 3.1 的反应器生成。

节点侧预检（任务 2.3）在 `packages/node/src/precheck.ts`：节点为每个租约构造绑定任务 id 的
`ctx.precheck`，超时 5 秒。只有合法响应的汇总档位与所有参与判定的动作明细都是 `auto` /
`auto-report` 时才在本地放行；`draft-approve` / `notify` / `user`，以及网络错误、5xx、超时、
401/403、`scope_denied`、响应不合 schema 一律照常上报 `blocked(awaiting_approval)`。
请求映射：claude-sdk 的 Bash 取 `command`，其他工具取 `file_path` / `notebook_path` / `path`
作为 `paths`（编辑类工具缺少路径时不预检）；codex-orca 以工具名 `CodexCommand` 加授权弹窗中
严格解析出的命令（`approvalForPrecheck`）预检，发回车前重读终端核对弹窗与命令未变；
fake 执行器的 `approval` 步骤用于端到端测试。codex-exec 无头运行、没有交互审批，不接入。
