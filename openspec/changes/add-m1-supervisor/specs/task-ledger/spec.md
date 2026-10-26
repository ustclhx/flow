# Spec Delta

## ADDED Requirements

### Requirement: parent 校验
任何身份创建任务时，若合同带 `parent`，中枢 SHALL 校验该任务存在且与新任务属于同一 workspace，否则拒绝（`parent_not_found` 或 `workspace_mismatch`）。

#### Scenario: 跨 workspace 挂载
- **WHEN** 新任务属于 `ws/product-res`，`parent` 是 `ws/xuanxue-saas` 的任务
- **THEN** 返回 `workspace_mismatch`，不创建任务

#### Scenario: 不存在的 parent
- **WHEN** `parent` 指向不存在的任务 id
- **THEN** 返回 `parent_not_found`
