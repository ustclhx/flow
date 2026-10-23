# agent-context-sync Specification

## Purpose
规定 Flow 如何在各项目的 AGENTS.md 中维护一个受管区块，让在该项目中工作的任何 harness 都知道它属于哪个 workspace、关键资源有哪些，以及怎样访问 Flow 知识库。

## Requirements

### Requirement: 受管区块
系统 SHALL 在 workspace 所关联项目仓库根目录的 AGENTS.md 中维护一个区块，以 `<!-- BEGIN:flow-managed -->` 开始、以 `<!-- END:flow-managed -->` 结束。区块内容包括：所属 workspace、项目卡片在 brain 中的位置、该 workspace 拥有的关键资源摘要、访问 Flow 知识库的方式，以及写入规则摘要。

#### Scenario: 首次生成
- **WHEN** 对 `ws/xuanxue-saas` 运行 `flow agents sync`，且它的 AGENTS.md 中还没有受管区块
- **THEN** AGENTS.md 中追加了受管区块，区块中列出了 `arcanumber.com` 和 `ganjiday.com`

### Requirement: 只改区块内
同步时系统 MUST 只替换受管区块内部的内容，区块之外的所有内容（包括其他工具的受管区块）MUST 逐字节保持不变。

#### Scenario: 保留其他工具的区块
- **WHEN** AGENTS.md 里已有 turborepo 的受管区块，再运行 `flow agents sync`
- **THEN** turborepo 区块和其余正文都没有变化，只有 flow 区块被更新

### Requirement: 不自动提交
系统 MUST NOT 在项目仓库中创建提交、切换分支或修改 AGENTS.md 以外的文件。同步完成后 SHALL 报告哪些仓库的 AGENTS.md 发生了变化，由用户决定是否提交。

#### Scenario: 同步后的仓库状态
- **WHEN** 同步修改了某个项目的 AGENTS.md
- **THEN** 该仓库只有 AGENTS.md 这一个未提交的修改，git 历史保持不变

### Requirement: 过时检查
`flow agents sync --check` SHALL 在不写入任何文件的前提下，报告各项目的受管区块是否与 brain 当前内容一致；只要有任一项目不一致或缺少区块，命令就 MUST 以非零状态退出。

#### Scenario: 资源变化后检查
- **WHEN** brain 中新增了一个归属 `ws/product-res` 的域名，随后运行 `flow agents sync --check`
- **THEN** 输出指出 product-res 的区块已过时，命令以非零状态退出，文件没有被修改

### Requirement: 区块标记损坏
如果 AGENTS.md 中只有开始标记没有结束标记，或者受管区块出现了不止一个，系统 MUST 拒绝写入该文件，并报告具体问题。

#### Scenario: 缺少结束标记
- **WHEN** AGENTS.md 中有 `BEGIN:flow-managed`，但没有 `END:flow-managed`
- **THEN** 同步跳过这个文件，报告标记损坏，其他项目照常同步
