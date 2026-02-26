import type { HealthStatus } from "../config/types.ts";
import { hasSession } from "../session/terminal.ts";

export class HealthChecker {
  private statuses: Map<string, HealthStatus> = new Map();
  private interval: ReturnType<typeof setInterval> | null = null;
  private sessionPrefix: string;
  private onUnhealthy?: (status: HealthStatus) => void;

  constructor(sessionPrefix: string, onUnhealthy?: (status: HealthStatus) => void) {
    this.sessionPrefix = sessionPrefix;
    this.onUnhealthy = onUnhealthy;
  }

  registerAgent(agentName: string): void {
    this.statuses.set(agentName, {
      agentName,
      sessionAlive: false,
      lastHeartbeat: null,
      consecutiveFailures: 0,
    });
  }

  unregisterAgent(agentName: string): void {
    this.statuses.delete(agentName);
  }

  async checkAgent(agentName: string): Promise<HealthStatus> {
    const sessionName = `${this.sessionPrefix}-${agentName}`;
    const alive = await hasSession(sessionName);
    const now = new Date().toISOString();

    let status = this.statuses.get(agentName);
    if (!status) {
      status = {
        agentName,
        sessionAlive: false,
        lastHeartbeat: null,
        consecutiveFailures: 0,
      };
      this.statuses.set(agentName, status);
    }

    status.sessionAlive = alive;

    if (alive) {
      status.lastHeartbeat = now;
      status.consecutiveFailures = 0;
    } else {
      status.consecutiveFailures += 1;
      if (status.consecutiveFailures >= 3 && this.onUnhealthy) {
        this.onUnhealthy(status);
      }
    }

    return status;
  }

  async checkAll(): Promise<Map<string, HealthStatus>> {
    const agents = Array.from(this.statuses.keys());
    await Promise.all(agents.map((name) => this.checkAgent(name)));
    return this.statuses;
  }

  start(intervalMs: number = 5000): void {
    this.stop();
    this.interval = setInterval(() => {
      this.checkAll();
    }, intervalMs);
  }

  stop(): void {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  getStatus(agentName: string): HealthStatus | undefined {
    return this.statuses.get(agentName);
  }

  getAllStatuses(): HealthStatus[] {
    return Array.from(this.statuses.values());
  }
}
