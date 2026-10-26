# secret-hygiene Specification

## Purpose
保证密钥不进入 Flow 管理的知识库、原始资料和配置仓库，并约定密钥引用的写法，为后续的密钥提供器打好基础。

## Requirements

### Requirement: 提交前扫描
`config/`、`brain/`、`raw/` 三个仓库 SHALL 安装提交前钩子，对暂存内容做密钥扫描；发现疑似密钥时 MUST 阻止提交，并指出文件与行号。

#### Scenario: 用户手动提交了 token
- **WHEN** 用户在 brain 中写入一个 Stripe 密钥，然后执行 `git commit`
- **THEN** 提交被阻止，输出指出该文件和行号

### Requirement: Flow 写入前扫描
系统 SHALL 在任何写入（journal、随手记、提案、提案合入、runbook）落盘之前扫描待写内容；发现疑似密钥时 MUST 拒绝写入，并返回错误说明，错误信息 MUST NOT 回显密钥原文。

#### Scenario: agent 在 journal 里粘贴了 key
- **WHEN** 操作者 `codex` 追加的 journal 正文中包含一个疑似 API key
- **THEN** 写入被拒绝，返回的错误只给出位置和类型，不包含 key 本身

### Requirement: 密钥引用语法
配置与知识条目中需要引用密钥时 SHALL 使用 `secret://<路径>` 形式，例如 `secret://cloudflare/zone-ezarouter`。校验 SHALL 能识别这种引用，并且 MUST NOT 把它当作疑似密钥。本能力不负责解析引用。

#### Scenario: 数据源条目引用密钥
- **WHEN** 某个 `data-source` 条目中写有 `credential: secret://stripe/readonly`
- **THEN** 校验和扫描都通过，该引用在条目中原样保留

### Requirement: 已知密钥值的脱敏
中枢解析出的每个密钥值 SHALL 加入一份只在内存中的脱敏名单。账本事件载荷、任务结果、日志和渠道外发内容在写出前 MUST 把名单中的值替换为 `[secret:<路径>]`；这一步与 gitleaks 的疑似密钥扫描同时进行。

#### Scenario: worker 把 token 打印到了终端
- **WHEN** 一个任务的活动片段中出现了 Telegram bot token 的值
- **THEN** 写入账本的活动片段中，该值变为 `[secret:telegram/bot-token]`
