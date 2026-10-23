/**
 * `flow node` 执行节点（design D6）。本包目前只有骨架与执行器插件接口；
 * 注册、领取、续约循环与 fake 执行器在第 4 组实现。
 * 节点配置 `config/node.yaml` 的定义与加载在 `@flow/core`（与 hub.yaml 共用）。
 */
export { loadNodeConfig, type NodeConfig, nodeConfigSchema, resolveHubUrl } from '@flow/core'
export type {
  ExecutorContext,
  ExecutorOutcome,
  ExecutorPlugin,
  ExecutorRun,
} from './executor.ts'
