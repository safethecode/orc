import { EventEmitter } from "node:events";

export interface StreamResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

interface StreamJsonMessage {
  type: string;
  subtype?: string;
  // assistant message (Claude CLI format)
  message?: {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  // content_block_delta (API streaming format)
  content_block?: { text?: string };
  delta?: { text?: string };
  // result message
  result?: string;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class AgentStreamer extends EventEmitter {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private aborted = false;

  async run(command: string[]): Promise<StreamResult> {
    this.aborted = false;

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

    const reader = this.proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        if (this.aborted) break;

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

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
              this.emit("text", trimmed + "\n");
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
          this.emit("text", buffer.trim() + "\n");
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Capture stderr for error reporting
    const stderrText = await new Response(this.proc.stderr).text();

    const exitCode = await this.proc.exited;
    this.proc = null;

    if (exitCode !== 0 && !result.text && stderrText) {
      this.emit("error", stderrText.trim());
    }

    this.emit("exit", result);
    return result;
  }

  private processMessage(msg: StreamJsonMessage, result: StreamResult): void {
    // Claude CLI: assistant message with content array
    if (msg.type === "assistant" && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text) {
          result.text += block.text;
          this.emit("text", block.text);
        }
      }
      if (msg.message.usage) {
        result.inputTokens += msg.message.usage.input_tokens ?? 0;
        result.outputTokens += msg.message.usage.output_tokens ?? 0;
      }
      return;
    }

    // Claude CLI: result summary
    if (msg.type === "result") {
      if (msg.total_cost_usd) {
        result.costUsd = msg.total_cost_usd;
      }
      if (msg.usage) {
        result.inputTokens = msg.usage.input_tokens ?? result.inputTokens;
        result.outputTokens = msg.usage.output_tokens ?? result.outputTokens;
      }
      return;
    }

    // API streaming: content_block_delta
    if (msg.type === "content_block_delta" && msg.delta?.text) {
      result.text += msg.delta.text;
      this.emit("text", msg.delta.text);
      return;
    }
  }

  abort(): void {
    this.aborted = true;
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.emit("abort");
  }

  get isRunning(): boolean {
    return this.proc !== null;
  }
}
