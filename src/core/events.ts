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
  | { type: "cost:estimate"; recommendation: string; singleCost: number; multiCost: number }
  | { type: "supervisor:decompose"; taskId: string; subtaskCount: number; strategy: string }
  | { type: "supervisor:plan"; taskId: string; phases: number; estimatedCost: number }
  | { type: "supervisor:dispatch"; taskId: string; subtaskId: string; provider: string; model: string }
  | { type: "worker:spawn"; workerId: string; provider: string; model: string; role: string }
  | { type: "worker:progress"; workerId: string; progress: number }
  | { type: "worker:complete"; workerId: string; tokenUsage: number; costUsd: number; durationMs: number }
  | { type: "worker:fail"; workerId: string; error: string }
  | { type: "worker:timeout"; workerId: string; elapsedMs: number }
  | { type: "result:collected"; taskId: string; subtaskId: string; success: boolean }
  | { type: "result:merged"; taskId: string; totalSubtasks: number; conflicts: number }
  | { type: "provider:selected"; subtaskId: string; provider: string; model: string; reason: string }
  | { type: "provider:fallback"; subtaskId: string; from: string; to: string; reason: string }
  | { type: "worker:turn"; workerId: string; turn: number; maxTurns: number; toolUsed?: string }
  | { type: "worker:turn_output"; workerId: string; turn: number; output: string; files: string[] }
  | { type: "worker:idle_timeout"; workerId: string; idleMs: number }
  | { type: "workerbus:message"; messageId: string; from: string; to: string; messageType: string }
  | { type: "workerbus:broadcast"; messageId: string; from: string; messageType: string }
  | { type: "workerbus:artifact"; from: string; files: string[]; apis: string[] }
  | { type: "feedback:check"; workerId: string; subtaskId: string; turn: number }
  | { type: "feedback:assessment"; workerId: string; action: string; reason: string }
  | { type: "feedback:correction"; workerId: string; message: string }
  | { type: "feedback:quality_gate"; subtaskId: string; passed: boolean; issues: string[] }
  | { type: "feedback:qa_loop"; subtaskId: string; iteration: number }
  | { type: "feedback:abort"; workerId: string; reason: string }
  | { type: "feedback:recovery"; workerId: string; action: string; reason: string }
  | { type: "context:propagate"; subtaskId: string; contextTokens: number; sources: string[] }
  | { type: "context:sibling_summary"; subtaskId: string; siblingCount: number; filesShared: string[] }
  | { type: "worker:signal_done"; workerId: string }
  | { type: "worker:result_marker"; workerId: string; files: string[]; summary: string }
  | { type: "file:change"; file: string; changeType: string }
  | { type: "branch:switch"; from: string; to: string }
  | { type: "question:ask"; questionId: string; question: string }
  | { type: "question:reply"; questionId: string; answer: string }
  | { type: "background:spawn"; taskId: string; provider: string }
  | { type: "background:complete"; taskId: string; success: boolean }
  | { type: "worktree:create"; branch: string; path: string; agentId?: string }
  | { type: "worktree:remove"; path: string }
  | { type: "recovery:strategy"; strategy: string; action: string; details: string }
  | { type: "stats:record"; tokens: number; cost: number; model: string }
  | { type: "thinking:block"; agent: string; content: string; tokens: number }
  | { type: "fastwork:activate"; model: string; overrides: string }
  | { type: "ultrathink:activate"; model: string; overrides: string }
  | { type: "doctor:check"; check: string; status: "pass" | "warn" | "fail" }
  | { type: "stash:push"; index: number; preview: string }
  | { type: "stash:pop"; text: string }
  | { type: "frecency:update"; file: string; score: number }
  | { type: "notification:sent"; title: string }
  | { type: "todo:continue"; iteration: number; remaining: number }
  | { type: "babysitter:nudge"; taskId: string }
  | { type: "acp:request"; method: string; sessionId?: string }
  | { type: "sdk:request"; method: string; path: string }
  | { type: "web:connect"; clientId: string }
  | { type: "web:disconnect"; clientId: string }
  | { type: "refactor:phase"; phase: string; status: "start" | "complete" | "failed" }
  | { type: "github:action"; action: string; detail: string }
  | { type: "copilot:auth"; provider: string; status: "started" | "success" | "failed" };

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
