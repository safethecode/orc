import { readdirSync } from "node:fs";
import { join } from "node:path";

export interface SessionSummary {
  id: string;
  turnCount: number;
  createdAt: string;
  lastActiveAt: string;
  summary?: string;
  costUsd?: number;
}

export interface SessionMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  agentName?: string;
}

export interface SessionData {
  id: string;
  messages: SessionMessage[];
  metadata: Record<string, unknown>;
}

export interface SearchHit {
  sessionId: string;
  messageIndex: number;
  role: string;
  content: string; // truncated to 200 chars
  score: number;   // simple keyword match score
  timestamp: string;
}

export class SessionToolkit {
  private sessionsDir: string;

  constructor(sessionsDir?: string) {
    this.sessionsDir = sessionsDir ?? `${process.env.HOME}/.orchestrator/sessions`;
  }

  async listSessions(limit?: number): Promise<SessionSummary[]> {
    let entries: string[];
    try {
      entries = readdirSync(this.sessionsDir);
    } catch {
      return [];
    }

    const summaries: SessionSummary[] = [];

    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;

      const sessionId = entry.replace(/\.json$/, "");
      const filePath = join(this.sessionsDir, entry);

      try {
        const file = Bun.file(filePath);
        const exists = await file.exists();
        if (!exists) continue;

        const raw = await file.json() as Record<string, unknown>;
        const messages = (raw.messages ?? []) as SessionMessage[];
        const metadata = (raw.metadata ?? {}) as Record<string, unknown>;

        const firstTimestamp = messages.length > 0
          ? messages[0].timestamp
          : (metadata.createdAt as string) ?? new Date().toISOString();
        const lastTimestamp = messages.length > 0
          ? messages[messages.length - 1].timestamp
          : firstTimestamp;

        summaries.push({
          id: sessionId,
          turnCount: messages.length,
          createdAt: firstTimestamp,
          lastActiveAt: lastTimestamp,
          summary: (metadata.summary as string) ?? undefined,
          costUsd: typeof metadata.costUsd === "number" ? metadata.costUsd : undefined,
        });
      } catch {
        // Skip corrupt/unreadable session files
      }
    }

    // Sort by lastActiveAt descending (most recent first)
    summaries.sort((a, b) => {
      return new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime();
    });

    return limit ? summaries.slice(0, limit) : summaries;
  }

  async readSession(sessionId: string): Promise<SessionData | null> {
    const filePath = join(this.sessionsDir, `${sessionId}.json`);

    try {
      const file = Bun.file(filePath);
      const exists = await file.exists();
      if (!exists) return null;

      const raw = await file.json() as Record<string, unknown>;

      return {
        id: sessionId,
        messages: (raw.messages ?? []) as SessionMessage[],
        metadata: (raw.metadata ?? {}) as Record<string, unknown>,
      };
    } catch {
      return null;
    }
  }

  async searchSessions(query: string, limit?: number): Promise<SearchHit[]> {
    const maxResults = limit ?? 20;
    const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (keywords.length === 0) return [];

    let entries: string[];
    try {
      entries = readdirSync(this.sessionsDir);
    } catch {
      return [];
    }

    const hits: SearchHit[] = [];

    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;

      const sessionId = entry.replace(/\.json$/, "");
      const filePath = join(this.sessionsDir, entry);

      try {
        const file = Bun.file(filePath);
        const exists = await file.exists();
        if (!exists) continue;

        const raw = await file.json() as Record<string, unknown>;
        const messages = (raw.messages ?? []) as SessionMessage[];

        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i];
          const contentLower = msg.content.toLowerCase();

          // Score by keyword frequency
          let score = 0;
          for (const keyword of keywords) {
            let searchFrom = 0;
            while (true) {
              const idx = contentLower.indexOf(keyword, searchFrom);
              if (idx === -1) break;
              score++;
              searchFrom = idx + keyword.length;
            }
          }

          if (score > 0) {
            hits.push({
              sessionId,
              messageIndex: i,
              role: msg.role,
              content: msg.content.length > 200 ? msg.content.slice(0, 200) : msg.content,
              score,
              timestamp: msg.timestamp,
            });
          }
        }
      } catch {
        // Skip corrupt session files
      }
    }

    // Sort by score descending
    hits.sort((a, b) => b.score - a.score);

    return hits.slice(0, maxResults);
  }

  async getLatestSession(): Promise<SessionSummary | null> {
    const sessions = await this.listSessions(1);
    return sessions.length > 0 ? sessions[0] : null;
  }

  formatSessionList(sessions: SessionSummary[]): string {
    if (sessions.length === 0) return "No sessions found.";

    const lines = sessions.map((s) => {
      const cost = s.costUsd != null ? ` | $${s.costUsd.toFixed(4)}` : "";
      const summary = s.summary ? ` — ${s.summary}` : "";
      return `  ${s.id}  ${s.turnCount} turns  ${s.lastActiveAt}${cost}${summary}`;
    });

    return `Sessions (${sessions.length}):\n${lines.join("\n")}`;
  }

  formatSearchResults(hits: SearchHit[]): string {
    if (hits.length === 0) return "No matches found.";

    const lines = hits.map((h) => {
      const preview = h.content.replace(/\n/g, " ").slice(0, 120);
      return `  [${h.sessionId}#${h.messageIndex}] (${h.role}, score:${h.score}) ${preview}`;
    });

    return `Search results (${hits.length}):\n${lines.join("\n")}`;
  }
}
