/**
 * `flow node` 执行节点（design D6；tasks.md 4.3）：注册、领取、续约、提交，
 * 执行器插件注册表与 fake 执行器。
 * 节点配置 `config/node.yaml` 的定义与加载在 `@flow/core`（与 hub.yaml 共用）。
 */
export { loadNodeConfig, type NodeConfig, nodeConfigSchema, resolveHubUrl } from '@flow/core'
export {
  type ApprovalPrecheck,
  type ApprovalRequest,
  buildOptions as buildClaudeSdkOptions,
  CLAUDE_SDK_EXECUTOR,
  type ClaudeQueryFn,
  type ClaudeQueryHandle,
  type ClaudeSdkExecutorOptions,
  type ClaudeSdkPermissions,
  classifyClaudeSdk,
  claudeSdkPermissions,
  costOf,
  createClaudeSdkExecutor,
  DEFAULT_APPROVAL_TIMEOUT_MINUTES,
  DEFAULT_CLAUDE_MODEL,
  renderReply,
  renderTaskPrompt,
  summarizeToolInput,
} from './claude-sdk.ts'
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
  type DeliverResult,
  type ExecutorContext,
  type ExecutorOutcome,
  type ExecutorPlugin,
  type ExecutorRegistry,
  type ExecutorRun,
  idleSignal,
  isIdleSignal,
  isResumedSignal,
  resumedSignal,
  type StuckSnapshot,
  type StuckVerdict,
} from './executor.ts'
export { classifyFake, createFakeExecutor, type FakeExecutorOptions } from './fake.ts'
export {
  DELIVER_GIVE_UP_MS,
  DELIVER_TIMEOUT_MS,
  generateNodeId,
  JUMP_THRESHOLD_MS,
  loadOrCreateNodeId,
  type NodeLogger,
  type NoProgressResolver,
  noProgressMs,
  type RunningNode,
  STUCK_TAIL_LINES,
  type StartNodeOptions,
  startNode,
  TIMEOUT_GRACE_MS,
} from './node.ts'
