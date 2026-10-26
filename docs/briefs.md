# Workspace 简报与 supervisor 笔记

`ws_brief` 为一个 workspace 拼出一份有字符预算的简报。supervisor 每次唤醒先读它（预算 8000），结束前用 `brief_update` 写回自己的笔记（add-m1-supervisor D8）。

## 简报的组成与顺序

1. **简报笔记**：`brain/briefs/<id>.md` 中已提交的内容（只读 git HEAD，不读工作区文件）；
2. workspace 描述；
3. 进行中的任务、待处理条目（来自中枢）；
4. 近期决策（本 workspace 的 `decision` 条目，驳回的不列）；
5. 代回复记录（不是指令）：中枢根据 `task.replied`（actor supervisor）与 `task.reply_escalated` 生成，只含任务 id、决定、时间与回答长度，**不含回答原文**——回答是 reply 唤醒写出的内容，不能进入后续唤醒的上下文（D15）；原文只进入用户可见的每日摘要；
6. 项目卡片、资源列表、最近 journal、待核实事实。

第 3、5 两节只在本 workspace 启用了 supervisor（`supervisor.enabled` 且存在 `kind: supervisor` 角色）时才请求中枢；未启用时不请求，也不出现"中枢数据"一节。中枢不可用时其余部分照常生成，并注明缺少中枢数据。

## 预算与截断（相对 ① 的变化）

① 中的简报是"按固定优先级截断"：从最后一节起整节省略，前面的节可以占满预算。现在改为：

- 笔记放在最前，最多占预算的 40%，超出时截断；
- 其余各节**分享剩余预算**（注水式分配）：放得下的节完整保留，放不下的长节平分剩余额度，在行边界截断并标注"…（本节已截断）"，因此一节很长的 journal 不会挤掉进行中的任务和代回复记录；
- 额度小到放不下一节的标题加少量内容时，才从最低优先级（最后一节）开始整节省略，末尾注明"> 已省略：…"；省略说明包含在预算内。

输出中的 `truncated` 列出被截断的节，`omitted` 列出整节省略的节，`note_hash` 是笔记的哈希（`brief_update` 的 `base_hash`），`hub` 为 `ok`、`unavailable` 或 `skipped`（未启用 supervisor）。

## brief_update

- 由中枢执行（`POST /v1/briefs`），只有 user 与经唤醒绑定 token 认证的 supervisor 能调用，见 `docs/hub-auth.md`；
- 整体替换，最多 3000 字符（`brief_too_long`）；`base_hash` 与当前已提交的笔记不一致时返回 `conflict`，文件不变；笔记不存在时 `base_hash` 为空串的 sha256；
- 写入前脱敏，再经写入层的 gitleaks 扫描并提交（log 操作 `brief`）；
- `briefs/` 不是条目：不进 `readBrainEntries`、校验、`index.md` 与搜索；其他写入路径（条目写入、提案、直写，包括 `Briefs/` 这类大小写变体）一律拒绝。
