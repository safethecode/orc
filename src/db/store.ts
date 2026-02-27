import { Database } from "bun:sqlite";
import type {
  Task,
  AgentMessage,
  FileLock,
  TaskStatus,
  AgentStatus,
  ModelTier,
  FileEntry,
  ToolLogEntry,
  LogPhase,
  RecoveryAttempt,
  CacheEntry,
  ArchitecturalDecision,
  DecisionStatus,
  LogicalConflict,
  PortAllocation,
  CleanupEntry,
  Checkpoint,
  WorkerMessage,
  FeedbackCheckpoint,
  FeedbackAction,
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
    const values: (string | number | null)[] = [];

    for (const [key, value] of Object.entries(updates)) {
      const col = columnMap[key];
      if (col) {
        sets.push(`${col} = ?`);
        values.push(value as string | number | null);
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
    const values: (string | number | null)[] = [];

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

  // ── File Ownership ───────────────────────────────────────────────────

  declareOwnership(declaration: { agentName: string; taskId: string; owns: string[]; reads: string[] }): void {
    const stmt = this.db.prepare(
      `INSERT INTO file_ownership (pattern, agent_name, task_id, permission) VALUES (?, ?, ?, ?)`
    );
    for (const pattern of declaration.owns) {
      stmt.run(pattern, declaration.agentName, declaration.taskId, "owns");
    }
    for (const pattern of declaration.reads) {
      stmt.run(pattern, declaration.agentName, declaration.taskId, "reads");
    }
  }

  getOwnership(agentName: string): Array<{ pattern: string; permission: string }> {
    const stmt = this.db.prepare(
      `SELECT pattern, permission FROM file_ownership WHERE agent_name = ?`
    );
    return stmt.all(agentName) as Array<{ pattern: string; permission: string }>;
  }

  getOwnersOfPattern(pattern: string): Array<{ agentName: string; permission: string; taskId: string }> {
    const stmt = this.db.prepare(
      `SELECT agent_name, permission, task_id FROM file_ownership WHERE pattern = ? AND permission = 'owns'`
    );
    const rows = stmt.all(pattern) as Array<{ agent_name: string; permission: string; task_id: string }>;
    return rows.map(r => ({ agentName: r.agent_name, permission: r.permission, taskId: r.task_id }));
  }

  revokeOwnership(agentName: string, taskId?: string): void {
    if (taskId) {
      this.db.prepare(`DELETE FROM file_ownership WHERE agent_name = ? AND task_id = ?`).run(agentName, taskId);
    } else {
      this.db.prepare(`DELETE FROM file_ownership WHERE agent_name = ?`).run(agentName);
    }
  }

  getAllOwnership(): Array<{ pattern: string; agentName: string; taskId: string; permission: string }> {
    const stmt = this.db.prepare(
      `SELECT pattern, agent_name, task_id, permission FROM file_ownership`
    );
    const rows = stmt.all() as Array<{ pattern: string; agent_name: string; task_id: string; permission: string }>;
    return rows.map(r => ({ pattern: r.pattern, agentName: r.agent_name, taskId: r.task_id, permission: r.permission }));
  }

  // ── Session Snapshots ───────────────────────────────────────────────

  saveSnapshot(snapshot: {
    id: string;
    sessionName?: string;
    turnsJson: string;
    language?: string;
    summary?: string;
    turnCount: number;
  }): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO session_snapshots (id, session_name, turns_json, language, summary, turn_count)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    stmt.run(
      snapshot.id,
      snapshot.sessionName ?? "repl",
      snapshot.turnsJson,
      snapshot.language ?? null,
      snapshot.summary ?? null,
      snapshot.turnCount,
    );
  }

  getLatestSnapshot(sessionName = "repl"): {
    id: string;
    sessionName: string;
    turnsJson: string;
    language: string | null;
    summary: string | null;
    turnCount: number;
    createdAt: string;
  } | null {
    const stmt = this.db.prepare(
      `SELECT * FROM session_snapshots WHERE session_name = ? ORDER BY created_at DESC LIMIT 1`
    );
    const row = stmt.get(sessionName) as Record<string, unknown> | null;
    if (!row) return null;
    return {
      id: row.id as string,
      sessionName: row.session_name as string,
      turnsJson: row.turns_json as string,
      language: row.language as string | null,
      summary: row.summary as string | null,
      turnCount: row.turn_count as number,
      createdAt: row.created_at as string,
    };
  }

  listSnapshots(sessionName?: string, limit = 5): Array<{
    id: string;
    sessionName: string;
    summary: string | null;
    turnCount: number;
    createdAt: string;
  }> {
    const sql = sessionName
      ? `SELECT id, session_name, summary, turn_count, created_at FROM session_snapshots WHERE session_name = ? ORDER BY created_at DESC LIMIT ?`
      : `SELECT id, session_name, summary, turn_count, created_at FROM session_snapshots ORDER BY created_at DESC LIMIT ?`;
    const stmt = this.db.prepare(sql);
    const rows = (sessionName ? stmt.all(sessionName, limit) : stmt.all(limit)) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      sessionName: r.session_name as string,
      summary: r.summary as string | null,
      turnCount: r.turn_count as number,
      createdAt: r.created_at as string,
    }));
  }

  // ── Codebase Map ────────────────────────────────────────────────────

  upsertCodebaseEntry(path: string, purpose: string, agent?: string): void {
    this.db.prepare(
      `INSERT INTO codebase_map (file_path, purpose, last_agent, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(file_path) DO UPDATE SET
         purpose = excluded.purpose,
         last_agent = excluded.last_agent,
         updated_at = datetime('now')`,
    ).run(path, purpose, agent ?? null);
  }

  getCodebaseEntry(path: string): FileEntry | null {
    const row = this.db.prepare(
      `SELECT * FROM codebase_map WHERE file_path = ?`,
    ).get(path) as Record<string, unknown> | null;
    if (!row) return null;
    return {
      path: row.file_path as string,
      purpose: row.purpose as string,
      lastAgent: row.last_agent as string | undefined,
      lastUpdated: row.updated_at as string,
    };
  }

  searchCodebase(query: string, limit = 10): FileEntry[] {
    const pattern = `%${query}%`;
    const rows = this.db.prepare(
      `SELECT * FROM codebase_map WHERE file_path LIKE ? OR purpose LIKE ? ORDER BY updated_at DESC LIMIT ?`,
    ).all(pattern, pattern, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      path: r.file_path as string,
      purpose: r.purpose as string,
      lastAgent: r.last_agent as string | undefined,
      lastUpdated: r.updated_at as string,
    }));
  }

  // ── Task Log ──────────────────────────────────────────────────────

  addToolLog(entry: { taskId: string; tool: string; detail?: string; phase?: LogPhase; startedAt: string; endedAt?: string; success?: boolean; durationMs?: number }): void {
    this.db.prepare(
      `INSERT INTO task_log (task_id, tool, detail, phase, started_at, ended_at, success, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.taskId,
      entry.tool,
      entry.detail ?? null,
      entry.phase ?? "general",
      entry.startedAt,
      entry.endedAt ?? null,
      entry.success != null ? (entry.success ? 1 : 0) : null,
      entry.durationMs ?? null,
    );
  }

  getToolLogs(taskId: string): ToolLogEntry[] {
    const rows = this.db.prepare(
      `SELECT * FROM task_log WHERE task_id = ? ORDER BY started_at ASC`,
    ).all(taskId) as Record<string, unknown>[];
    return rows.map((r) => ({
      tool: r.tool as string,
      detail: r.detail as string | undefined,
      phase: r.phase as LogPhase,
      startedAt: r.started_at as string,
      endedAt: r.ended_at as string | undefined,
      success: r.success != null ? (r.success as number) === 1 : undefined,
      durationMs: r.duration_ms as number | undefined,
    }));
  }

  // ── Recovery History ──────────────────────────────────────────────

  addRecoveryAttempt(attempt: RecoveryAttempt & { actionTaken: string }): void {
    this.db.prepare(
      `INSERT INTO recovery_history (task_id, failure_type, approach, action_taken, success)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(attempt.taskId, attempt.failureType, attempt.approach, attempt.actionTaken, attempt.success ? 1 : 0);
  }

  getRecoveryHistory(taskId: string): Array<{ taskId: string; failureType: string; approach: string; actionTaken: string; success: boolean; createdAt: string }> {
    const rows = this.db.prepare(
      `SELECT * FROM recovery_history WHERE task_id = ? ORDER BY created_at DESC`,
    ).all(taskId) as Record<string, unknown>[];
    return rows.map((r) => ({
      taskId: r.task_id as string,
      failureType: r.failure_type as string,
      approach: r.approach as string,
      actionTaken: r.action_taken as string,
      success: (r.success as number) === 1,
      createdAt: r.created_at as string,
    }));
  }

  // ── Predictions ───────────────────────────────────────────────────

  savePrediction(prompt: string, risks: string, checklist: string): void {
    this.db.prepare(
      `INSERT INTO predictions (task_prompt, risks_json, checklist_json) VALUES (?, ?, ?)`,
    ).run(prompt, risks, checklist);
  }

  getRecentPredictions(limit = 10): Array<{ id: number; taskPrompt: string; risksJson: string | null; checklistJson: string | null; outcome: string | null; createdAt: string }> {
    const rows = this.db.prepare(
      `SELECT * FROM predictions ORDER BY created_at DESC LIMIT ?`,
    ).all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      taskPrompt: r.task_prompt as string,
      risksJson: r.risks_json as string | null,
      checklistJson: r.checklist_json as string | null,
      outcome: r.outcome as string | null,
      createdAt: r.created_at as string,
    }));
  }

  // ── Prompt Cache ───────────────────────────────────────────────────

  getCacheEntry(hash: string): CacheEntry | null {
    const row = this.db.prepare(`SELECT * FROM prompt_cache WHERE hash = ?`).get(hash) as Record<string, unknown> | null;
    if (!row) return null;
    this.db.prepare(`UPDATE prompt_cache SET hit_count = hit_count + 1, last_hit_at = datetime('now') WHERE hash = ?`).run(hash);
    return { hash: row.hash as string, prompt: row.prompt as string, response: row.response as string, model: row.model as string as any, tokens: row.tokens as number, hitCount: (row.hit_count as number) + 1, createdAt: row.created_at as string, lastHitAt: new Date().toISOString() };
  }

  setCacheEntry(entry: { hash: string; prompt: string; response: string; model: string; tokens: number }): void {
    this.db.prepare(`INSERT OR REPLACE INTO prompt_cache (hash, prompt, response, model, tokens) VALUES (?, ?, ?, ?, ?)`).run(entry.hash, entry.prompt, entry.response, entry.model, entry.tokens);
  }

  getCacheStats(): { totalEntries: number; totalHits: number; totalTokensSaved: number } {
    const row = this.db.prepare(`SELECT COUNT(*) as cnt, COALESCE(SUM(hit_count), 0) as hits, COALESCE(SUM(tokens * hit_count), 0) as tokens_saved FROM prompt_cache`).get() as Record<string, unknown>;
    return { totalEntries: row.cnt as number, totalHits: row.hits as number, totalTokensSaved: row.tokens_saved as number };
  }

  evictCache(maxEntries: number): number {
    const result = this.db.prepare(`DELETE FROM prompt_cache WHERE hash IN (SELECT hash FROM prompt_cache ORDER BY last_hit_at ASC LIMIT MAX(0, (SELECT COUNT(*) FROM prompt_cache) - ?))`).run(maxEntries);
    return result.changes;
  }

  // ── Decisions ─────────────────────────────────────────────────────

  addDecision(decision: ArchitecturalDecision): void {
    this.db.prepare(`INSERT INTO decisions (id, title, decision, context, decided_by, status, tags_json) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(decision.id, decision.title, decision.decision, decision.context, decision.decidedBy, decision.status, JSON.stringify(decision.tags));
  }

  getDecision(id: string): ArchitecturalDecision | null {
    const row = this.db.prepare(`SELECT * FROM decisions WHERE id = ?`).get(id) as Record<string, unknown> | null;
    if (!row) return null;
    return this.mapDecision(row);
  }

  listDecisions(status: DecisionStatus = "active"): ArchitecturalDecision[] {
    const rows = this.db.prepare(`SELECT * FROM decisions WHERE status = ? ORDER BY created_at DESC`).all(status) as Record<string, unknown>[];
    return rows.map((r) => this.mapDecision(r));
  }

  searchDecisions(query: string): ArchitecturalDecision[] {
    const pattern = `%${query}%`;
    const rows = this.db.prepare(`SELECT * FROM decisions WHERE status = 'active' AND (title LIKE ? OR decision LIKE ? OR tags_json LIKE ?) ORDER BY created_at DESC`).all(pattern, pattern, pattern) as Record<string, unknown>[];
    return rows.map((r) => this.mapDecision(r));
  }

  supersedeDecision(id: string, newId: string): void {
    this.db.prepare(`UPDATE decisions SET status = 'superseded', superseded_by = ? WHERE id = ?`).run(newId, id);
  }

  // ── Logical Conflicts ─────────────────────────────────────────────

  addConflict(conflict: LogicalConflict): void {
    this.db.prepare(`INSERT INTO logical_conflicts (id, agent_a, agent_b, description, severity, files_json, resolved) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(conflict.id, conflict.agentA, conflict.agentB, conflict.description, conflict.severity, JSON.stringify(conflict.files), conflict.resolved ? 1 : 0);
  }

  getUnresolvedConflicts(): LogicalConflict[] {
    const rows = this.db.prepare(`SELECT * FROM logical_conflicts WHERE resolved = 0 ORDER BY detected_at DESC`).all() as Record<string, unknown>[];
    return rows.map((r) => ({ id: r.id as string, agentA: r.agent_a as string, agentB: r.agent_b as string, description: r.description as string, severity: r.severity as any, files: JSON.parse(r.files_json as string), detectedAt: r.detected_at as string, resolved: false }));
  }

  resolveConflict(id: string): void {
    this.db.prepare(`UPDATE logical_conflicts SET resolved = 1 WHERE id = ?`).run(id);
  }

  // ── Port Allocations ──────────────────────────────────────────────

  allocatePort(port: number, agentName: string, taskId: string, purpose: string): boolean {
    try {
      this.db.prepare(`INSERT INTO port_allocations (port, agent_name, task_id, purpose) VALUES (?, ?, ?, ?)`).run(port, agentName, taskId, purpose);
      return true;
    } catch { return false; }
  }

  releasePort(port: number): void {
    this.db.prepare(`DELETE FROM port_allocations WHERE port = ?`).run(port);
  }

  releasePortsByAgent(agentName: string): void {
    this.db.prepare(`DELETE FROM port_allocations WHERE agent_name = ?`).run(agentName);
  }

  getAllocatedPorts(): PortAllocation[] {
    const rows = this.db.prepare(`SELECT * FROM port_allocations ORDER BY port`).all() as Record<string, unknown>[];
    return rows.map((r) => ({ port: r.port as number, agentName: r.agent_name as string, taskId: r.task_id as string, purpose: r.purpose as string, allocatedAt: r.allocated_at as string }));
  }

  isPortAllocated(port: number): boolean {
    const row = this.db.prepare(`SELECT 1 FROM port_allocations WHERE port = ?`).get(port);
    return row != null;
  }

  // ── Cleanup Queue ─────────────────────────────────────────────────

  registerCleanup(entry: CleanupEntry): void {
    this.db.prepare(`INSERT OR REPLACE INTO cleanup_queue (id, type, target, agent_name) VALUES (?, ?, ?, ?)`).run(entry.id, entry.type, entry.target, entry.agentName);
  }

  getCleanupQueue(agentName?: string): CleanupEntry[] {
    const sql = agentName ? `SELECT * FROM cleanup_queue WHERE agent_name = ?` : `SELECT * FROM cleanup_queue`;
    const rows = (agentName ? this.db.prepare(sql).all(agentName) : this.db.prepare(sql).all()) as Record<string, unknown>[];
    return rows.map((r) => ({ id: r.id as string, type: r.type as any, target: r.target as string, agentName: r.agent_name as string, registeredAt: r.registered_at as string }));
  }

  removeCleanup(id: string): void {
    this.db.prepare(`DELETE FROM cleanup_queue WHERE id = ?`).run(id);
  }

  clearCleanupByAgent(agentName: string): void {
    this.db.prepare(`DELETE FROM cleanup_queue WHERE agent_name = ?`).run(agentName);
  }

  // ── Checkpoints ───────────────────────────────────────────────────

  saveCheckpoint(cp: Checkpoint): void {
    this.db.prepare(`INSERT INTO checkpoints (id, task_id, agent_name, sha, label, metadata_json) VALUES (?, ?, ?, ?, ?, ?)`).run(cp.id, cp.taskId, cp.agentName, cp.sha, cp.label, JSON.stringify(cp.metadata));
  }

  getCheckpoints(taskId: string): Checkpoint[] {
    const rows = this.db.prepare(`SELECT * FROM checkpoints WHERE task_id = ? ORDER BY created_at DESC`).all(taskId) as Record<string, unknown>[];
    return rows.map((r) => ({ id: r.id as string, taskId: r.task_id as string, agentName: r.agent_name as string, sha: r.sha as string, label: r.label as string, metadata: JSON.parse(r.metadata_json as string), createdAt: r.created_at as string }));
  }

  getLatestCheckpoint(taskId: string): Checkpoint | null {
    const row = this.db.prepare(`SELECT * FROM checkpoints WHERE task_id = ? ORDER BY created_at DESC LIMIT 1`).get(taskId) as Record<string, unknown> | null;
    if (!row) return null;
    return { id: row.id as string, taskId: row.task_id as string, agentName: row.agent_name as string, sha: row.sha as string, label: row.label as string, metadata: JSON.parse(row.metadata_json as string), createdAt: row.created_at as string };
  }

  // ── Worker Messages ──────────────────────────────────────────

  addWorkerMessage(msg: {
    id: string;
    from: string;
    to: string;
    type: string;
    content: string;
    metadata?: Record<string, unknown>;
    taskRef: string;
    subtaskRef: string;
  }): void {
    this.db.prepare(
      `INSERT INTO worker_messages (id, from_agent, to_agent, message_type, content, metadata_json, task_ref, subtask_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      msg.id,
      msg.from,
      msg.to,
      msg.type,
      msg.content,
      JSON.stringify(msg.metadata ?? {}),
      msg.taskRef,
      msg.subtaskRef,
    );
  }

  getWorkerMessages(taskRef: string, toAgent?: string): WorkerMessage[] {
    const sql = toAgent
      ? `SELECT * FROM worker_messages WHERE task_ref = ? AND (to_agent = ? OR to_agent = 'all') ORDER BY timestamp ASC`
      : `SELECT * FROM worker_messages WHERE task_ref = ? ORDER BY timestamp ASC`;
    const rows = (toAgent
      ? this.db.prepare(sql).all(taskRef, toAgent)
      : this.db.prepare(sql).all(taskRef)
    ) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      from: r.from_agent as string,
      to: r.to_agent as string,
      type: r.message_type as WorkerMessage["type"],
      content: r.content as string,
      metadata: JSON.parse(r.metadata_json as string),
      taskRef: r.task_ref as string,
      subtaskRef: r.subtask_ref as string,
      timestamp: r.timestamp as string,
    }));
  }

  // ── Feedback Checkpoints ─────────────────────────────────────

  saveFeedbackCheckpoint(cp: {
    id: string;
    workerId: string;
    subtaskId: string;
    turn: number;
    capturedOutput: string;
    filesModified: string[];
    assessment: string;
    correction: string | null;
  }): void {
    this.db.prepare(
      `INSERT INTO feedback_checkpoints (id, worker_id, subtask_id, turn, captured_output, files_json, assessment, correction)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      cp.id,
      cp.workerId,
      cp.subtaskId,
      cp.turn,
      cp.capturedOutput,
      JSON.stringify(cp.filesModified),
      cp.assessment,
      cp.correction,
    );
  }

  getFeedbackCheckpoints(workerId: string): FeedbackCheckpoint[] {
    const rows = this.db.prepare(
      `SELECT * FROM feedback_checkpoints WHERE worker_id = ? ORDER BY created_at ASC`
    ).all(workerId) as Record<string, unknown>[];
    return rows.map((r) => ({
      workerId: r.worker_id as string,
      subtaskId: r.subtask_id as string,
      turn: r.turn as number,
      capturedOutput: r.captured_output as string,
      filesModified: JSON.parse(r.files_json as string),
      assessment: r.assessment as FeedbackAction,
      correctionSent: r.correction as string | null,
      timestamp: r.created_at as string,
    }));
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

  private mapDecision(row: Record<string, unknown>): ArchitecturalDecision {
    return {
      id: row.id as string,
      title: row.title as string,
      decision: row.decision as string,
      context: row.context as string,
      decidedBy: row.decided_by as string,
      status: row.status as DecisionStatus,
      tags: JSON.parse(row.tags_json as string),
      createdAt: row.created_at as string,
      supersededBy: row.superseded_by as string | undefined,
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
