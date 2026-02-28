import { EventEmitter } from "node:events";

export interface LspRequest {
  id: number;
  method: string;
  params?: unknown;
}

export interface LspResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface LspNotification {
  method: string;
  params?: unknown;
}

const REQUEST_TIMEOUT_MS = 10_000;

export class LspClient extends EventEmitter {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private nextId = 1;
  private pending: Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  > = new Map();
  private buffer = "";
  private serverName: string;

  constructor(serverName: string) {
    super();
    this.serverName = serverName;
  }

  /** Start the LSP server process */
  async start(command: string[]): Promise<boolean> {
    try {
      this.proc = Bun.spawn(command, {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });

      // Read stdout for JSON-RPC messages
      this.readStream();
      // Drain stderr so the process doesn't block
      this.drainStderr();

      return true;
    } catch {
      this.proc = null;
      return false;
    }
  }

  /** Continuously read stdout and feed data to the parser */
  private async readStream(): Promise<void> {
    if (!this.proc?.stdout) return;

    const reader = this.proc.stdout.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        this.processData(text);
      }
    } catch {
      // Stream ended or process died — ignore
    }
  }

  /** Drain stderr so the child process doesn't stall */
  private async drainStderr(): Promise<void> {
    if (!this.proc?.stderr) return;

    const reader = this.proc.stderr.getReader();
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      // ignore
    }
  }

  /** Send a JSON-RPC request and wait for the matching response */
  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.proc) throw new Error("LSP server not running");

    const id = this.nextId++;
    const msg: Record<string, unknown> = {
      jsonrpc: "2.0",
      id,
      method,
    };
    if (params !== undefined) msg.params = params;

    const raw = this.formatMessage(msg);
    this.proc.stdin!.write(raw);
    this.proc.stdin!.flush();

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request "${method}" timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (v: unknown) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  /** Send a notification (no response expected) */
  notify(method: string, params?: unknown): void {
    if (!this.proc) return;

    const msg: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) msg.params = params;

    const raw = this.formatMessage(msg);
    this.proc.stdin!.write(raw);
    this.proc.stdin!.flush();
  }

  /** Initialize the LSP server (handshake) */
  async initialize(rootUri: string): Promise<unknown> {
    const result = await this.request("initialize", {
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          synchronization: {
            dynamicRegistration: false,
            willSave: false,
            willSaveWaitUntil: false,
            didSave: true,
          },
          completion: {
            dynamicRegistration: false,
            completionItem: {
              snippetSupport: false,
            },
          },
          hover: {
            dynamicRegistration: false,
            contentFormat: ["plaintext", "markdown"],
          },
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
          documentSymbol: { dynamicRegistration: false },
          publishDiagnostics: { relatedInformation: true },
        },
        workspace: {
          workspaceFolders: true,
        },
      },
      workspaceFolders: [{ uri: rootUri, name: "root" }],
    });

    this.notify("initialized", {});
    return result;
  }

  /** Shutdown gracefully */
  async shutdown(): Promise<void> {
    if (!this.proc) return;

    try {
      await this.request("shutdown");
    } catch {
      // Server may already be dead
    }

    this.notify("exit");

    // Give the process a moment to exit, then force kill
    const proc = this.proc;
    this.proc = null;

    // Reject all pending requests
    for (const [id, handler] of this.pending) {
      handler.reject(new Error("LSP server shutting down"));
      this.pending.delete(id);
    }

    try {
      proc.kill();
    } catch {
      // Already dead
    }
  }

  /** Process incoming data from stdout (parse JSON-RPC messages) */
  private processData(chunk: string): void {
    this.buffer += chunk;

    while (true) {
      // Look for Content-Length header
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = this.buffer.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        // Malformed header — skip past it
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;

      // Wait for full body
      if (this.buffer.length < bodyEnd) break;

      const body = this.buffer.slice(bodyStart, bodyEnd);
      this.buffer = this.buffer.slice(bodyEnd);

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }

      if ("id" in msg && msg.id !== undefined && msg.id !== null) {
        // This is a response to one of our requests
        const id = msg.id as number;
        const handler = this.pending.get(id);
        if (handler) {
          this.pending.delete(id);
          if (msg.error) {
            const err = msg.error as { code: number; message: string };
            handler.reject(new Error(`LSP error ${err.code}: ${err.message}`));
          } else {
            handler.resolve(msg.result);
          }
        }

        // It could also be a server-initiated request (has "method" field)
        if ("method" in msg) {
          this.emit("request", {
            id: msg.id,
            method: msg.method,
            params: msg.params,
          });
        }
      } else if ("method" in msg) {
        // This is a notification from the server
        this.emit("notification", {
          method: msg.method,
          params: msg.params,
        });
      }
    }
  }

  /** Format a JSON-RPC message with Content-Length header */
  private formatMessage(msg: object): string {
    const json = JSON.stringify(msg);
    const len = Buffer.byteLength(json, "utf-8");
    return `Content-Length: ${len}\r\n\r\n${json}`;
  }

  get isRunning(): boolean {
    return this.proc !== null;
  }

  get name(): string {
    return this.serverName;
  }
}
