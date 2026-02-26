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

  return db;
}
