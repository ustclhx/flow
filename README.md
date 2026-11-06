# Raindown

个人 AI 运营中心：把不同的模型和 harness 串联起来，让已上线的服务自己运转。
产品定义见 [docs/prd.md](docs/prd.md)，当前变更见 `openspec/changes/`。

## 依赖

| 工具 | 版本 | 用途 |
|---|---|---|
| Bun | ≥ 1.4 | 运行时与测试（代码保持 Node 兼容） |
| git | ≥ 2.28（已在 2.39.5 上验证） | brain / raw / config 仓库；`raindown doctor` 检查此版本 |
| gitleaks | ≥ 8.19.0（已在 8.30.1 上验证） | 密钥扫描；需要 `gitleaks stdin` 与 `gitleaks git --staged` 子命令 |

```bash
brew install gitleaks
bun install
(cd packages/cli && bun link)   # 暴露 `raindown` 命令
raindown --version
```

## 开发

```bash
bun test          # 单元与集成测试
bun run lint      # Biome
bun run typecheck # tsc --noEmit
bun run schemas:gen   # 由 zod 定义重新生成 schemas/ 下的 JSON Schema
bun run schemas:check # 检查 schemas/ 是否与定义一致（不一致则非零退出）
```

用户数据位于 `~/raindown-home`（可用 `RAINDOWN_HOME` 覆盖），不进入本仓库。

从旧安装升级见 [从 Flow 迁移](docs/daemon.md#从-flow-迁移)。
