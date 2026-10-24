# Flow 密钥命令

先安装 sops、age 和 gitleaks，再运行 `flow init`、`flow secrets init`。
初始化会生成权限为 0600 的 `~/.config/sops/age/keys.txt`，在 config 仓库创建
`.sops.yaml` 和空的 `secrets.sops.yaml` 并提交。重复初始化保留已有私钥和文件。
**立即离线备份私钥；丢失后不能恢复已有密文。**

运行 `flow secrets set telegram/bot-token`，在不回显的提示中输入值。
也可从标准输入传入：非 TTY 时读到 EOF，去掉末尾 CR/LF，保留内部换行和空格。
不要把值写到命令行参数里。路径以 `/` 分隔，每段接受英文、数字、下划线和连字符，
拒绝空段及 `__proto__`、`prototype`、`constructor`。已有字符串与子路径冲突时报错。

`flow secrets list` 只输出路径；`flow secrets get telegram/bot-token` 输出值。
CLI 默认身份为 user；`--actor` 或 `FLOW_ACTOR` 声明非 user 时，get 返回 `user_only`，
即使同时传入 `--actor user` 也不能覆盖环境中的非 user 身份。secrets 是独立 CLI 命令，
不注册为 operation，因此 MCP 没有对应工具。

身份约束沿用本机信任边界：同一系统用户的进程能读私钥，也能清除身份声明并使用 CLI 默认身份。
它不防御同用户进程；按 token 绑定身份见 `docs/hub-auth.md`。

## 加解密与提交

已在 macOS 的 sops 3.13.3 上验证以下方式，并在 Linux CI 运行真实测试：

- 解密用 `sops -d --output-type json secrets.sops.yaml`，输出只进入内存。
- 将嵌套映射在内存中修改并序列化为 JSON，经子进程 stdin 传给
  `sops --config .sops.yaml encrypt --input-type json --output-type yaml --filename-override secrets.sops.yaml`。
  首次初始化尚无规则文件时，以 `--age <公钥>` 代替 `--config`；公钥不含密钥值。
- encrypt 子命令不传文件名，直接读 stdin；`--filename-override` 匹配规则中的精确文件名，
  也支持加密空对象 `{}`。不能传 `/dev/stdin`：Linux 的子进程 stdin 是 socket，
  重新按文件打开会报 `ENXIO`；已用 Linux 容器的真实 execCommand 复现并验证修正。
  明文不进入 argv、临时文件、提交信息或工具错误信息。所有 sops 调用显式设置 `SOPS_AGE_KEY_FILE`。
- 写入在 `withWriteLock` 中串行进行，密文经过 gitleaks 扫描和提交前钩子，原子替换后提交；
  提交失败恢复原文件。私钥保存在 config 仓库外，初始化提交失败仍保留，方便重试。
- config 的 gitleaks 模板仅额外放行加密 MAC 元数据行，不放行整个 sops 文件。
  旧配置追加规则时会把旧 `[allowlist]` 节转换为 `[[allowlists]]`，保留其余用户配置。

core 的 `loadSecrets(home, options)` 返回 `Result<Map<string, string>>`，只在内存中解密及展开路径。
没有初始化时返回 `secrets_not_initialized`；运行时引用替换和脱敏名单见下文。
`ageKeyFile`、`sopsBin`、`ageKeygenBin` 和命令执行器均可注入，测试不使用真实用户目录。

CI 固定安装 sops 3.13.3、age 1.3.2，使用官方 Linux x64 release 并验证固定 SHA-256。
本地找不到 sops 时用 `test.skipIf` 跳过真实测试并输出原因；注入执行器测试仍运行。
CI 设置 `FLOW_REQUIRE_SOPS_TESTS=1`，未安装 sops 时直接失败，防止集成测试静默跳过。

## 中枢运行时解析与脱敏名单

代码在 `packages/hub/src/secrets/`。

- **解析时机**：中枢取得单实例锁后、打开账本前解密一次；之后监听 `config/` 目录，任一 YAML
  变化（去抖 300 毫秒）重新解析。解析结果只在中枢内存中。
- **引用**：扫描 `config/*.yaml`（不含 sops 文件）中**整个字符串**恰好为 `secret://<路径>` 的值；
  嵌在其他文本里的引用不解析。依赖密钥的功能调用 `resolve(配置)`，拿到替换后的配置和缺失的路径；
  有缺失时该功能不启动，中枢其余功能照常。
- **缺失报告**：`flow hub status` 显示"已解析的密钥"个数、"缺少的密钥"（路径与所在文件），
  以及解密失败时的错误码（如 `sops_missing`）。解密失败时保留上一次成功的结果。
- **脱敏名单**：每个解析出的值（以及多行值的每一行、`state/hub.token`）加入"值 → 路径"名单，
  长度小于 8 的值不入名单；密钥轮换后旧值仍保留在名单中直到中枢退出。替换为 `[secret:<路径>]`。
- **挂载点**：
  1. 账本写入前（`packages/hub/src/ledger/scrub.ts`）：名单替换作用于事件载荷的**所有**字符串；
     正则兜底只作用于**自由文本**字段（卡住说明与末尾输出、结果摘要、验收输出、失败/取消说明、
     回复文字、备注）以及活动文本（先限长到 4096 再脱敏）。合同、验收命令 argv、会话 id、
     schedule 载荷、活动 data 等结构化字段只做名单替换，避免正则误报悄悄改掉要执行的内容；
  2. core `redactSecrets` 先套名单再跑正则（名单优先），且名单在截断之前套用；
  3. 中枢日志：`redactingLogger` 包装所有 logger（消息、details、Error）；
  4. HTTP 500 错误信息；
  5. 渠道外发（任务 4.1）：调用 `redactSecrets` 即同时得到名单与正则脱敏。
- **创建任务时的检查**：中枢 `POST /v1/tasks` 与 `task_create` 操作都用 `checkContractSecrets`
  检查合同，命中**高置信度**规则（ghp_/gho_/github_pat_、sk-ant-、AKIA、xoxb-/xoxp-、glpat-、
  npm_、hf_、fht_、JWT、完整的 PEM 私钥块）时拒绝创建，返回 `secret_suspected`（400），提示改用
  `secret://` 引用；错误信息只含字段路径与规则 id。assignment、cli-flag、url-credentials、bearer
  等低置信度规则不参与拒绝。规则分档见 `packages/core/src/ledger/redact.ts` 的
  `HIGH_CONFIDENCE_RULES` / `LOW_CONFIDENCE_RULES`。
- **已知局限**：节点进程不持有密钥，它在上报前用正则脱敏；正则若先命中了已知密钥的一部分，
  到中枢时剩余部分可能已认不出来。节点逐行截断到 2000 字符也发生在中枢之前。
