# 项目开发约定

## 先读什么

- 产品定义：`docs/prd.md`。当前变更：`openspec/changes/<change>/`（proposal、design、specs、tasks）。
- 实现必须满足对应 spec 中的每个 Scenario；design 中的决策（D1–D12）是约束，不要另起炉灶。

## 结构

- `packages/core`：全部业务逻辑。返回 `Result<T>`（`ok` / `fail`），不直接打印、不调用 `process.exit`。
- **知识访问操作**（kb_search、kb_journal、capture…）只在 `packages/core/src/ops/` 中用 `defineOperation` 定义一次（输入 zod schema + run），并加入 `ops/index.ts` 的 `operations`。CLI 命令与 MCP 工具都由它自动生成，不要再为这类操作手写 CLI 命令或 MCP 工具。
- `packages/cli`：命令适配层。`src/from-operation.ts` 把操作转成命令；只有不属于知识访问的命令（init、doctor、agents sync）才在 `src/commands/` 下用 `defineCommand` 单独写，并在 `src/commands/index.ts` 注册。
- `packages/mcp`：MCP 适配层，遍历同一个 `operations` 生成工具。
- 写入一律经过 `packages/core/src/write/`（`commitWrite`、`writeEntry`、`appendJournal`、`appendCapture`、`withWriteLock`），不要绕开它直接写 brain 或 raw。

## 约定

- TypeScript strict；跨边界的数据（frontmatter、配置、提案、MCP 输入）一律用 zod 校验。
- 不直接引用 `bun:sqlite` 或其他 Bun 专有 API，SQLite 通过 `@flow/core` 的 `openDatabase`。
- 错误用稳定的机器可读错误码；退出码约定：0 成功，1 失败，2 用法错误，3 可重试。
- 测试用 `bun test`，放在各包的 `test/` 下；涉及文件系统的测试一律使用临时目录与临时 `FLOW_HOME`，绝不读写真实的 `~/flow-home`。
- 提交前必须通过：`bun test`、`bun run lint`、`bun run typecheck`。
- 注释和文档用中文，代码标识符用英文。
