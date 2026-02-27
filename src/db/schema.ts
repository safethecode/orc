import { Database } from "bun:sqlite";

export function initDb(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });

  // Enable WAL mode for better concurrent access
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");

  // Create tables
  db.run(`CREATE TABLE IF NOT EXISTS agents (
    name TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'idle',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    agent_name TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    tier TEXT NOT NULL DEFAULT 'sonnet',
    parent_task_id TEXT,
    result TEXT,
    token_usage INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0.0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT,
    FOREIGN KEY (agent_name) REFERENCES agents(name),
    FOREIGN KEY (parent_task_id) REFERENCES tasks(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    content TEXT NOT NULL,
    task_ref TEXT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    read INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (from_agent) REFERENCES agents(name),
    FOREIGN KEY (to_agent) REFERENCES agents(name)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS file_locks (
    file_path TEXT PRIMARY KEY,
    agent_name TEXT NOT NULL,
    task_id TEXT NOT NULL,
    locked_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (agent_name) REFERENCES agents(name),
    FOREIGN KEY (task_id) REFERENCES tasks(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS token_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    task_id TEXT,
    tokens INTEGER NOT NULL,
    cost_usd REAL NOT NULL,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (agent_name) REFERENCES agents(name),
    FOREIGN KEY (task_id) REFERENCES tasks(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS file_ownership (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    task_id TEXT NOT NULL,
    permission TEXT NOT NULL CHECK(permission IN ('owns', 'reads')),
    declared_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (agent_name) REFERENCES agents(name),
    FOREIGN KEY (task_id) REFERENCES tasks(id)
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_ownership_agent ON file_ownership(agent_name)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_ownership_pattern ON file_ownership(pattern)`);

  db.run(`CREATE TABLE IF NOT EXISTS session_snapshots (
    id TEXT PRIMARY KEY,
    session_name TEXT NOT NULL DEFAULT 'repl',
    turns_json TEXT NOT NULL,
    language TEXT,
    summary TEXT,
    turn_count INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_snapshot_session ON session_snapshots(session_name)`);

  db.run(`CREATE TABLE IF NOT EXISTS memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    namespace TEXT NOT NULL DEFAULT 'global',
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    source TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
    access_count INTEGER DEFAULT 0,
    UNIQUE(namespace, key)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS codebase_map (
    file_path TEXT PRIMARY KEY,
    purpose TEXT NOT NULL,
    last_agent TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS task_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    detail TEXT,
    phase TEXT NOT NULL DEFAULT 'general',
    started_at TEXT NOT NULL,
    ended_at TEXT,
    success INTEGER,
    duration_ms INTEGER
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_task_log_task ON task_log(task_id)`);

  db.run(`CREATE TABLE IF NOT EXISTS recovery_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    failure_type TEXT NOT NULL,
    approach TEXT NOT NULL,
    action_taken TEXT NOT NULL,
    success INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_recovery_task ON recovery_history(task_id)`);

  db.run(`CREATE TABLE IF NOT EXISTS predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_prompt TEXT NOT NULL,
    risks_json TEXT,
    checklist_json TEXT,
    outcome TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS prompt_cache (
    hash TEXT PRIMARY KEY,
    prompt TEXT NOT NULL,
    response TEXT NOT NULL,
    model TEXT NOT NULL,
    tokens INTEGER NOT NULL DEFAULT 0,
    hit_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_hit_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    decision TEXT NOT NULL,
    context TEXT NOT NULL DEFAULT '',
    decided_by TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    tags_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    superseded_by TEXT
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_decisions_status ON decisions(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_decisions_tags ON decisions(tags_json)`);

  db.run(`CREATE TABLE IF NOT EXISTS logical_conflicts (
    id TEXT PRIMARY KEY,
    agent_a TEXT NOT NULL,
    agent_b TEXT NOT NULL,
    description TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'warning',
    files_json TEXT NOT NULL DEFAULT '[]',
    detected_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved INTEGER NOT NULL DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS port_allocations (
    port INTEGER PRIMARY KEY,
    agent_name TEXT NOT NULL,
    task_id TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT '',
    allocated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS cleanup_queue (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    target TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    registered_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_cleanup_agent ON cleanup_queue(agent_name)`);

  db.run(`CREATE TABLE IF NOT EXISTS checkpoints (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    sha TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_checkpoint_task ON checkpoints(task_id)`);

  return db;
}
