PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  agent_version TEXT NOT NULL,
  architecture TEXT NOT NULL,
  cpu_count INTEGER NOT NULL,
  memory_mb INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('online','offline','draining','disabled')),
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  hmac_key_enc TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('scrape','browser','document')),
  status TEXT NOT NULL CHECK (status IN ('created','queued','leased','running','retrying','completed','failed','cancelled','expired')),
  url TEXT,
  preferred_engine TEXT NOT NULL DEFAULT 'auto',
  selected_engine TEXT,
  requires_auth INTEGER NOT NULL DEFAULT 0,
  destructive INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  timeout_ms INTEGER,
  created_at INTEGER NOT NULL,
  queued_at INTEGER,
  started_at INTEGER,
  finished_at INTEGER,
  result_artifact_id TEXT,
  error_code TEXT,
  error_message TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_user_created ON tasks(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS task_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  node_id TEXT REFERENCES nodes(id),
  attempt_number INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  engine TEXT,
  status TEXT NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  duration_ms INTEGER,
  error_code TEXT,
  error_message TEXT,
  memory_peak_mb INTEGER,
  result_artifact_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(task_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_attempts_task ON task_attempts(task_id, attempt_number DESC);

CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_id TEXT REFERENCES task_attempts(id),
  node_id TEXT REFERENCES nodes(id),
  event TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_task_id ON task_events(task_id, id);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_id TEXT REFERENCES task_attempts(id),
  kind TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id, created_at);

CREATE TABLE IF NOT EXISTS browser_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  name TEXT NOT NULL,
  r2_key TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS domain_policies (
  domain TEXT PRIMARY KEY,
  preferred_engine TEXT,
  force_engine TEXT,
  allow_http INTEGER NOT NULL DEFAULT 1,
  allow_lightpanda INTEGER NOT NULL DEFAULT 1,
  allow_chromium INTEGER NOT NULL DEFAULT 1,
  requires_chromium INTEGER NOT NULL DEFAULT 0,
  max_concurrency INTEGER,
  timeout_ms INTEGER,
  notes TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS domain_engine_stats (
  domain TEXT NOT NULL,
  engine TEXT NOT NULL,
  task_type TEXT NOT NULL,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  average_latency_ms REAL NOT NULL DEFAULT 0,
  average_memory_mb REAL NOT NULL DEFAULT 0,
  recent_failures INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(domain, engine, task_type)
);

CREATE TABLE IF NOT EXISTS automation_rules (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  rule_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS hmac_nonces (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(node_id, nonce)
);

CREATE INDEX IF NOT EXISTS idx_hmac_nonces_expiry ON hmac_nonces(expires_at);

CREATE TABLE IF NOT EXISTS destructive_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL REFERENCES task_attempts(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('reserved','completed','unknown')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
