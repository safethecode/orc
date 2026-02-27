import type { Database } from "bun:sqlite";

export interface MemoryEntry {
  id: number;
  namespace: string;
  key: string;
  value: string;
  source: string | null;
  createdAt: string;
  updatedAt: string;
  accessedAt: string;
  accessCount: number;
}

export class MemoryStore {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  set(namespace: string, key: string, value: string, source?: string): void {
    this.db.prepare(
      `INSERT INTO memory (namespace, key, value, source)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(namespace, key) DO UPDATE SET
         value = excluded.value,
         source = excluded.source,
         updated_at = datetime('now')`,
    ).run(namespace, key, value, source ?? null);
  }

  get(namespace: string, key: string): MemoryEntry | null {
    const row = this.db.prepare(
      `SELECT * FROM memory WHERE namespace = ? AND key = ?`,
    ).get(namespace, key) as Record<string, unknown> | null;
    if (!row) return null;

    this.db.prepare(
      `UPDATE memory SET access_count = access_count + 1, accessed_at = datetime('now')
       WHERE namespace = ? AND key = ?`,
    ).run(namespace, key);

    return this.mapEntry(row);
  }

  search(query: string, namespace?: string, limit = 5): MemoryEntry[] {
    const pattern = `%${query}%`;
    const sql = namespace
      ? `SELECT * FROM memory WHERE namespace = ? AND (key LIKE ? OR value LIKE ?) ORDER BY access_count DESC, updated_at DESC LIMIT ?`
      : `SELECT * FROM memory WHERE (key LIKE ? OR value LIKE ?) ORDER BY access_count DESC, updated_at DESC LIMIT ?`;
    const rows = namespace
      ? this.db.prepare(sql).all(namespace, pattern, pattern, limit)
      : this.db.prepare(sql).all(pattern, pattern, limit);
    return (rows as Record<string, unknown>[]).map((r) => this.mapEntry(r));
  }

  getRelevantMemories(prompt: string, namespace?: string, limit = 5): MemoryEntry[] {
    const words = prompt
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 10);

    if (words.length === 0) return [];

    const conditions = words.map(() => `(LOWER(key) LIKE ? OR LOWER(value) LIKE ?)`);
    const orClause = conditions.join(" OR ");
    const nsClause = namespace ? `AND namespace = ? ` : "";

    const sql = `SELECT *, (${words.map(() => `(CASE WHEN LOWER(key) LIKE ? OR LOWER(value) LIKE ? THEN 1 ELSE 0 END)`).join(" + ")}) as relevance
      FROM memory WHERE (${orClause}) ${nsClause}ORDER BY relevance DESC, access_count DESC LIMIT ?`;

    const params: (string | number)[] = [];
    // relevance scoring params
    for (const w of words) {
      params.push(`%${w}%`, `%${w}%`);
    }
    // WHERE clause params
    for (const w of words) {
      params.push(`%${w}%`, `%${w}%`);
    }
    if (namespace) params.push(namespace);
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.mapEntry(r));
  }

  list(namespace?: string, limit = 20): MemoryEntry[] {
    const sql = namespace
      ? `SELECT * FROM memory WHERE namespace = ? ORDER BY updated_at DESC LIMIT ?`
      : `SELECT * FROM memory ORDER BY updated_at DESC LIMIT ?`;
    const rows = namespace
      ? this.db.prepare(sql).all(namespace, limit)
      : this.db.prepare(sql).all(limit);
    return (rows as Record<string, unknown>[]).map((r) => this.mapEntry(r));
  }

  delete(namespace: string, key: string): boolean {
    const result = this.db.prepare(
      `DELETE FROM memory WHERE namespace = ? AND key = ?`,
    ).run(namespace, key);
    return result.changes > 0;
  }

  formatForPrompt(memories: MemoryEntry[]): string {
    if (memories.length === 0) return "";
    const lines = memories.map((m) => `- ${m.key}: ${m.value}`);
    return `\nRelevant context from previous sessions:\n${lines.join("\n")}\n`;
  }

  private mapEntry(row: Record<string, unknown>): MemoryEntry {
    return {
      id: row.id as number,
      namespace: row.namespace as string,
      key: row.key as string,
      value: row.value as string,
      source: row.source as string | null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      accessedAt: row.accessed_at as string,
      accessCount: row.access_count as number,
    };
  }
}
