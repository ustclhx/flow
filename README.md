# flow

个人 AI 运营中心：把不同的模型和 harness 串联起来，让已上线的服务自己运转。
产品定义见 [docs/prd.md](docs/prd.md)，当前变更见 `openspec/changes/`。

## 依赖

| 工具 | 版本 | 用途 |
|---|---|---|
| Bun | ≥ 1.4 | 运行时与测试（代码保持 Node 兼容） |
| git | ≥ 2.40 | brain / raw / config 仓库 |
| gitleaks | ≥ 8.19.0（已在 8.30.1 上验证） | 密钥扫描；需要 `gitleaks stdin` 与 `gitleaks git --staged` 子命令 |

```bash
brew install gitleaks
bun install
(cd packages/cli && bun link)   # 暴露 `flow` 命令
flow --version
```

## 开发

```bash
bun test          # 单元与集成测试
bun run lint      # Biome
bun run typecheck # tsc --noEmit
```

用户数据位于 `~/flow-home`（可用 `FLOW_HOME` 覆盖），不进入本仓库。
