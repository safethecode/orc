import type { CleanupEntry } from "../config/types.ts";
import type { Store } from "../db/store.ts";
import { eventBus } from "./events.ts";

type CleanupHandler = (entry: CleanupEntry) => Promise<void>;

export class CrashRecovery {
  private handlers: Map<string, CleanupHandler> = new Map();
  private signalsBound = false;

  constructor(private store: Store) {}

  registerHandler(type: string, handler: CleanupHandler): void {
    this.handlers.set(type, handler);
  }

  registerCleanup(entry: Omit<CleanupEntry, "registeredAt">): void {
    this.store.registerCleanup({
      ...entry,
      registeredAt: new Date().toISOString(),
    });
  }

  removeCleanup(id: string): void {
    this.store.removeCleanup(id);
  }

  async runCleanup(agentName?: string): Promise<{ succeeded: number; failed: number }> {
    const entries = this.store.getCleanupQueue(agentName);
    let succeeded = 0;
    let failed = 0;

    for (const entry of entries) {
      const handler = this.handlers.get(entry.type);
      if (!handler) {
        // No handler for this type — remove it anyway
        this.store.removeCleanup(entry.id);
        failed++;
        continue;
      }

      try {
        await handler(entry);
        this.store.removeCleanup(entry.id);
        succeeded++;
      } catch (err) {
        failed++;
        eventBus.publish({
          type: "agent:error",
          agent: entry.agentName,
          message: `Cleanup failed for ${entry.type}:${entry.target}: ${err}`,
        });
      }
    }

    return { succeeded, failed };
  }

  async recoverFromCrash(): Promise<{ cleaned: number; errors: string[] }> {
    const errors: string[] = [];
    let cleaned = 0;

    // 1. Clean up stale file locks
    try {
      const agents = this.store.listAgents();
      for (const agent of agents) {
        if (agent.status === "terminated" || agent.status === "error") {
          this.store.unlockByAgent(agent.name);
          cleaned++;
        }
      }
    } catch (e) {
      errors.push(`Lock cleanup: ${e}`);
    }

    // 2. Run registered cleanup handlers
    try {
      const result = await this.runCleanup();
      cleaned += result.succeeded;
      if (result.failed > 0) {
        errors.push(`${result.failed} cleanup handlers failed`);
      }
    } catch (e) {
      errors.push(`Cleanup queue: ${e}`);
    }

    // 3. Clean stale port allocations
    try {
      const ports = this.store.getAllocatedPorts();
      const staleAgents = new Set(
        this.store.listAgents()
          .filter((a) => a.status === "terminated" || a.status === "error")
          .map((a) => a.name),
      );
      for (const port of ports) {
        if (staleAgents.has(port.agentName)) {
          this.store.releasePort(port.port);
          cleaned++;
        }
      }
    } catch (e) {
      errors.push(`Port cleanup: ${e}`);
    }

    // 4. Reset running tasks from dead agents to 'failed'
    try {
      const running = this.store.listTasks({ status: "running" });
      const aliveAgents = new Set(
        this.store.listAgents()
          .filter((a) => a.status === "running" || a.status === "idle")
          .map((a) => a.name),
      );
      for (const task of running) {
        if (task.agentName && !aliveAgents.has(task.agentName)) {
          this.store.updateTask(task.id, {
            status: "failed",
            result: "Agent crashed or terminated unexpectedly",
            completedAt: new Date().toISOString(),
          });
          cleaned++;
        }
      }
    } catch (e) {
      errors.push(`Task cleanup: ${e}`);
    }

    return { cleaned, errors };
  }

  bindSignalHandlers(shutdownFn: () => Promise<void>): void {
    if (this.signalsBound) return;
    this.signalsBound = true;

    const handler = async (signal: string) => {
      eventBus.publish({
        type: "agent:error",
        agent: "orchestrator",
        message: `Received ${signal}, running cleanup...`,
      });

      try {
        await this.runCleanup();
        await shutdownFn();
      } catch {
        // Best effort
      }

      process.exit(signal === "SIGTERM" ? 0 : 1);
    };

    process.on("SIGINT", () => handler("SIGINT"));
    process.on("SIGTERM", () => handler("SIGTERM"));
    process.on("uncaughtException", async (err) => {
      eventBus.publish({
        type: "agent:error",
        agent: "orchestrator",
        message: `Uncaught exception: ${err.message}`,
      });
      try { await this.runCleanup(); } catch {}
    });
  }

  getPendingCount(agentName?: string): number {
    return this.store.getCleanupQueue(agentName).length;
  }
}
