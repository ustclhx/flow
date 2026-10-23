/**
 * `flow node` 执行节点（design D6；tasks.md 4.3）：注册、领取、续约、提交，
 * 执行器插件注册表与 fake 执行器。
 * 节点配置 `config/node.yaml` 的定义与加载在 `@flow/core`（与 hub.yaml 共用）。
 */
export { loadNodeConfig, type NodeConfig, nodeConfigSchema, resolveHubUrl } from '@flow/core'
export {
  createNodeHubClient,
  type FetchLike,
  type NodeHubClient,
  type NodeHubClientOptions,
  nodeHubClientFromHome,
  type RegisterRequest,
} from './client.ts'
export { type NodeClock, sleep, systemClock } from './clock.ts'
export {
  ActivityQueue,
  createExecutorRegistry,
  type ExecutorContext,
  type ExecutorOutcome,
  type ExecutorPlugin,
  type ExecutorRegistry,
  type ExecutorRun,
} from './executor.ts'
export { createFakeExecutor, type FakeExecutorOptions } from './fake.ts'
export {
  generateNodeId,
  JUMP_THRESHOLD_MS,
  loadOrCreateNodeId,
  type NodeLogger,
  type RunningNode,
  type StartNodeOptions,
  startNode,
} from './node.ts'
