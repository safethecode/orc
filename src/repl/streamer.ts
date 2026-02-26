import { EventEmitter } from "node:events";

export interface StreamResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

interface StreamJsonMessage {
  type: string;
  content_block?: { text?: string };
  delta?: { text?: string };
  message?: {
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  usage?: { input_tokens?: number; output_tokens?: number };
  result?: string;
  subtype?: string;
  cost_usd?: number;
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

    await this.proc.exited;
    this.emit("exit", result);
    this.proc = null;

    return result;
  }

  private processMessage(msg: StreamJsonMessage, result: StreamResult): void {
    // Claude stream-json: content_block_delta with text
    if (msg.type === "content_block_delta" && msg.delta?.text) {
      result.text += msg.delta.text;
      this.emit("text", msg.delta.text);
      return;
    }

    // Claude stream-json: assistant message with text content
    if (msg.type === "content_block_start" && msg.content_block?.text) {
      result.text += msg.content_block.text;
      this.emit("text", msg.content_block.text);
      return;
    }

    // Claude stream-json: message_delta with usage/cost
    if (msg.type === "message_delta") {
      if (msg.usage) {
        result.inputTokens += msg.usage.input_tokens ?? 0;
        result.outputTokens += msg.usage.output_tokens ?? 0;
      }
      return;
    }

    // Claude stream-json: message_start with initial usage
    if (msg.type === "message_start" && msg.message?.usage) {
      result.inputTokens += msg.message.usage.input_tokens ?? 0;
      result.outputTokens += msg.message.usage.output_tokens ?? 0;
      return;
    }

    // Claude CLI stream-json: result message
    if (msg.type === "result") {
      if (msg.result) {
        result.text += msg.result;
        this.emit("text", msg.result);
      }
      if (msg.cost_usd) {
        result.costUsd = msg.cost_usd;
      }
      if (msg.usage) {
        result.inputTokens = msg.usage.input_tokens ?? result.inputTokens;
        result.outputTokens = msg.usage.output_tokens ?? result.outputTokens;
      }
      return;
    }

    // Claude CLI stream-json: content_block with text type
    if (msg.type === "assistant" && msg.subtype === "text") {
      // Some versions emit assistant text blocks
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
