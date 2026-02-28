// ── Boulder: Persistent Work State ────────────────────────────────────
// Named after Sisyphus's boulder — work-in-progress state that persists across sessions

import { mkdir, readdir, unlink, stat } from "node:fs/promises";

export interface BoulderState {
  id: string;
  task: string;
  planId?: string;
  status: "in_progress" | "paused" | "blocked" | "completed";
  currentStepIndex: number;
  totalSteps: number;
  completedSteps: string[];
  failedSteps: string[];
  context: Record<string, unknown>;
  startedAt: string;
  lastUpdatedAt: string;
  resumeHint: string;
}

function generateId(): string {
  return `boulder-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export class BoulderManager {
  private boulderDir: string;

  constructor(projectDir: string) {
    this.boulderDir = `${projectDir}/.orchestrator/boulder`;
  }

  /** Save boulder state to disk */
  async save(state: BoulderState): Promise<void> {
    await mkdir(this.boulderDir, { recursive: true });
    const filePath = `${this.boulderDir}/${state.id}.json`;
    await Bun.write(filePath, JSON.stringify(state, null, 2));
  }

  /** Load the latest active boulder (most recently updated in_progress/paused) */
  async loadLatest(): Promise<BoulderState | null> {
    const all = await this.list();
    const active = all
      .filter((s) => s.status === "in_progress" || s.status === "paused")
      .sort((a, b) => new Date(b.lastUpdatedAt).getTime() - new Date(a.lastUpdatedAt).getTime());
    return active[0] ?? null;
  }

  /** Load a specific boulder by ID */
  async load(id: string): Promise<BoulderState | null> {
    const filePath = `${this.boulderDir}/${id}.json`;
    const file = Bun.file(filePath);
    if (!(await file.exists())) return null;

    try {
      const content = await file.json();
      return content as BoulderState;
    } catch {
      return null;
    }
  }

  /** List all boulders */
  async list(): Promise<BoulderState[]> {
    try {
      const entries = await readdir(this.boulderDir);
      const boulders: BoulderState[] = [];

      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const filePath = `${this.boulderDir}/${entry}`;
        try {
          const file = Bun.file(filePath);
          const content = await file.json();
          boulders.push(content as BoulderState);
        } catch {
          // Skip corrupted files
        }
      }

      return boulders.sort(
        (a, b) => new Date(b.lastUpdatedAt).getTime() - new Date(a.lastUpdatedAt).getTime(),
      );
    } catch {
      // Directory doesn't exist yet
      return [];
    }
  }

  /** Create a new boulder from a task */
  create(task: string, totalSteps: number): BoulderState {
    const now = new Date().toISOString();
    return {
      id: generateId(),
      task,
      status: "in_progress",
      currentStepIndex: 0,
      totalSteps,
      completedSteps: [],
      failedSteps: [],
      context: {},
      startedAt: now,
      lastUpdatedAt: now,
      resumeHint: `Starting work on: ${task}`,
    };
  }

  /** Mark a step as completed and advance progress */
  async markStepCompleted(id: string, stepId: string): Promise<void> {
    const state = await this.load(id);
    if (!state) return;

    if (!state.completedSteps.includes(stepId)) {
      state.completedSteps.push(stepId);
    }

    // Remove from failed if it was retried successfully
    state.failedSteps = state.failedSteps.filter((s) => s !== stepId);

    // Advance current step index
    state.currentStepIndex = state.completedSteps.length;
    state.lastUpdatedAt = new Date().toISOString();
    state.resumeHint = state.currentStepIndex >= state.totalSteps
      ? "All steps completed"
      : `Completed step ${stepId}, moving to step ${state.currentStepIndex + 1} of ${state.totalSteps}`;

    await this.save(state);
  }

  /** Mark a step as failed */
  async markStepFailed(id: string, stepId: string): Promise<void> {
    const state = await this.load(id);
    if (!state) return;

    if (!state.failedSteps.includes(stepId)) {
      state.failedSteps.push(stepId);
    }

    state.status = "blocked";
    state.lastUpdatedAt = new Date().toISOString();
    state.resumeHint = `Blocked at step ${stepId} (${state.completedSteps.length}/${state.totalSteps} completed). Retry or skip this step.`;

    await this.save(state);
  }

  /** Pause the boulder with a resume hint */
  async pause(id: string, resumeHint: string): Promise<void> {
    const state = await this.load(id);
    if (!state) return;

    state.status = "paused";
    state.resumeHint = resumeHint;
    state.lastUpdatedAt = new Date().toISOString();

    await this.save(state);
  }

  /** Complete the boulder */
  async complete(id: string): Promise<void> {
    const state = await this.load(id);
    if (!state) return;

    state.status = "completed";
    state.lastUpdatedAt = new Date().toISOString();
    state.resumeHint = "Task completed successfully";

    await this.save(state);
  }

  /** Get formatted resume context for injecting into agent prompt */
  formatResumeContext(state: BoulderState): string {
    const completedCount = state.completedSteps.length;
    const percent = state.totalSteps > 0
      ? Math.round((completedCount / state.totalSteps) * 100)
      : 0;

    const lines: string[] = [
      "[Resuming Work]",
      `Task: ${state.task}`,
      `Progress: ${completedCount}/${state.totalSteps} steps (${percent}%)`,
      `Status: ${state.status}`,
      `Last updated: ${state.lastUpdatedAt}`,
      `Resume hint: ${state.resumeHint}`,
    ];

    if (state.completedSteps.length > 0) {
      lines.push(`Completed: ${state.completedSteps.join(", ")}`);
    }

    if (state.failedSteps.length > 0) {
      lines.push(`Failed: ${state.failedSteps.join(", ")}`);
    }

    // Determine next step
    const nextIndex = state.currentStepIndex;
    if (nextIndex < state.totalSteps) {
      lines.push(`Next: step ${nextIndex + 1} of ${state.totalSteps}`);
    }

    if (state.planId) {
      lines.push(`Plan: ${state.planId}`);
    }

    return lines.join("\n");
  }

  /** Clean up completed boulders older than N days (default: 30) */
  async cleanup(maxAgeDays?: number): Promise<number> {
    const days = maxAgeDays ?? 30;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    let removed = 0;

    try {
      const entries = await readdir(this.boulderDir);

      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const filePath = `${this.boulderDir}/${entry}`;

        try {
          const file = Bun.file(filePath);
          const state = (await file.json()) as BoulderState;

          if (state.status === "completed") {
            const updatedAt = new Date(state.lastUpdatedAt).getTime();
            if (updatedAt < cutoff) {
              await unlink(filePath);
              removed++;
            }
          }
        } catch {
          // Skip corrupted files
        }
      }
    } catch {
      // Directory doesn't exist
    }

    return removed;
  }
}
