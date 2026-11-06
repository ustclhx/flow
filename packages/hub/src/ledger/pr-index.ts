import { type Database, type LedgerEvent, normalizePrUrl } from '@raindown/core'

/** PR 关联只追加，任务重试后仍能沿索引找回历史产物与审查。 */
export function indexTaskPrs(db: Database, event: LedgerEvent): void {
  if (!event.task_id || !event.workspace) return
  let urls: string[] = []
  if (event.type === 'task.created') {
    const inputs = event.payload.contract.inputs
    urls = [inputs?.pr, inputs?.review?.pr].filter((url): url is string => !!url)
  } else if (
    event.type === 'task.done' ||
    event.type === 'task.failed' ||
    event.type === 'task.cancelled'
  ) {
    urls = (event.payload.result?.artifacts ?? [])
      .filter((artifact) => artifact.kind === 'pr')
      .map((artifact) => artifact.ref)
  }
  if (!urls.length) return
  const contract =
    event.type === 'task.created'
      ? event.payload.contract
      : (JSON.parse(
          (
            db.prepare('SELECT contract_json FROM tasks WHERE id = ?').get(event.task_id) as {
              contract_json: string
            }
          ).contract_json,
        ) as { role: string })
  // JSON 长度在 JS 中计算，保留 emoji 等非 BMP 角色名的 UTF-16 字符计数。
  const summaryChars = JSON.stringify({ id: event.task_id, role: contract.role, status: '' }).length
  for (const url of urls) {
    const pr = normalizePrUrl(url)
    if (!pr) continue
    db.prepare(
      `INSERT OR IGNORE INTO task_prs (task_id, workspace, pr, pr_number, url, summary_chars) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(event.task_id, event.workspace, pr, Number(pr.split('/').at(-1)), url, summaryChars)
  }
}
