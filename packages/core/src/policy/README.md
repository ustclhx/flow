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
`sudo` / `env` / `command` 包装、执行文件绝对路径、空格、引号、反斜杠续行与串联命令。
这是静态前缀识别，不执行 shell，也不展开别名、变量、脚本或 `sh -c` 等嵌套解释器。
路径由适配器完整提供；归一后的路径等于或以 `/config/policies.yaml` 结尾时增加
`policy.edit`。不从命令参数推导修改路径，也不访问文件系统或解析符号链接。

`decide(config.rules, request)` 是纯函数。workspace 使用完整的 `ws/<id>`；每个动作
分别按 workspace、角色、全局排序，同层精确 action 优先，其余通配模式一律并列，最后
取最保守档位。`when` 不增加具体程度：条件之间按且组合，命令前缀按归一后的词边界匹配，
串联请求的每段命令都须满足；每个请求路径须匹配至少一个模式。路径 `*` 不跨 `/`，
`**` 跨目录，`?` 匹配单字符，其余字符按字面处理。缺少条件输入时不匹配该规则。

无匹配动作返回 `user`；只配具体命令动作、未覆盖工具动作时，整个请求仍需用户处理。
合并次序为 `notify > user > draft-approve > auto-report > auto`，空动作也返回 `user`。
四个受保护动作只有具体 scope 加精确 action 的规则才能自动放行；其他自动档位提升为
`draft-approve`，以 `guarded` 标明。每个动作的 `matched_rules` 保留最高具体程度的全部
规则，按档位和原始序号排序；汇总按动作顺序去重。保留原始规则内容供后续审计，判定
本身不写事件、不调用 HTTP、不生成收件箱条目。
