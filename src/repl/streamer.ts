import { EventEmitter } from "node:events";
import { truncateOutput } from "../sandbox/output-limiter.ts";
import { killProcessGroup } from "../sandbox/output-limiter.ts";

export interface StreamResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface ToolUseEvent {
  name: string;
  id?: string;
  input?: Record<string, unknown>;
}

interface StreamJsonMessage {
  type: string;
  subtype?: string;
  // assistant message (Claude CLI format)
  message?: {
    content?: Array<{ type: string; text?: string; name?: string; id?: string; input?: Record<string, unknown> }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  // content_block_start/stop (API streaming format)
  content_block?: { type?: string; text?: string; name?: string; id?: string; input?: Record<string, unknown> };
  // content_block_delta
  delta?: { type?: string; text?: string };
  // result message
  result?: string;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

const MAX_OUTPUT_BYTES = 1_048_576; // 1 MiB

export class AgentStreamer extends EventEmitter {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private aborted = false;
  private textBuffer = "";
  private currentBlockType: string | null = null;
  private totalOutputBytes = 0;

  async run(command: string[], signal?: AbortSignal): Promise<StreamResult> {
    this.aborted = false;
    this.textBuffer = "";
    this.currentBlockType = null;
    this.totalOutputBytes = 0;

    // Listen for external abort signal
    if (signal) {
      signal.addEventListener("abort", () => this.abort(), { once: true });
    }

    const result: StreamResult = {
      text: "",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };

    this.proc = Bun.spawn(command, {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });

    this.reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
    const reader = this.reader;
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        if (this.aborted) break;

        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        this.totalOutputBytes += chunk.length;

        // Output cap: abort if exceeding max bytes
        if (this.totalOutputBytes > MAX_OUTPUT_BYTES) {
          this.emit("error", `Output exceeded ${MAX_OUTPUT_BYTES} bytes limit, aborting`);
          this.abort();
          break;
        }

        buffer += chunk;

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const msg = JSON.parse(trimmed) as StreamJsonMessage;
            this.processMessage(msg, result);
          } catch {
            // Not JSON — emit raw text
            if (trimmed) {
              result.text += trimmed + "\n";
              this.emit("text_delta", trimmed + "\n");
              this.emit("text_complete", trimmed + "\n");
            }
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        try {
          const msg = JSON.parse(buffer.trim()) as StreamJsonMessage;
          this.processMessage(msg, result);
        } catch {
          result.text += buffer.trim() + "\n";
          this.emit("text_delta", buffer.trim() + "\n");
          this.emit("text_complete", buffer.trim() + "\n");
        }
      }

      // Flush any remaining text buffer (safety net)
      if (this.textBuffer) {
        result.text += this.textBuffer;
        this.emit("text_delta", this.textBuffer);
        this.emit("text_complete", this.textBuffer);
        this.textBuffer = "";
      }
    } finally {
      try { reader.releaseLock(); } catch { /* already cancelled */ }
      this.reader = null;
    }

    // If aborted, proc is already killed and nulled — skip stderr/exit handling
    if (this.aborted || !this.proc) {
      this.emit("exit", result);
      return result;
    }

    // Capture stderr for error reporting (stderr gets 2/3 of budget)
    const rawStderr = await new Response(this.proc.stderr as ReadableStream<Uint8Array>).text();
    const stderrText = truncateOutput(rawStderr, Math.floor(MAX_OUTPUT_BYTES * 0.67));

    const exitCode = await this.proc.exited;
    this.proc = null;

    if (exitCode !== 0 && !result.text && stderrText) {
      this.emit("error", stderrText.trim());
    }

    this.emit("exit", result);
    return result;
  }

  private processMessage(msg: StreamJsonMessage, result: StreamResult): void {
    // content_block_start: track block type, emit tool_use immediately
    if (msg.type === "content_block_start" && msg.content_block) {
      this.currentBlockType = msg.content_block.type ?? null;
      if (this.currentBlockType === "tool_use") {
        this.emit("tool_use", {
          name: msg.content_block.name ?? "unknown",
          id: msg.content_block.id,
          input: msg.content_block.input,
        } satisfies ToolUseEvent);
      } else {
        // text block — reset buffer
        this.textBuffer = "";
      }
      return;
    }

    // content_block_delta: accumulate text AND emit delta for real-time streaming
    if (msg.type === "content_block_delta") {
      if (msg.delta?.text) {
        this.textBuffer += msg.delta.text;
        this.emit("text_delta", msg.delta.text);
      }
      return;
    }

    // content_block_stop: flush text buffer for text blocks
    if (msg.type === "content_block_stop") {
      if (this.currentBlockType === "text" && this.textBuffer) {
        result.text += this.textBuffer;
        this.emit("text_complete", this.textBuffer);
        this.textBuffer = "";
      }
      this.currentBlockType = null;
      return;
    }

    // Claude CLI: assistant message with content array (complete message)
    if (msg.type === "assistant" && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text) {
          result.text += block.text;
          this.emit("text_delta", block.text);
          this.emit("text_complete", block.text);
        } else if (block.type === "tool_use") {
          this.emit("tool_use", {
            name: block.name ?? "unknown",
            id: block.id,
            input: block.input,
          } satisfies ToolUseEvent);
        }
      }
      if (msg.message.usage) {
        result.inputTokens += msg.message.usage.input_tokens ?? 0;
        result.outputTokens += msg.message.usage.output_tokens ?? 0;
        this.emit("usage", {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          costUsd: result.costUsd,
        });
      }
      return;
    }

    // Claude CLI: result summary — flush remaining buffer as safety net
    if (msg.type === "result") {
      if (this.textBuffer) {
        result.text += this.textBuffer;
        this.emit("text_delta", this.textBuffer);
        this.emit("text_complete", this.textBuffer);
        this.textBuffer = "";
      }
      if (msg.total_cost_usd) {
        result.costUsd = msg.total_cost_usd;
      }
      if (msg.usage) {
        result.inputTokens = msg.usage.input_tokens ?? result.inputTokens;
        result.outputTokens = msg.usage.output_tokens ?? result.outputTokens;
      }
      this.emit("usage", {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
      });
      return;
    }
  }

  abort(): void {
    this.aborted = true;
    // Cancel reader first so reader.read() resolves immediately
    if (this.reader) {
      this.reader.cancel().catch(() => {});
      this.reader = null;
    }
    if (this.proc) {
      // Kill entire process group to prevent orphaned children
      if (this.proc.pid) killProcessGroup(this.proc.pid);
      else this.proc.kill();
      this.proc = null;
    }
    this.emit("abort");
  }

  get isRunning(): boolean {
    return this.proc !== null;
  }
}
