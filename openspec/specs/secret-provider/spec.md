# secret-provider Specification

## Purpose
用 sops + age 在 `config/` 仓库中保存加密的密钥，并在运行时解析 `secret://` 引用，让 Flow 能使用凭据，同时不让明文进入 git、日志或 agent 的上下文（PRD §18）。

## Requirements

### Requirement: 初始化
`flow secrets init` SHALL 完成三件事：
1. age 密钥不存在时生成一把，保存在 `~/.config/sops/age/keys.txt`，权限 0600；
2. 在 `config/` 中写入 `.sops.yaml`（加密规则指向该公钥），以及一个空的加密文件 `secrets.sops.yaml`，并提交；
3. 提示用户离线备份私钥。

已初始化时再次运行 MUST NOT 覆盖已有的密钥或文件。

#### Scenario: 首次初始化
- **WHEN** 在没有 age 密钥的机器上运行 `flow secrets init`
- **THEN** 生成密钥文件（0600），config 仓库新增 `.sops.yaml` 和 `secrets.sops.yaml`，输出备份提示

### Requirement: 读写
`flow secrets set <路径>` SHALL 从标准输入或交互式提示读取值，不接受命令行参数，以免值留在 shell 历史中；读取后写入加密文件并提交。`flow secrets list` 只列出路径。`flow secrets get <路径>` 只允许用户本人在终端中使用，MCP 和 AI 操作者 MUST 无法调用。

#### Scenario: AI 试图读取密钥
- **WHEN** 任何 MCP 调用方尝试读取密钥值
- **THEN** 不存在对应的 MCP 工具；CLI 中以非 user 身份调用 `flow secrets get` 返回 `user_only`

### Requirement: 运行时解析
中枢加载配置时 SHALL 用 sops 解密，并把配置中的 `secret://<路径>` 替换为对应的值。解析后的值只保存在中枢内存中，MUST NOT 写入账本、日志或任何文件。引用的路径不存在时，依赖它的功能（例如 Telegram 渠道）不启动并报告，中枢其余功能照常。

#### Scenario: token 未配置
- **WHEN** `config/channels.yaml` 引用了 `secret://telegram/bot-token`，但该路径尚未设置
- **THEN** Telegram 渠道不启动，`flow hub status` 报告缺少的密钥路径
