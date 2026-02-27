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
  | { type: "command:safety"; command: string; level: string };

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
