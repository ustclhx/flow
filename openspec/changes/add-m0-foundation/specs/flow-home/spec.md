# Spec Delta

## Purpose

规定 Flow 用户数据目录（flow-home）的位置、布局和初始化行为，保证用户数据与平台代码严格分离，并且可以被版本化和备份。

## ADDED Requirements

### Requirement: 数据目录位置
系统 SHALL 默认使用 `~/flow-home` 作为用户数据目录；设置了环境变量 `FLOW_HOME` 时，SHALL 改用该路径。所有 Flow 命令都 MUST 从同一个解析结果读写用户数据，不得在平台代码仓库内写入用户数据。

#### Scenario: 默认位置
- **WHEN** 未设置 `FLOW_HOME`，用户运行任意 `flow` 命令
- **THEN** 系统读写 `~/flow-home` 下的数据

#### Scenario: 覆盖位置
- **WHEN** `FLOW_HOME=/tmp/fh` 时运行 `flow init`
- **THEN** 系统在 `/tmp/fh` 下创建数据目录，`~/flow-home` 不受影响

### Requirement: 初始化布局
`flow init` SHALL 创建 `config/`、`brain/`、`raw/`、`state/` 四个子目录。其中 `config/`、`brain/`、`raw/` MUST 各自初始化为独立的 git 仓库；`state/` MUST NOT 被纳入任何 git 仓库。`brain/` SHALL 包含一份描述知识条目约定的 `AGENTS.md`，以及初始的 `index.md` 和 `log.md`。

#### Scenario: 首次初始化
- **WHEN** 数据目录不存在时运行 `flow init`
- **THEN** 四个子目录被创建，三个 git 仓库各有一次初始提交，`brain/AGENTS.md`、`brain/index.md`、`brain/log.md` 存在

### Requirement: 初始化幂等
对已存在的数据目录再次运行 `flow init`，系统 MUST NOT 覆盖或删除任何已有文件，SHALL 只补齐缺失的目录和文件，并报告补齐了哪些项。

#### Scenario: 重复初始化
- **WHEN** 用户修改了 `brain/AGENTS.md` 后再次运行 `flow init`
- **THEN** 修改后的 `brain/AGENTS.md` 保持不变，命令报告"无缺失项"或列出补齐的项

### Requirement: 状态检查
`flow doctor` SHALL 报告数据目录位置、各子目录与 git 仓库是否完整、提交前密钥扫描钩子是否已安装、所需外部工具是否可用。存在问题时 MUST 以非零状态退出。

#### Scenario: 缺少密钥扫描工具
- **WHEN** 系统中未安装密钥扫描工具时运行 `flow doctor`
- **THEN** 输出指出缺失的工具和安装方式，命令以非零状态退出
