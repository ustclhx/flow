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
`policy.edit`；能提取的 shell `-c` 字符串和 `eval` 文本继续递归识别，结果取并集，
始终保留不透明标记，不以递归识别成功为自动放行依据。

路径由适配器完整提供；归一后的路径等于或以 `/config/policies.yaml` 结尾时增加
`policy.edit`。此外，命令文本只要包含 `policies.yaml` 就增加 `policy.edit`，包括读取、
输出文字或备份文件名等可能的误报。不访问文件系统或解析符号链接。

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
`shell.opaque` 和上述四个敏感动作均只有具体 workspace 或角色 scope 加精确 action
（不含通配符）的规则才能自动放行；不透明请求必须逐一满足全部动作的显式授权。
其他自动档位提升为
`draft-approve`，以 `guarded` 标明。每个动作的 `matched_rules` 保留最高具体程度的全部
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
节点的自动放行与 blocked 上报由任务 2.3 接入，Digest 和收件箱条目由任务 3.1 的反应器生成。
