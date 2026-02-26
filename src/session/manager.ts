import type { AgentProfile, SessionInfo, AgentStatus } from "../config/types.ts";
import * as terminal from "./terminal.ts";

export class SessionManager {
  private prefix: string;
  private sessions: Map<string, SessionInfo>;

  constructor(prefix: string = "orc-") {
    this.prefix = prefix;
    this.sessions = new Map();
  }

  getSessionName(agentName: string): string {
    return this.prefix + agentName;
  }

  async spawnSession(profile: AgentProfile, command: string): Promise<SessionInfo> {
    const sessionName = this.getSessionName(profile.name);

    await terminal.createSession(sessionName);
    await terminal.sendKeys(sessionName, command);

    const info: SessionInfo = {
      name: sessionName,
      agentName: profile.name,
      pid: null,
      createdAt: new Date().toISOString(),
      status: "running",
    };

    this.sessions.set(profile.name, info);
    return info;
  }

  async destroySession(agentName: string): Promise<void> {
    const sessionName = this.getSessionName(agentName);

    if (await terminal.hasSession(sessionName)) {
      await terminal.killSession(sessionName);
    }

    this.sessions.delete(agentName);
  }

  async isAlive(agentName: string): Promise<boolean> {
    const sessionName = this.getSessionName(agentName);
    return terminal.hasSession(sessionName);
  }

  async captureOutput(agentName: string, lines?: number): Promise<string> {
    const sessionName = this.getSessionName(agentName);
    return terminal.capturePane(sessionName, lines);
  }

  async sendInput(agentName: string, input: string): Promise<void> {
    const sessionName = this.getSessionName(agentName);
    await terminal.sendKeys(sessionName, input);
  }

  getSession(agentName: string): SessionInfo | undefined {
    return this.sessions.get(agentName);
  }

  listActiveSessions(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }

  async destroyAll(): Promise<void> {
    const agents = Array.from(this.sessions.keys());
    await Promise.all(agents.map((name) => this.destroySession(name)));
  }
}
