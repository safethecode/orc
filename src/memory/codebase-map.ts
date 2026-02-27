import type { Database } from "bun:sqlite";
import type { FileEntry } from "../config/types.ts";

export class CodebaseMap {
  constructor(private db: Database) {}

  update(path: string, purpose: string, agent?: string): void {
    this.db.prepare(
      `INSERT INTO codebase_map (file_path, purpose, last_agent, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(file_path) DO UPDATE SET
         purpose = excluded.purpose,
         last_agent = excluded.last_agent,
         updated_at = datetime('now')`,
    ).run(path, purpose, agent ?? null);
  }

  get(path: string): FileEntry | null {
    const row = this.db.prepare(
      `SELECT * FROM codebase_map WHERE file_path = ?`,
    ).get(path) as Record<string, unknown> | null;
    if (!row) return null;
    return this.mapEntry(row);
  }

  search(query: string, limit = 10): FileEntry[] {
    const pattern = `%${query}%`;
    const rows = this.db.prepare(
      `SELECT * FROM codebase_map WHERE file_path LIKE ? OR purpose LIKE ? ORDER BY updated_at DESC LIMIT ?`,
    ).all(pattern, pattern, limit) as Record<string, unknown>[];
    return rows.map((r) => this.mapEntry(r));
  }

  listByAgent(agentName: string): FileEntry[] {
    const rows = this.db.prepare(
      `SELECT * FROM codebase_map WHERE last_agent = ? ORDER BY updated_at DESC`,
    ).all(agentName) as Record<string, unknown>[];
    return rows.map((r) => this.mapEntry(r));
  }

  buildContext(paths: string[]): string {
    if (paths.length === 0) return "";
    const entries = paths
      .map((p) => this.get(p))
      .filter((e): e is FileEntry => e != null);
    return entries.map((e) => `${e.path}: ${e.purpose}`).join("\n");
  }

  getProjectOverview(limit = 50): string {
    const rows = this.db.prepare(
      `SELECT * FROM codebase_map ORDER BY updated_at DESC LIMIT ?`,
    ).all(limit) as Record<string, unknown>[];
    const entries = rows.map((r) => this.mapEntry(r));
    if (entries.length === 0) return "No codebase map entries yet.";
    return `Project files (${entries.length}):\n` +
      entries.map((e) => `  ${e.path} — ${e.purpose}`).join("\n");
  }

  private mapEntry(row: Record<string, unknown>): FileEntry {
    return {
      path: row.file_path as string,
      purpose: row.purpose as string,
      lastAgent: row.last_agent as string | undefined,
      lastUpdated: row.updated_at as string,
    };
  }
}
