import { EventEmitter } from "events";
import { Database } from "bun:sqlite";
import type { AgentMessage } from "../config/types.ts";
import { Store } from "../db/store.ts";

export class Inbox extends EventEmitter {
  private db: Database;

  constructor(
    private store: Store,
    db: Database,
  ) {
    super();
    this.db = db;
  }

  send(
    from: string,
    to: string,
    content: string,
    taskRef?: string,
  ): AgentMessage {
    const id = crypto.randomUUID();
    this.store.addMessage({ id, from, to, content, taskRef });

    const message: AgentMessage = {
      id,
      from,
      to,
      content,
      taskRef: taskRef ?? null,
      timestamp: new Date().toISOString(),
      read: false,
    };

    this.emit("message", { to, message });
    return message;
  }

  receive(agentName: string): AgentMessage[] {
    return this.store.getUnreadMessages(agentName);
  }

  markRead(messageId: string): void {
    this.store.markMessageRead(messageId);
  }

  getHistory(agentName: string, limit?: number): AgentMessage[] {
    let sql = `SELECT * FROM messages WHERE from_agent = ? OR to_agent = ? ORDER BY timestamp DESC`;
    const params: (string | number)[] = [agentName, agentName];

    if (limit !== undefined) {
      sql += ` LIMIT ?`;
      params.push(limit);
    }

    const rows = this.db.prepare(sql).all(...params) as Record<
      string,
      unknown
    >[];

    return rows.map((row) => ({
      id: row.id as string,
      from: row.from_agent as string,
      to: row.to_agent as string,
      content: row.content as string,
      taskRef: (row.task_ref as string) ?? null,
      timestamp: row.timestamp as string,
      read: (row.read as number) === 1,
    }));
  }
}
