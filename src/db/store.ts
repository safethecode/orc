import { Database } from "bun:sqlite";
import type {
  Task,
  AgentMessage,
  FileLock,
  TaskStatus,
  AgentStatus,
  ModelTier,
} from "../config/types.ts";

export class Store {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  // ── Tasks ────────────────────────────────────────────────────────────

  createTask(task: {
    id: string;
    prompt: string;
    tier: ModelTier;
    parentTaskId?: string;
  }): void {
    const stmt = this.db.prepare(
      `INSERT INTO tasks (id, prompt, tier, parent_task_id) VALUES (?, ?, ?, ?)`
    );
    stmt.run(task.id, task.prompt, task.tier, task.parentTaskId ?? null);
  }

  getTask(id: string): Task | null {
    const stmt = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`);
    const row = stmt.get(id) as Record<string, unknown> | null;
    if (!row) return null;
    return this.mapTask(row);
  }

  updateTask(
    id: string,
    updates: Partial<
      Pick<
        Task,
        | "status"
        | "agentName"
        | "result"
        | "tokenUsage"
        | "costUsd"
        | "startedAt"
        | "completedAt"
      >
    >
  ): void {
    const columnMap: Record<string, string> = {
      status: "status",
      agentName: "agent_name",
      result: "result",
      tokenUsage: "token_usage",
      costUsd: "cost_usd",
      startedAt: "started_at",
      completedAt: "completed_at",
    };

    const sets: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(updates)) {
      const col = columnMap[key];
      if (col) {
        sets.push(`${col} = ?`);
        values.push(value);
      }
    }

    if (sets.length === 0) return;

    values.push(id);
    const stmt = this.db.prepare(
      `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`
    );
    stmt.run(...values);
  }

  listTasks(filter?: { status?: TaskStatus; agentName?: string }): Task[] {
    let sql = `SELECT * FROM tasks`;
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filter?.status) {
      conditions.push("status = ?");
      values.push(filter.status);
    }
    if (filter?.agentName) {
      conditions.push("agent_name = ?");
      values.push(filter.agentName);
    }

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...values) as Record<string, unknown>[];
    return rows.map((r) => this.mapTask(r));
  }

  // ── Agents ───────────────────────────────────────────────────────────

  registerAgent(name: string, provider: string, model: string): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO agents (name, provider, model) VALUES (?, ?, ?)`
    );
    stmt.run(name, provider, model);
  }

  getAgent(
    name: string
  ): {
    name: string;
    provider: string;
    model: string;
    status: AgentStatus;
    created_at: string;
  } | null {
    const stmt = this.db.prepare(`SELECT * FROM agents WHERE name = ?`);
    const row = stmt.get(name) as Record<string, unknown> | null;
    if (!row) return null;
    return {
      name: row.name as string,
      provider: row.provider as string,
      model: row.model as string,
      status: row.status as AgentStatus,
      created_at: row.created_at as string,
    };
  }

  updateAgentStatus(name: string, status: AgentStatus): void {
    const stmt = this.db.prepare(
      `UPDATE agents SET status = ? WHERE name = ?`
    );
    stmt.run(status, name);
  }

  listAgents(): Array<{
    name: string;
    provider: string;
    model: string;
    status: AgentStatus;
  }> {
    const stmt = this.db.prepare(
      `SELECT name, provider, model, status FROM agents`
    );
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map((r) => ({
      name: r.name as string,
      provider: r.provider as string,
      model: r.model as string,
      status: r.status as AgentStatus,
    }));
  }

  // ── File Locks ───────────────────────────────────────────────────────

  lockFile(filePath: string, agentName: string, taskId: string): boolean {
    try {
      const stmt = this.db.prepare(
        `INSERT INTO file_locks (file_path, agent_name, task_id) VALUES (?, ?, ?)`
      );
      stmt.run(filePath, agentName, taskId);
      return true;
    } catch {
      return false;
    }
  }

  unlockFile(filePath: string): void {
    const stmt = this.db.prepare(
      `DELETE FROM file_locks WHERE file_path = ?`
    );
    stmt.run(filePath);
  }

  unlockByAgent(agentName: string): void {
    const stmt = this.db.prepare(
      `DELETE FROM file_locks WHERE agent_name = ?`
    );
    stmt.run(agentName);
  }

  isFileLocked(filePath: string): FileLock | null {
    const stmt = this.db.prepare(
      `SELECT * FROM file_locks WHERE file_path = ?`
    );
    const row = stmt.get(filePath) as Record<string, unknown> | null;
    if (!row) return null;
    return {
      filePath: row.file_path as string,
      agentName: row.agent_name as string,
      taskId: row.task_id as string,
      lockedAt: row.locked_at as string,
    };
  }

  // ── Token Usage ──────────────────────────────────────────────────────

  recordTokenUsage(
    agentName: string,
    taskId: string | null,
    tokens: number,
    costUsd: number
  ): void {
    const stmt = this.db.prepare(
      `INSERT INTO token_usage (agent_name, task_id, tokens, cost_usd) VALUES (?, ?, ?, ?)`
    );
    stmt.run(agentName, taskId, tokens, costUsd);
  }

  getAgentUsage(agentName: string): { totalTokens: number; totalCost: number } {
    const stmt = this.db.prepare(
      `SELECT COALESCE(SUM(tokens), 0) as total_tokens, COALESCE(SUM(cost_usd), 0) as total_cost FROM token_usage WHERE agent_name = ?`
    );
    const row = stmt.get(agentName) as Record<string, unknown>;
    return {
      totalTokens: row.total_tokens as number,
      totalCost: row.total_cost as number,
    };
  }

  getDailyUsage(): { totalTokens: number; totalCost: number } {
    const stmt = this.db.prepare(
      `SELECT COALESCE(SUM(tokens), 0) as total_tokens, COALESCE(SUM(cost_usd), 0) as total_cost FROM token_usage WHERE date(timestamp) = date('now')`
    );
    const row = stmt.get() as Record<string, unknown>;
    return {
      totalTokens: row.total_tokens as number,
      totalCost: row.total_cost as number,
    };
  }

  // ── Messages ─────────────────────────────────────────────────────────

  addMessage(msg: {
    id: string;
    from: string;
    to: string;
    content: string;
    taskRef?: string;
  }): void {
    const stmt = this.db.prepare(
      `INSERT INTO messages (id, from_agent, to_agent, content, task_ref) VALUES (?, ?, ?, ?, ?)`
    );
    stmt.run(msg.id, msg.from, msg.to, msg.content, msg.taskRef ?? null);
  }

  getUnreadMessages(agentName: string): AgentMessage[] {
    const stmt = this.db.prepare(
      `SELECT * FROM messages WHERE to_agent = ? AND read = 0 ORDER BY timestamp ASC`
    );
    const rows = stmt.all(agentName) as Record<string, unknown>[];
    return rows.map((r) => this.mapMessage(r));
  }

  markMessageRead(id: string): void {
    const stmt = this.db.prepare(`UPDATE messages SET read = 1 WHERE id = ?`);
    stmt.run(id);
  }

  // ── Private Helpers ──────────────────────────────────────────────────

  private mapTask(row: Record<string, unknown>): Task {
    return {
      id: row.id as string,
      prompt: row.prompt as string,
      agentName: (row.agent_name as string) ?? null,
      status: row.status as TaskStatus,
      tier: row.tier as ModelTier,
      parentTaskId: (row.parent_task_id as string) ?? null,
      result: (row.result as string) ?? null,
      tokenUsage: (row.token_usage as number) ?? 0,
      costUsd: (row.cost_usd as number) ?? 0,
      createdAt: row.created_at as string,
      startedAt: (row.started_at as string) ?? null,
      completedAt: (row.completed_at as string) ?? null,
    };
  }

  private mapMessage(row: Record<string, unknown>): AgentMessage {
    return {
      id: row.id as string,
      from: row.from_agent as string,
      to: row.to_agent as string,
      content: row.content as string,
      taskRef: (row.task_ref as string) ?? null,
      timestamp: row.timestamp as string,
      read: (row.read as number) === 1,
    };
  }
}
