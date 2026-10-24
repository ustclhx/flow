/**
 * 账本表结构（design D2）。
 *
 * - `events`：只追加。用触发器禁止 UPDATE / DELETE，保证已写入的事件不可修改。
 * - 投影表：`tasks`、`nodes`、`leases`、`schedule_fires`、`replies`，全部由 `apply(event)` 维护，
 *   可随时清空后按 seq 重放得到（`rebuild()`）。
 * - 软状态列（不由事件派生，重建时按 D2 重置，见 `SOFT_COLUMNS`）：
 *   `tasks.last_activity_at`、`tasks.activity_json`、`nodes.last_seen_at`、`leases.expires_at`。
 */

export const PROJECTION_TABLES = ['tasks', 'nodes', 'leases', 'schedule_fires', 'replies'] as const
export type ProjectionTable = (typeof PROJECTION_TABLES)[number]

/** 每张投影表的软状态列；比较"增量投影 == 重建投影"时排除。 */
export const SOFT_COLUMNS: Readonly<Record<ProjectionTable, readonly string[]>> = {
  tasks: ['last_activity_at', 'activity_json'],
  nodes: ['last_seen_at'],
  leases: ['expires_at'],
  schedule_fires: [],
  replies: [],
}

/** 每张投影表的主键（快照排序用）。 */
export const PROJECTION_KEYS: Readonly<Record<ProjectionTable, string>> = {
  tasks: 'id',
  nodes: 'node_id',
  leases: 'lease_id',
  schedule_fires: 'rule_id, planned_at',
  replies: 'id',
}

export const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL,
  type         TEXT NOT NULL,
  workspace    TEXT,
  task_id      TEXT,
  actor        TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_task ON events (task_id, seq);
CREATE INDEX IF NOT EXISTS events_workspace ON events (workspace, seq);
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

CREATE TABLE IF NOT EXISTS tasks (
  id               TEXT PRIMARY KEY,
  workspace        TEXT NOT NULL,
  status           TEXT NOT NULL,
  contract_json    TEXT NOT NULL,
  idempotency_key  TEXT UNIQUE,
  parent           TEXT,
  attempt          INTEGER NOT NULL DEFAULT 0,
  created_seq      INTEGER NOT NULL,
  last_seq         INTEGER NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  started_at       TEXT,
  finished_at      TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  blocked_json     TEXT,
  result_json      TEXT,
  created_by       TEXT NOT NULL,
  last_activity_at TEXT,
  activity_json    TEXT NOT NULL DEFAULT '[]',
  resume_json      TEXT
);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks (status, created_seq);
CREATE INDEX IF NOT EXISTS tasks_workspace ON tasks (workspace, created_seq);
CREATE INDEX IF NOT EXISTS tasks_parent ON tasks (parent, created_seq);

CREATE TABLE IF NOT EXISTS nodes (
  node_id           TEXT PRIMARY KEY,
  hostname          TEXT NOT NULL,
  version           TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  executors_json    TEXT NOT NULL,
  concurrency       INTEGER NOT NULL,
  registered_at     TEXT NOT NULL,
  last_seen_at      TEXT
);

CREATE TABLE IF NOT EXISTS leases (
  lease_id     TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL,
  node_id      TEXT NOT NULL,
  attempt      INTEGER NOT NULL,
  token_sha256 TEXT NOT NULL,
  ttl_s        INTEGER NOT NULL,
  granted_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('active', 'released', 'expired')),
  ended_at     TEXT
);
CREATE INDEX IF NOT EXISTS leases_task ON leases (task_id, state);
CREATE INDEX IF NOT EXISTS leases_active ON leases (state, expires_at);

CREATE TABLE IF NOT EXISTS schedule_fires (
  rule_id      TEXT NOT NULL,
  planned_at   TEXT NOT NULL,
  workspace    TEXT NOT NULL,
  fired_at     TEXT NOT NULL,
  missed       INTEGER NOT NULL,
  seq          INTEGER NOT NULL,
  PRIMARY KEY (rule_id, planned_at)
);

CREATE TABLE IF NOT EXISTS replies (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('text', 'approve', 'deny')),
  text         TEXT,
  by           TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  created_seq  INTEGER NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'requeued', 'dropped')),
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS replies_task ON replies (task_id, state, created_seq);
`

/**
 * 旧版本账本缺少的列（`CREATE TABLE IF NOT EXISTS` 不会补列）。打开账本时逐一补上；
 * 这些列都由事件派生，补列后旧事件中本来就没有对应信息，取 NULL 与重建结果一致。
 */
export const LEDGER_COLUMN_MIGRATIONS: ReadonlyArray<{
  table: ProjectionTable
  column: string
  ddl: string
}> = [
  { table: 'tasks', column: 'resume_json', ddl: 'ALTER TABLE tasks ADD COLUMN resume_json TEXT' },
]
