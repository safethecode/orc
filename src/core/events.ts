import { EventEmitter } from "node:events";

export type OrcEvent =
  | { type: "agent:start"; agent: string; tier: string; reason: string }
  | { type: "agent:text"; agent: string; text: string }
  | { type: "agent:tool"; agent: string; tool: string; detail?: string }
  | { type: "agent:done"; agent: string; cost: number; inputTokens: number; outputTokens: number; durationMs: number }
  | { type: "agent:error"; agent: string; message: string }
  | { type: "session:save"; turnCount: number }
  | { type: "session:restore"; turnCount: number }
  | { type: "memory:inject"; count: number }
  | { type: "model:switch"; from: string; to: string }
  | { type: "context:compact"; before: number; after: number }
  | { type: "command:safety"; command: string; level: string }
  | { type: "critique:run"; taskId: string; passed: boolean }
  | { type: "spec:phase"; phase: string; status: "start" | "complete" }
  | { type: "qa:iteration"; iteration: number; issues: number }
  | { type: "qa:escalate"; taskId: string; reason: string }
  | { type: "recovery:attempt"; taskId: string; action: string }
  | { type: "merge:progress"; stage: string; status: string }
  | { type: "account:switch"; from: string; to: string }
  | { type: "prediction:generated"; taskId: string; riskCount: number }
  | { type: "codebase:update"; path: string }
  | { type: "insight:extracted"; count: number }
  | { type: "cache:hit"; hash: string; tokensSaved: number }
  | { type: "cache:miss"; prompt: string }
  | { type: "decision:recorded"; id: string; title: string }
  | { type: "decision:superseded"; oldId: string; newId: string }
  | { type: "conflict:detected"; id: string; severity: string; agents: string[] }
  | { type: "conflict:resolved"; id: string }
  | { type: "port:allocated"; port: number; agent: string }
  | { type: "port:released"; port: number }
  | { type: "cleanup:run"; succeeded: number; failed: number }
  | { type: "checkpoint:created"; id: string; taskId: string; label: string }
  | { type: "checkpoint:rollback"; id: string; taskId: string }
  | { type: "cost:estimate"; recommendation: string; singleCost: number; multiCost: number };

export class OrcEventBus extends EventEmitter {
  publish(event: OrcEvent): void {
    this.emit(event.type, event);
    this.emit("*", event);
  }

  on(event: string, listener: (e: OrcEvent) => void): this {
    return super.on(event, listener);
  }
}

export const eventBus = new OrcEventBus();
