# Spec Delta

## Purpose

规定 workspace 的定义方式，以及资源条目的单一归属规则，使每个域名、服务、仓库、数据源或账号都有唯一明确的负责 workspace，归属变化可以追溯。

## ADDED Requirements

### Requirement: Workspace 定义
每个 workspace SHALL 由 `config/workspaces/<id>.yaml` 定义，至少包含 `id`、`kind`（`product`、`function` 之一）、`name` 与 `description`；`product` 类型的 workspace SHALL 列出所关联项目仓库的本地路径。系统 SHALL 隐式提供一个 `global` workspace，它不需要定义文件。workspace 的标识写作 `ws/<id>`。

#### Scenario: 列出 workspace
- **WHEN** `config/workspaces/` 下有 `product-res.yaml` 与 `xuanxue-saas.yaml`，用户运行 `flow ws list`
- **THEN** 输出 `ws/global`、`ws/product-res`、`ws/xuanxue-saas` 及其类型与名称

### Requirement: 资源单一归属
资源类型的条目（`domain`、`service`、`repo`、`data-source`、`account`）MUST 有且只有一个 `owner` 字段，值为一个已定义的 workspace 标识。`function` 类型的 workspace MUST NOT 作为资源的 owner。

#### Scenario: owner 指向不存在的 workspace
- **WHEN** 某个域名条目的 `owner: ws/unknown`
- **THEN** `flow kb validate` 报告该错误

#### Scenario: owner 为职能 workspace
- **WHEN** 某个账号条目的 `owner` 是一个 `kind: function` 的 workspace
- **THEN** `flow kb validate` 报告"职能 workspace 不能拥有资源"

### Requirement: 按归属查询资源
系统 SHALL 支持按 workspace 列出其拥有的资源，并且可以按资源类型过滤。

#### Scenario: 列出某产品的域名
- **WHEN** 用户运行 `flow ws resources xuanxue-saas --type domain`
- **THEN** 输出 `arcanumber.com` 与 `ganjiday.com` 两个条目

### Requirement: 归属变更
资源的 `owner` 只能通过 `flow resource transfer <资源> <目标 workspace>` 或经过确认的修改提案来更改。每次更改 SHALL 在 `log.md` 中留下 `owner-change` 记录，写明原 owner 和新 owner。本能力 MUST NOT 迁移任务或订阅（这部分由后续的内核能力负责）。

#### Scenario: 转移域名
- **WHEN** 用户运行 `flow resource transfer resources/domains/ganjiday.com product-res`
- **THEN** 该条目的 `owner` 变为 `ws/product-res`，`log.md` 新增一条 `owner-change` 记录，注明原 owner `ws/xuanxue-saas`

### Requirement: 首批资源
系统初始化时 SHALL 能录入 `ws/product-res` 与 `ws/xuanxue-saas` 两个产品 workspace 的资源，至少包括项目卡片、产品条目、各自的域名、Workers 服务、仓库和已接入的数据源。仓库里找不到依据的字段 MUST 留空，并标记为待核实，不得猜测填写。

#### Scenario: 到期日未知
- **WHEN** 录入 `arcanumber.com`，但仓库中没有它的注册到期日
- **THEN** 该条目的 `expires` 为空、`last_verified` 为空，`flow kb validate` 把它列为"从未核实"
