import { EventEmitter } from "node:events";
import type { WorkerMessage, WorkerManifest, WorkerMessageType } from "../config/types.ts";
import type { Inbox } from "../messaging/inbox.ts";
import type { SessionManager } from "../session/manager.ts";
import type { Store } from "../db/store.ts";
import { eventBus } from "./events.ts";

export class WorkerBus extends EventEmitter {
  private manifests: Map<string, WorkerManifest> = new Map(); // agentName → manifest
  private messages: WorkerMessage[] = [];

  constructor(
    private inbox: Inbox,
    private sessionManager: SessionManager,
    private store: Store,
  ) {
    super();
  }

  registerWorker(manifest: WorkerManifest): void {
    this.manifests.set(manifest.agentName, manifest);
  }

  unregisterWorker(agentName: string): void {
    this.manifests.delete(agentName);
  }

  send(msg: Omit<WorkerMessage, "id" | "timestamp">): WorkerMessage {
    const fullMsg: WorkerMessage = {
      ...msg,
      id: `wm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
    };

    this.messages.push(fullMsg);

    // Persist to DB
    this.store.addWorkerMessage({
      id: fullMsg.id,
      from: fullMsg.from,
      to: fullMsg.to as string,
      type: fullMsg.type,
      content: fullMsg.content,
      metadata: fullMsg.metadata as Record<string, unknown>,
      taskRef: fullMsg.taskRef,
      subtaskRef: fullMsg.subtaskRef,
    });

    // Deliver via session manager
    if (fullMsg.to === "all") {
      // Broadcast to all workers in same task
      for (const [name, manifest] of this.manifests) {
        if (name !== fullMsg.from && manifest.subtaskId !== fullMsg.subtaskRef) {
          this.sessionManager.sendInput(name, this.formatForDelivery(fullMsg)).catch(() => {});
        }
      }
      eventBus.publish({
        type: "workerbus:broadcast",
        messageId: fullMsg.id,
        from: fullMsg.from,
        messageType: fullMsg.type,
      });
    } else {
      this.sessionManager.sendInput(fullMsg.to as string, this.formatForDelivery(fullMsg)).catch(() => {});
      eventBus.publish({
        type: "workerbus:message",
        messageId: fullMsg.id,
        from: fullMsg.from,
        to: fullMsg.to as string,
        messageType: fullMsg.type,
      });
    }

    return fullMsg;
  }

  broadcastArtifact(
    from: string,
    taskRef: string,
    artifact: { files?: string[]; apis?: string[]; schemas?: string[] },
  ): void {
    const subtaskRef = this.manifests.get(from)?.subtaskId ?? "";

    this.send({
      from,
      to: "all",
      type: "artifact",
      content: `Completed work. Files: ${(artifact.files ?? []).join(", ")}. APIs: ${(artifact.apis ?? []).join(", ")}. Schemas: ${(artifact.schemas ?? []).join(", ")}.`,
      metadata: {
        files: artifact.files,
        apis: artifact.apis,
        schemas: artifact.schemas,
      },
      taskRef,
      subtaskRef,
    });

    eventBus.publish({
      type: "workerbus:artifact",
      from,
      files: artifact.files ?? [],
      apis: artifact.apis ?? [],
    });
  }

  getSiblings(taskRef: string, excludeAgent?: string): WorkerManifest[] {
    const prefix = taskRef.slice(0, 8);
    return [...this.manifests.values()]
      .filter(m => m.agentName !== excludeAgent && m.subtaskId.startsWith(prefix));
  }

  getMessagesFor(agentName: string): WorkerMessage[] {
    return this.messages.filter(m => m.to === agentName || m.to === "all");
  }

  getMessagesByTask(taskRef: string): WorkerMessage[] {
    return this.messages.filter(m => m.taskRef === taskRef);
  }

  formatSiblingContext(taskRef: string, excludeAgent?: string): string {
    const siblings = this.getSiblings(taskRef, excludeAgent);
    if (siblings.length === 0) return "";

    const lines = siblings.map(
      s => `- ${s.agentName} (${s.role}/${s.domain}): ${s.prompt.slice(0, 100)}`,
    );
    return `Sibling workers:\n${lines.join("\n")}`;
  }

  clearTask(taskRef: string): void {
    this.messages = this.messages.filter(m => m.taskRef !== taskRef);
    // Don't clear manifests — they're cleared individually via unregisterWorker
  }

  clear(): void {
    this.manifests.clear();
    this.messages = [];
  }

  private formatForDelivery(msg: WorkerMessage): string {
    return `[WorkerBus:${msg.type} from ${msg.from}]: ${msg.content}`;
  }
}
