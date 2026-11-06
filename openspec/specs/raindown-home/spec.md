# raindown-home Specification

## Purpose
规定 Raindown 用户数据目录（raindown-home）的位置、布局和初始化行为，保证用户数据与平台代码严格分离，并且可以被版本化和备份。

## Requirements

### Requirement: 数据目录位置
系统 SHALL 依次解析非空的 `RAINDOWN_HOME`、`FLOW_HOME`，再使用默认 `~/raindown-home`；仅当新默认目录不存在而旧默认 `~/flow-home` 存在时，SHALL 继续使用旧默认目录，不自动移动数据。环境变量空白串视为未设置。所有 Raindown 命令都 MUST 从同一个解析结果读写用户数据，不得在平台代码仓库内写入用户数据。

#### Scenario: 默认位置
- **WHEN** 未设置新旧 home 环境变量且旧默认目录不存在，用户运行任意 `raindown` 命令
- **THEN** 系统读写 `~/raindown-home` 下的数据

#### Scenario: 覆盖位置
- **WHEN** `RAINDOWN_HOME=/tmp/fh` 时运行 `raindown init`
- **THEN** 系统在 `/tmp/fh` 下创建数据目录，`~/raindown-home` 不受影响

### Requirement: 初始化布局
`raindown init` SHALL 创建 `config/`、`brain/`、`raw/`、`state/` 四个子目录。其中 `config/`、`brain/`、`raw/` MUST 各自初始化为独立的 git 仓库；`state/` MUST NOT 被纳入任何 git 仓库。`brain/` SHALL 包含一份描述知识条目约定的 `AGENTS.md`，以及初始的 `index.md` 和 `log.md`。

#### Scenario: 首次初始化
- **WHEN** 数据目录不存在时运行 `raindown init`
- **THEN** 四个子目录被创建，三个 git 仓库各有一次初始提交，`brain/AGENTS.md`、`brain/index.md`、`brain/log.md` 存在

### Requirement: 初始化幂等
对已存在的数据目录再次运行 `raindown init`，系统 MUST NOT 覆盖或删除任何已有文件，SHALL 只补齐缺失的目录和文件，并报告补齐了哪些项。

#### Scenario: 重复初始化
- **WHEN** 用户修改了 `brain/AGENTS.md` 后再次运行 `raindown init`
- **THEN** 修改后的 `brain/AGENTS.md` 保持不变，命令报告"无缺失项"或列出补齐的项

### Requirement: 状态检查
`raindown doctor` SHALL 报告数据目录位置、各子目录与 git 仓库是否完整、提交前密钥扫描钩子是否已安装、所需外部工具是否可用。存在问题时 MUST 以非零状态退出。

#### Scenario: 缺少密钥扫描工具
- **WHEN** 系统中未安装密钥扫描工具时运行 `raindown doctor`
- **THEN** 输出指出缺失的工具和安装方式，命令以非零状态退出


### Requirement: 旧安装迁移诊断
`raindown doctor` SHALL 显示 home 来源（RAINDOWN_HOME、FLOW_HOME、默认或旧默认目录），使用旧名来源时给出迁移警告，MUST NOT 自动移动用户数据。

#### Scenario: 旧默认目录回退
- **WHEN** 没有新旧 home 环境变量，只有 `~/flow-home` 存在
- **THEN** 命令使用该目录，doctor 显示旧默认来源和迁移提示；新目录未被创建

#### Scenario: 新配置优先
- **WHEN** `RAINDOWN_HOME=/new` 且 `FLOW_HOME=/old`
- **THEN** 使用 `/new`，来源为 RAINDOWN_HOME
