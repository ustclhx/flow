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
`task_reply` → `task.reply`、`task_respond` → `task.respond`、`kb_proposals_accept` / `kb_proposals_reject` → `proposal.decide`、
`resource_transfer` → `resource.transfer`。Bash 调 flow CLI 时识别为同样的动作
（`flow task create|cancel|reply|respond`、`flow kb proposals accept|reject`、`flow resource transfer`）；
`flow hub`、`flow policy`、`flow daemon`、`flow mcp`、`flow node`、`flow init` 识别为
`flow.admin`，`flow secrets` 识别为 `secrets`。flow 可执行文件按 basename 识别
（`/Users/x/.bun/bin/flow`），`bunx|npx|pnpx flow`、`bun x flow`、`bun [run] <脚本>.ts`、
`npm|pnpm|yarn exec|run|dlx flow` 同样识别；选项（以及 `--actor` 的值）不影响匹配，
与 CLI 的命令匹配方式一致。`bun -e` / `--eval` / `-p` / `--print` 按不透明处理。

### 升级顺序：新条件与旧节点

旧版本节点会 strict 解析 `policy/check` 响应中的 `matched_rules[].rule`，不认识的条件字段（例如 ④ 新增的 `when.push_to`、`when.gh_scope`）会让预检失败，节点按"需要用户"处理。因此**先升级所有节点，再在 `policies.yaml` 中写带新条件的规则**；回滚节点前先删掉这些规则。`decision_id` 只随 `supervisor` 档位返回，不影响旧节点。

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
取最保守档位。`when` 不增加具体程度：条件之间按且组合，命令前缀按原始词严格匹配（见下文），
串联请求的每段命令都须满足；每个请求路径须匹配至少一个模式。路径 `*` 不跨 `/`，
`**` 跨目录，`?` 匹配单字符，其余字符按字面处理。缺少条件输入时不匹配该规则。

### 命令前缀 `command_prefix`：严格匹配（行为变更）

`when.command_prefix` 对所有档位都按**原始词**严格匹配（`commandPrefixMatches`）：不消去环境变量
赋值、包装命令（`sudo`、`env`、`command`、`exec`、`nohup`、`timeout`、`nice`、`time`、`stdbuf`、
`xargs`……）或执行文件路径，因此首词必须与前缀首词完全相同（`./pnpm`、`/usr/bin/git` 不命中）；
命令与前缀只能含空格与可见 ASCII（制表符、换行、NBSP、U+3000 等不命中）；解析不确定时不命中；
串联命令的每段都须满足；任一段含引号外的文件重定向（`>`、`>>`、`>|`、`N>`、`&>`、`<`、`<<`、`<<<`、
`<(`，只允许独立的 `2>&1`）、后台执行的单个 `&`（批准后会继续在沙箱外运行；`&&` 不受影响）或会展开的元字符（`$`（含双引号内）、`{`、`[`、`*`、`?`、`~`）时不命中。

批准 `pnpm test` 这类命令等于批准在沙箱外执行仓库中的脚本（包括 worker 改过的 `package.json`
scripts、测试配置与 `--reporter`、`--preload` 等参数），这是已接受的风险，supervisor 需结合 `diff_stat` 判断。

**行为变更**：此前前缀匹配先消去包装与赋值，`FOO=1 sudo /usr/bin/git push` 能命中 `git push`
前缀。现在它不命中，请求落到其他规则或交给用户（只会更保守）。动作识别（`classifyAction`）仍然
消去包装，保守识别敏感动作；执行文件（含包装命令）或用于匹配映射前缀的词含会展开的元字符时
（`{gh,pr} merge`、`gh $X pr merge`、`gh pr mer[g]e`、`git $IFS push`；含展开的词可代表任意多个词），
整段按 `shell.opaque` 处理。重定向默认拒绝：只有位于段末尾的重定向（`git status 2>&1`、`ls > out.txt`）才剥离后照常识别；
出现在最后一个普通词之前（开头或中间，如 `>out gh pr merge`、`gh 2>&- pr merge`、`gh &>x pr merge`）、
不在词首（`gh>x`）或缺少目标的重定向使整段按不透明处理，分词误差只会让判定更严。只有操作符的词
（`>`、`>>`、`>|`、`<`、`<<`、`<<<`、`<>`、`&>`、`&>>`、`>&`、`<&`，可带编号）连同其后的目标一起剥离；
以 `&-` 或 `&<数字>` 结尾的词本身完整。识别时还把
shell 保留字 `!`、`if`、`then`、`elif`、`else`、`do`、`while`、`until`、`coproc` 当作前缀剥离；
`function`、`select`、`case`、`{`、`}` 开头的段按不透明处理。分词只在空格与制表符处断词（与 bash 一致），命令中出现其他空白时
`classifyAction` 按 `shell.opaque` 处理。

### 条件 `push_to` 与 `gh_scope`（`conditions.ts`，D15）

两个条件让 supervisor 代为批准越出沙箱的推送与 gh 调用，采用**白名单**：只接受明确列出的写法，
任何不确定都视为不满足（规则不命中）。判定需要的上下文由 `decide(rules, request, context)` 的第三个
参数 `PolicyContext` 传入（`task_branch`、`default_branch`、`remotes`、`push_env_ok`、`gh_env_ok`、
`command_cwd`、`task_worktree`、`realpath`）；字段缺失时条件不满足。core 不访问文件系统，
`realpath` 由调用方注入。

两个条件都要求**命令在任务 worktree 中执行**：`command_cwd`（节点上报的命令实际执行目录）与
`task_worktree`（投影记录的任务 worktree）都存在、都是绝对路径，且 realpath 相同。

`when.push_to: task_branch`（schema 只允许用于 `action: git.push`）由 `pushToTaskBranch` 判定，
命令先经 `parsePushTarget` 解析。以下全部满足才满足：
- 命令只含字母、数字、空格与 `._/:@=+-`：引号、`$`、glob、重定向、`~`、`;`、`&`、`|`、`#`、
  制表符、换行、Unicode 空白与非 ASCII 字符一律不满足；
- 只有一段，第一个词就是 `git`（不带路径、没有环境变量赋值或 `env`、`sudo` 等包装），第二个词就是
  `push`（`-c`、`-C`、`--git-dir`、`--exec-path`、`--config-env` 等全局选项都不满足）；
- 选项只能是 `-u`、`--set-upstream`、`-q`、`--quiet`、`-v`、`--verbose`、`--progress`、
  `--no-progress`；`--all`、`--mirror`、`--tags`、`--follow-tags`、`--prune`、`--delete`、
  `--receive-pack`、`--exec`、`-o`、`--push-option`、`-f`、`--force*` 等以及任何未列出的选项
  （包括短选项连写、`--`）都不满足；
- 恰好一个 remote 加一个 refspec；remote 是名字（不是 URL 或路径），且在 `remotes` 中；
- refspec 不以 `+` 或 `:` 开头，来源与目标都不是 `HEAD`、不含 `@`，是普通分支名；来源与目标都不能是
  `refs/tags/…` 等非分支 ref；目标（规范为 `refs/heads/<分支>` 或短名，无冒号时等于来源）等于 `task_branch`；目标写成短名时
  来源也必须是任务分支；
  节点另需确认本地没有与任务分支同名的 tag；
- `task_branch` 存在且不等于 `default_branch`（缺默认分支即不满足）；`push_env_ok` 严格为 `true`；
- 命令在任务 worktree 中执行。

`when.gh_scope: workspace_repo` 由 `ghScopeWorkspaceRepo` 判定：
- `gh_env_ok` 严格为 `true`；
- 没有引号外的重定向与展开；只含空格与可见 ASCII，且没有 shell 元字符：引号外的 `` $ ` \ < > { } * ? [ ] ~ ; & | ( ) # ``，
  双引号内的 `` $ ` \ ``，未闭合的引号（单引号内按字面）；
- 只有一段，第一个词就是 `gh`（没有 `GH_REPO`、`GH_HOST`、`GH_TOKEN` 等环境变量赋值或包装），
  第二、三个词是 `pr create`、`pr view` 或 `pr diff`；
- 只带白名单选项：不含 `-R` / `--repo`、`--recover`、`--web`、`--editor`、`--template`；view / diff
  不接受 `--jq` / `-q` / `--template` / `-t`（jq 的 `env` / `$ENV` 能输出沙箱外进程的环境变量）；
  **不接受 `-F` / `--body-file`**（文件在核对与 gh 读取之间可能被替换，正文用 `--body` 或 `--fill`）；
- `--head` 缺省或等于 `task_branch`（任务分支缺失时带 `--head` 不满足）；create 没有位置参数，
  view / diff 最多一个 PR 编号或分支名（不接受 URL）；
- 命令在任务 worktree 中执行。

gh 在有 TTY 时可能提示推送分支：supervisor 批准 `pr create` 不等于批准推送，推送仍按 `git.push`
单独判定。**不要写 `scope: *` 或通配 action 的 `supervisor` 规则**：受保护的工具与动作会被提升为
`draft-approve`，其余请求则会被大面积委托，白名单应写成具体 scope 加精确 action。

中枢 `policy/check` 从请求取 `push_env_ok`、`gh_env_ok`（只认 `true`；以后只接受 node actor 上报的
值），`remotes` 暂时固定为 `origin`（以后从登记仓库取）。任务分支（`task.branch_reported`）、默认分支、
`command_cwd` 与 `task_worktree` 接入前，`push_to` 与 `gh_scope` 恒不满足。
推送环境（push 地址、`core.sshCommand`、`url.*.insteadOf`、`remote.*.push`、hook 等）与 gh 实际
解析的仓库由节点检查，core 只判定命令文本。

`flow init` 生成的 `config/policies.yaml` 带一组注释掉的模板：supervisor 角色的 `task.create`
auto（scope 用角色名 `supervisor`；workspace 由 D5 的 parent 与仓库检查约束，同一 workspace 的
ws 级 `task.create` 规则会覆盖它），以及代回复白名单（`tool:CodexCommand` 与 `tool:Bash` 的
`pnpm check|test|lint` 前缀、带 `gh_scope` 的 `pr.create` 与 `gh pr view|diff`、带 `push_to` 的
`git.push`）。

每个参与判定的动作都必须命中规则，否则该动作返回 `user`，最终取最保守的结果。
只配置 workspace 的 `pr.merge: auto` 即可放行直接的 `gh pr merge`，无需另配工具规则；
但 `gh pr create && gh pr merge` 必须同时覆盖两个具体动作。`bash -c 'gh pr merge'`
还包含 `shell.opaque` 等敏感动作，只配置 `pr.merge` 仍交给用户处理。
合并次序为 `notify > user > draft-approve > supervisor > auto-report > auto`，空动作也返回 `user`。
档位 `supervisor`（D15）表示委托给本 workspace 的 supervisor 判断：节点不放行，按卡住上报，
由中枢决定是否委托（不在代回复范围内时按 `draft-approve` 交给用户）。
**安全底线是：敏感动作只能由显式规则放行，识别不确定时按敏感处理。**
**受保护的动作**（`GUARDED_ACTIONS`）：`shell.opaque`、`pr.merge`、`deploy`、`secrets`、
`policy.edit`、`config.edit`、`flow.admin`，以及上述 flow 工具的具体动作，均只有具体 workspace 或角色
scope 加精确 action（不含通配符）的规则才能自动放行；不透明请求必须逐一满足全部动作的
显式授权。

**受保护的工具**（`GUARDED_TOOLS` / `isGuardedTool`）：`tool:CodexCommand`（Codex 请求越出
沙箱执行）、所有 `tool:mcp__*`（flow 自己的工具与以后接入的第三方 MCP）、`tool:WebFetch`、
`tool:WebSearch`（外发数据）、`tool:Task` / `tool:Agent`（派生子 agent，继承并放大权限）、`tool:Verify`（非 user 身份建任务时合同中的验收命令，在沙箱外执行；建任务时逐条判定，只有 auto / auto-report 且每个词都符合白名单（不能带 `-` 开头的选项或任何绝对、`~`、`..`、含 `:`/`@` 的路径）时放行，否则 `verify_not_allowed`，见 add-m1-supervisor D5）。
请求涉及这些工具时，参与判定的每个动作（工具本身或从命令识别出的具体动作）都只有 action
不含通配符的规则才能自动放行；`*`、`tool:*`、`tool:mcp__*` 这类通配规则最多判为
`draft-approve`。原因：通配的 auto 规则通常是为本地读写工具写的，不应顺带放行越出沙箱、
外发或提权的请求；例如 `rm -rf ~`、`curl -d @dist …` 经 Codex 请求时只有工具动作，
`scope: * action: tool:* level: auto` 不能放行它们，需要显式写出
`scope: ws/<id> action: tool:CodexCommand`。

**`supervisor` 与 `auto`、`auto-report` 同属自动档位**，并且更严格：受保护的动作（含
`task.respond`）命中 `supervisor` 规则时一律提升为 `draft-approve`（即使是具体 scope 加精确
action 的规则；这些动作只能由用户或显式 auto 规则处理，永不委托）；受保护的工具只有具体
scope（workspace 或角色）加精确 action 的规则才能判为 `supervisor`，`scope: *` 或通配 action
最多 `draft-approve`。

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
