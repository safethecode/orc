import { mkdirSync, appendFileSync } from "fs";
import type { LogEntry, LogEvent } from "../config/types.ts";

export class Logger {
  private logDir: string;

  constructor(logDir: string) {
    this.logDir = logDir;
    mkdirSync(logDir, { recursive: true });
  }

  private getLogFile(): string {
    const date = new Date().toISOString().slice(0, 10);
    return `${this.logDir}/${date}.jsonl`;
  }

  log(entry: LogEntry): void {
    appendFileSync(this.getLogFile(), JSON.stringify(entry) + "\n");
  }

  info(agent: string, task: string, message: string): void {
    this.log({
      ts: new Date().toISOString(),
      agent,
      task,
      event: "output",
      data: { message },
    });
  }

  error(agent: string, task: string, err: Error | string): void {
    const isError = err instanceof Error;
    this.log({
      ts: new Date().toISOString(),
      agent,
      task,
      event: "error",
      data: {
        error: isError ? err.message : err,
        ...(isError && err.stack ? { stack: err.stack } : {}),
      },
    });
  }

  taskStart(agent: string, taskId: string): void {
    this.log({
      ts: new Date().toISOString(),
      agent,
      task: taskId,
      event: "start",
    });
  }

  taskComplete(agent: string, taskId: string, tokens: number, cost: number): void {
    this.log({
      ts: new Date().toISOString(),
      agent,
      task: taskId,
      event: "complete",
      tokens,
      cost,
    });
  }

  budgetWarning(agent: string, taskId: string, usage: number, limit: number): void {
    this.log({
      ts: new Date().toISOString(),
      agent,
      task: taskId,
      event: "budget_warning",
      data: { usage, limit },
    });
  }
}
