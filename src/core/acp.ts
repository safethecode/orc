export interface AcpRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface AcpResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface AcpSession {
  id: string;
  createdAt: string;
  messages: Array<{ role: "user" | "assistant"; content: string; timestamp: string }>;
}

export type AcpMessageHandler = (sessionId: string, content: string) => Promise<string>;
export type AcpCancelHandler = (sessionId: string) => Promise<boolean>;
export type AcpDiagnosticsHandler = (filePath: string) => Promise<Array<{line: number; message: string; severity: string}>>;
export type AcpSymbolsHandler = (filePath: string) => Promise<Array<{name: string; kind: string; line: number}>>;
export type AcpListHandler = () => Promise<Array<{name: string; description?: string}>>;
export type AcpSwitchHandler = (name: string) => Promise<boolean>;

export interface AcpServerConfig {
  maxSessions?: number;
  sessionTimeoutMs?: number;
  enableLogging?: boolean;
}

// JSON-RPC 2.0 error codes
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

// ACP-specific error codes
const SESSION_NOT_FOUND = -32000;
const SESSION_LIMIT_REACHED = -32001;

const SUPPORTED_METHODS = [
  "initialize",
  "session/create",
  "session/message",
  "session/list",
  "session/cancel",
  "session/destroy",
  "file/diagnostics",
  "file/symbols",
  "agent/list",
  "agent/switch",
  "model/list",
  "model/switch",
] as const;

export class AcpServer {
  private sessions: Map<string, AcpSession> = new Map();
  private config: Required<AcpServerConfig>;
  private running = false;
  private buffer = "";
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private messageHandler: AcpMessageHandler | null = null;
  private cancelHandler: AcpCancelHandler | null = null;
  private diagnosticsHandler: AcpDiagnosticsHandler | null = null;
  private symbolsHandler: AcpSymbolsHandler | null = null;
  private agentListHandler: AcpListHandler | null = null;
  private agentSwitchHandler: AcpSwitchHandler | null = null;
  private modelListHandler: AcpListHandler | null = null;
  private modelSwitchHandler: AcpSwitchHandler | null = null;

  constructor(config?: AcpServerConfig) {
    this.config = {
      maxSessions: config?.maxSessions ?? 10,
      sessionTimeoutMs: config?.sessionTimeoutMs ?? 30 * 60 * 1000,
      enableLogging: config?.enableLogging ?? false,
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Periodic cleanup of expired sessions (every 60 seconds)
    this.cleanupTimer = setInterval(() => this.cleanExpiredSessions(), 60_000);

    this.log("ACP server started");

    // Read from stdin using async iteration
    const decoder = new TextDecoder();

    for await (const chunk of process.stdin as unknown as AsyncIterable<Uint8Array>) {
      if (!this.running) break;

      this.buffer += decoder.decode(chunk, { stream: true });
      const requests = this.parseMessages(this.buffer);

      for (const req of requests) {
        const response = await this.handleRequest(req);
        this.sendResponse(response);
      }
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    this.log("ACP server stopped");
  }

  async handleRequest(request: AcpRequest): Promise<AcpResponse> {
    // Validate JSON-RPC envelope
    if (request.jsonrpc !== "2.0" || request.id == null || !request.method) {
      return {
        jsonrpc: "2.0",
        id: request.id ?? null,
        error: { code: INVALID_REQUEST, message: "Invalid JSON-RPC 2.0 request" },
      };
    }

    this.log(`<- ${request.method} (id=${request.id})`);

    switch (request.method) {
      case "initialize":
        return this.handleInitialize(request);
      case "session/create":
        return this.handleSessionCreate(request);
      case "session/message":
        return this.handleSessionMessage(request);
      case "session/list":
        return this.handleSessionList(request);
      case "session/cancel":
        return this.handleSessionCancel(request);
      case "session/destroy":
        return this.handleSessionDestroy(request);
      case "file/diagnostics":
        return this.handleFileDiagnostics(request);
      case "file/symbols":
        return this.handleFileSymbols(request);
      case "agent/list":
        return this.handleAgentList(request);
      case "agent/switch":
        return this.handleAgentSwitch(request);
      case "model/list":
        return this.handleModelList(request);
      case "model/switch":
        return this.handleModelSwitch(request);
      default:
        return {
          jsonrpc: "2.0",
          id: request.id,
          error: { code: METHOD_NOT_FOUND, message: `Unknown method: ${request.method}` },
        };
    }
  }

  onMessage(handler: AcpMessageHandler): void {
    this.messageHandler = handler;
  }

  onCancel(handler: AcpCancelHandler): void {
    this.cancelHandler = handler;
  }

  onDiagnostics(handler: AcpDiagnosticsHandler): void {
    this.diagnosticsHandler = handler;
  }

  onSymbols(handler: AcpSymbolsHandler): void {
    this.symbolsHandler = handler;
  }

  onAgentList(handler: AcpListHandler): void {
    this.agentListHandler = handler;
  }

  onAgentSwitch(handler: AcpSwitchHandler): void {
    this.agentSwitchHandler = handler;
  }

  onModelList(handler: AcpListHandler): void {
    this.modelListHandler = handler;
  }

  onModelSwitch(handler: AcpSwitchHandler): void {
    this.modelSwitchHandler = handler;
  }

  isRunning(): boolean {
    return this.running;
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  // ------- Method handlers -------

  private handleInitialize(request: AcpRequest): AcpResponse {
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        version: "1.0",
        methods: [...SUPPORTED_METHODS],
      },
    };
  }

  private handleSessionCreate(request: AcpRequest): AcpResponse {
    if (this.sessions.size >= this.config.maxSessions) {
      // Try to free space by cleaning expired sessions first
      this.cleanExpiredSessions();

      if (this.sessions.size >= this.config.maxSessions) {
        return {
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: SESSION_LIMIT_REACHED,
            message: `Session limit reached (max ${this.config.maxSessions})`,
          },
        };
      }
    }

    const session = this.createSession();
    this.sessions.set(session.id, session);

    this.log(`Session created: ${session.id}`);

    return {
      jsonrpc: "2.0",
      id: request.id,
      result: { sessionId: session.id },
    };
  }

  private async handleSessionMessage(request: AcpRequest): Promise<AcpResponse> {
    const params = request.params;
    if (!params || typeof params.sessionId !== "string" || typeof params.content !== "string") {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: INVALID_PARAMS,
          message: "Required params: sessionId (string), content (string)",
        },
      };
    }

    const session = this.sessions.get(params.sessionId);
    if (!session) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: SESSION_NOT_FOUND, message: `Session not found: ${params.sessionId}` },
      };
    }

    const now = new Date().toISOString();

    // Store the user message
    session.messages.push({ role: "user", content: params.content, timestamp: now });

    if (!this.messageHandler) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: INTERNAL_ERROR, message: "No message handler configured" },
      };
    }

    let assistantContent: string;
    try {
      assistantContent = await this.messageHandler(params.sessionId, params.content);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: INTERNAL_ERROR, message: `Agent error: ${errMsg}` },
      };
    }

    const responseTimestamp = new Date().toISOString();
    session.messages.push({ role: "assistant", content: assistantContent, timestamp: responseTimestamp });

    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        sessionId: session.id,
        response: assistantContent,
      },
    };
  }

  private handleSessionList(request: AcpRequest): AcpResponse {
    const sessions = [...this.sessions.values()].map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      messageCount: s.messages.length,
    }));

    return {
      jsonrpc: "2.0",
      id: request.id,
      result: { sessions },
    };
  }

  private async handleSessionCancel(request: AcpRequest): Promise<AcpResponse> {
    const params = request.params;
    if (!params || typeof params.sessionId !== "string") {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: INVALID_PARAMS, message: "Required param: sessionId (string)" },
      };
    }

    const session = this.sessions.get(params.sessionId);
    if (!session) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: SESSION_NOT_FOUND, message: `Session not found: ${params.sessionId}` },
      };
    }

    this.log(`Session cancel requested: ${params.sessionId}`);

    let cancelled = false;
    if (this.cancelHandler) {
      try {
        cancelled = await this.cancelHandler(params.sessionId);
      } catch {
        cancelled = false;
      }
    }

    return {
      jsonrpc: "2.0",
      id: request.id,
      result: { sessionId: params.sessionId, cancelled },
    };
  }

  private handleSessionDestroy(request: AcpRequest): AcpResponse {
    const params = request.params;
    if (!params || typeof params.sessionId !== "string") {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: INVALID_PARAMS, message: "Required param: sessionId (string)" },
      };
    }

    const deleted = this.sessions.delete(params.sessionId);
    if (!deleted) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: SESSION_NOT_FOUND, message: `Session not found: ${params.sessionId}` },
      };
    }

    this.log(`Session destroyed: ${params.sessionId}`);

    return {
      jsonrpc: "2.0",
      id: request.id,
      result: { sessionId: params.sessionId, destroyed: true },
    };
  }

  // ------- IDE integration handlers -------

  private async handleFileDiagnostics(request: AcpRequest): Promise<AcpResponse> {
    const params = request.params;
    if (!params || typeof params.filePath !== "string") {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: INVALID_PARAMS, message: "Required param: filePath (string)" },
      };
    }

    if (!this.diagnosticsHandler) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: INTERNAL_ERROR, message: "No diagnostics handler configured" },
      };
    }

    try {
      const diagnostics = await this.diagnosticsHandler(params.filePath);
      return { jsonrpc: "2.0", id: request.id, result: { filePath: params.filePath, diagnostics } };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: INTERNAL_ERROR, message: `Diagnostics error: ${errMsg}` },
      };
    }
  }

  private async handleFileSymbols(request: AcpRequest): Promise<AcpResponse> {
    const params = request.params;
    if (!params || typeof params.filePath !== "string") {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: INVALID_PARAMS, message: "Required param: filePath (string)" },
      };
    }

    if (!this.symbolsHandler) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: INTERNAL_ERROR, message: "No symbols handler configured" },
      };
    }

    try {
      const symbols = await this.symbolsHandler(params.filePath);
      return { jsonrpc: "2.0", id: request.id, result: { filePath: params.filePath, symbols } };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: INTERNAL_ERROR, message: `Symbols error: ${errMsg}` },
      };
    }
  }

  private async handleAgentList(request: AcpRequest): Promise<AcpResponse> {
    if (!this.agentListHandler) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: INTERNAL_ERROR, message: "No agent list handler configured" },
      };
    }

    try {
      const agents = await this.agentListHandler();
      return { jsonrpc: "2.0", id: request.id, result: { agents } };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: INTERNAL_ERROR, message: `Agent list error: ${errMsg}` },
      };
    }
  }

  private async handleAgentSwitch(request: AcpRequest): Promise<AcpResponse> {
    const params = request.params;
    if (!params || typeof params.name !== "string") {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: INVALID_PARAMS, message: "Required param: name (string)" },
      };
    }

    if (!this.agentSwitchHandler) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: INTERNAL_ERROR, message: "No agent switch handler configured" },
      };
    }

    try {
      const found = await this.agentSwitchHandler(params.name);
      return { jsonrpc: "2.0", id: request.id, result: { name: params.name, found } };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: INTERNAL_ERROR, message: `Agent switch error: ${errMsg}` },
      };
    }
  }

  private async handleModelList(request: AcpRequest): Promise<AcpResponse> {
    if (!this.modelListHandler) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: INTERNAL_ERROR, message: "No model list handler configured" },
      };
    }

    try {
      const models = await this.modelListHandler();
      return { jsonrpc: "2.0", id: request.id, result: { models } };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: INTERNAL_ERROR, message: `Model list error: ${errMsg}` },
      };
    }
  }

  private async handleModelSwitch(request: AcpRequest): Promise<AcpResponse> {
    const params = request.params;
    if (!params || typeof params.name !== "string") {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: INVALID_PARAMS, message: "Required param: name (string)" },
      };
    }

    if (!this.modelSwitchHandler) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: INTERNAL_ERROR, message: "No model switch handler configured" },
      };
    }

    try {
      const found = await this.modelSwitchHandler(params.name);
      return { jsonrpc: "2.0", id: request.id, result: { name: params.name, found } };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: INTERNAL_ERROR, message: `Model switch error: ${errMsg}` },
      };
    }
  }

  // ------- Internal helpers -------

  /**
   * Parse LSP-style Content-Length delimited messages from the buffer.
   * Consumes complete messages and leaves partial data in this.buffer.
   */
  private parseMessages(data: string): AcpRequest[] {
    const requests: AcpRequest[] = [];
    this.buffer = data;

    while (true) {
      // Look for Content-Length header
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const headerBlock = this.buffer.slice(0, headerEnd);
      const match = headerBlock.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        // Malformed header — skip past the header separator and continue
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;

      // Check if we have the full body
      if (this.buffer.length < bodyStart + contentLength) break;

      const body = this.buffer.slice(bodyStart, bodyStart + contentLength);
      this.buffer = this.buffer.slice(bodyStart + contentLength);

      try {
        const parsed = JSON.parse(body) as AcpRequest;
        requests.push(parsed);
      } catch {
        // Send a parse error response for malformed JSON
        this.sendResponse({
          jsonrpc: "2.0",
          id: null,
          error: { code: PARSE_ERROR, message: "Invalid JSON" },
        });
      }
    }

    return requests;
  }

  private sendResponse(response: AcpResponse): void {
    const body = JSON.stringify(response);
    const header = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n`;

    process.stdout.write(header + body);

    this.log(`-> ${response.error ? `error(${response.error.code})` : "ok"} (id=${response.id})`);
  }

  private createSession(): AcpSession {
    return {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      messages: [],
    };
  }

  private cleanExpiredSessions(): void {
    const now = Date.now();
    const expiredIds: string[] = [];

    for (const [id, session] of this.sessions) {
      // Use the latest message timestamp, or createdAt if no messages
      const lastActivity = session.messages.length > 0
        ? new Date(session.messages[session.messages.length - 1].timestamp).getTime()
        : new Date(session.createdAt).getTime();

      if (now - lastActivity > this.config.sessionTimeoutMs) {
        expiredIds.push(id);
      }
    }

    for (const id of expiredIds) {
      this.sessions.delete(id);
      this.log(`Session expired: ${id}`);
    }
  }

  private log(message: string): void {
    if (this.config.enableLogging) {
      process.stderr.write(`[acp] ${message}\n`);
    }
  }
}
