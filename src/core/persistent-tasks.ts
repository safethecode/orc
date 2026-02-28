// ── Persistent Task System ────────────────────────────────────────────
// File-based task management with dependency tracking.
// Each task is stored as a separate JSON file under ~/.orchestrator/tasks/{sessionId}/

import { join } from "node:path";
import { mkdir, readdir, unlink } from "node:fs/promises";

export interface PersistentTask {
  id: string;
  subject: string;
  description?: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  owner?: string;
  blockedBy: string[];  // task IDs
  blocks: string[];     // task IDs
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

function generateId(): string {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export class PersistentTaskManager {
  private tasks: Map<string, PersistentTask> = new Map();
  private storeDir: string;

  constructor(sessionId?: string) {
    const base = join(process.env.HOME ?? "", ".orchestrator", "tasks");
    this.storeDir = sessionId ? join(base, sessionId) : base;
  }

  /** Create a new task */
  create(subject: string, description?: string): PersistentTask {
    const now = new Date().toISOString();
    const task: PersistentTask = {
      id: generateId(),
      subject,
      status: "pending",
      blockedBy: [],
      blocks: [],
      createdAt: now,
      updatedAt: now,
    };

    if (description) task.description = description;

    this.tasks.set(task.id, task);
    return task;
  }

  /** Update a task */
  update(
    taskId: string,
    updates: Partial<Pick<PersistentTask, "subject" | "description" | "status" | "owner">>,
  ): PersistentTask | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    if (updates.subject !== undefined) task.subject = updates.subject;
    if (updates.description !== undefined) task.description = updates.description;
    if (updates.status !== undefined) task.status = updates.status;
    if (updates.owner !== undefined) task.owner = updates.owner;

    task.updatedAt = new Date().toISOString();

    if (updates.status === "completed") {
      task.completedAt = task.updatedAt;
    }

    return task;
  }

  /** Add dependency: taskId is blocked by blockerId */
  addDependency(taskId: string, blockerId: string): boolean {
    const task = this.tasks.get(taskId);
    const blocker = this.tasks.get(blockerId);
    if (!task || !blocker) return false;
    if (taskId === blockerId) return false;

    // Prevent duplicates
    if (!task.blockedBy.includes(blockerId)) {
      task.blockedBy.push(blockerId);
      task.updatedAt = new Date().toISOString();
    }

    if (!blocker.blocks.includes(taskId)) {
      blocker.blocks.push(taskId);
      blocker.updatedAt = new Date().toISOString();
    }

    return true;
  }

  /**
   * Complete a task and auto-unblock dependents.
   * Returns list of newly unblocked task IDs.
   */
  complete(taskId: string): string[] {
    const task = this.tasks.get(taskId);
    if (!task) return [];

    const now = new Date().toISOString();
    task.status = "completed";
    task.completedAt = now;
    task.updatedAt = now;

    const newlyUnblocked: string[] = [];

    // Remove this task from blockedBy of all dependents
    for (const dependentId of task.blocks) {
      const dependent = this.tasks.get(dependentId);
      if (!dependent) continue;

      dependent.blockedBy = dependent.blockedBy.filter((id) => id !== taskId);
      dependent.updatedAt = now;

      // If dependent has no remaining blockers and is still pending, it's newly unblocked
      if (dependent.blockedBy.length === 0 && dependent.status === "pending") {
        newlyUnblocked.push(dependent.id);
      }
    }

    return newlyUnblocked;
  }

  /** List tasks (optionally filter by status) */
  list(status?: PersistentTask["status"]): PersistentTask[] {
    const all = Array.from(this.tasks.values());
    if (!status) return all;
    return all.filter((t) => t.status === status);
  }

  /** Get a task by ID */
  get(taskId: string): PersistentTask | null {
    return this.tasks.get(taskId) ?? null;
  }

  /** Delete a task */
  delete(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    // Remove this task from all dependency references
    for (const blockerId of task.blockedBy) {
      const blocker = this.tasks.get(blockerId);
      if (blocker) {
        blocker.blocks = blocker.blocks.filter((id) => id !== taskId);
      }
    }

    for (const dependentId of task.blocks) {
      const dependent = this.tasks.get(dependentId);
      if (dependent) {
        dependent.blockedBy = dependent.blockedBy.filter((id) => id !== taskId);
      }
    }

    this.tasks.delete(taskId);
    return true;
  }

  /** Get unblocked tasks (pending + no blockers with non-completed status) */
  getUnblocked(): PersistentTask[] {
    return Array.from(this.tasks.values()).filter((task) => {
      if (task.status !== "pending") return false;
      if (task.blockedBy.length === 0) return true;

      // Check if all blockers are completed
      return task.blockedBy.every((blockerId) => {
        const blocker = this.tasks.get(blockerId);
        return blocker?.status === "completed";
      });
    });
  }

  /** Load from disk */
  async load(): Promise<void> {
    this.tasks.clear();

    let entries: string[];
    try {
      entries = await readdir(this.storeDir);
    } catch {
      // Directory doesn't exist yet
      return;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;

      const filePath = join(this.storeDir, entry);
      try {
        const file = Bun.file(filePath);
        const task = (await file.json()) as PersistentTask;
        if (task.id) {
          this.tasks.set(task.id, task);
        }
      } catch {
        // Skip corrupted files
      }
    }
  }

  /** Save to disk */
  async save(): Promise<void> {
    await mkdir(this.storeDir, { recursive: true });

    // Write each task as {id}.json
    const writePromises: Promise<number>[] = [];
    for (const task of this.tasks.values()) {
      const filePath = join(this.storeDir, `${task.id}.json`);
      writePromises.push(Bun.write(filePath, JSON.stringify(task, null, 2)));
    }
    await Promise.all(writePromises);

    // Clean up files for tasks that no longer exist in memory
    try {
      const entries = await readdir(this.storeDir);
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const taskId = entry.replace(".json", "");
        if (!this.tasks.has(taskId)) {
          await unlink(join(this.storeDir, entry));
        }
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  /** Format task list for display */
  formatList(tasks?: PersistentTask[]): string {
    const items = tasks ?? Array.from(this.tasks.values());

    if (items.length === 0) return "No tasks.";

    const statusIcon: Record<PersistentTask["status"], string> = {
      pending: "[ ]",
      in_progress: "[~]",
      completed: "[x]",
      failed: "[!]",
    };

    const lines: string[] = [];

    // Sort: pending first, then in_progress, then completed, then failed
    const order: PersistentTask["status"][] = ["in_progress", "pending", "completed", "failed"];
    const sorted = [...items].sort(
      (a, b) => order.indexOf(a.status) - order.indexOf(b.status),
    );

    for (const task of sorted) {
      let line = `${statusIcon[task.status]} ${task.id}  ${task.subject}`;

      if (task.owner) line += `  (owner: ${task.owner})`;

      if (task.blockedBy.length > 0) {
        const unresolvedBlockers = task.blockedBy.filter((id) => {
          const blocker = this.tasks.get(id);
          return blocker && blocker.status !== "completed";
        });
        if (unresolvedBlockers.length > 0) {
          line += `  blocked-by: ${unresolvedBlockers.join(", ")}`;
        }
      }

      lines.push(line);

      if (task.description) {
        lines.push(`     ${task.description}`);
      }
    }

    return lines.join("\n");
  }
}
