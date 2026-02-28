export interface SdkServerConfig {
  port?: number;
  host?: string;
  corsOrigins?: string[];
  authToken?: string;
  enableDocs?: boolean;
}

export interface SdkSession {
  id: string;
  createdAt: string;
  lastActivity: string;
  turnCount: number;
  messages: Array<{ role: "user" | "assistant"; content: string; timestamp: string }>;
}

export interface SseClient {
  id: string;
  sessionId: string;
  controller: ReadableStreamDefaultController;
}

type RequiredConfig = Required<SdkServerConfig>;

const OPENAPI_SPEC = {
  openapi: "3.0.3",
  info: {
    title: "Orchestrator SDK API",
    version: "1.0.0",
    description: "HTTP API for programmatic access to orchestrator sessions.",
  },
  servers: [{ url: "http://127.0.0.1:4321" }],
  paths: {
    "/health": {
      get: {
        summary: "Health check",
        responses: {
          "200": {
            description: "Server status",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string" },
                    uptime: { type: "number" },
                    sessions: { type: "number" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/sessions": {
      get: {
        summary: "List all sessions",
        responses: {
          "200": {
            description: "Array of sessions",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Session" },
                },
              },
            },
          },
        },
      },
      post: {
        summary: "Create a new session",
        responses: {
          "201": {
            description: "Created session",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Session" },
              },
            },
          },
        },
      },
    },
    "/sessions/{id}": {
      get: {
        summary: "Get session details",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "Session details",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Session" },
              },
            },
          },
          "404": { description: "Session not found" },
        },
      },
      delete: {
        summary: "Destroy a session",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Session destroyed" },
          "404": { description: "Session not found" },
        },
      },
    },
    "/sessions/{id}/messages": {
      post: {
        summary: "Send a message to a session",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["content"],
                properties: { content: { type: "string" } },
              },
            },
          },
        },
        responses: {
          "200": { description: "Assistant response" },
          "400": { description: "Invalid request body" },
          "404": { description: "Session not found" },
        },
      },
    },
    "/sessions/{id}/events": {
      get: {
        summary: "SSE stream for real-time session events",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "SSE event stream" },
          "404": { description: "Session not found" },
        },
      },
    },
    "/doc": {
      get: {
        summary: "OpenAPI specification",
        responses: {
          "200": {
            description: "OpenAPI JSON spec",
            content: { "application/json": {} },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Session: {
        type: "object",
        properties: {
          id: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
          lastActivity: { type: "string", format: "date-time" },
          turnCount: { type: "number" },
          messages: {
            type: "array",
            items: {
              type: "object",
              properties: {
                role: { type: "string", enum: ["user", "assistant"] },
                content: { type: "string" },
                timestamp: { type: "string", format: "date-time" },
              },
            },
          },
        },
      },
    },
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
      },
    },
  },
};

function generateId(): string {
  return `sdk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export class SdkServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private config: RequiredConfig;
  private sessions: Map<string, SdkSession> = new Map();
  private sseClients: Map<string, SseClient> = new Map();
  private startTime: number = 0;

  constructor(config?: SdkServerConfig) {
    this.config = {
      port: config?.port ?? 4321,
      host: config?.host ?? "127.0.0.1",
      corsOrigins: config?.corsOrigins ?? ["*"],
      authToken: config?.authToken ?? "",
      enableDocs: config?.enableDocs ?? true,
    };
  }

  async start(): Promise<void> {
    if (this.server) return;

    this.startTime = Date.now();

    this.server = Bun.serve({
      port: this.config.port,
      hostname: this.config.host,
      fetch: (req: Request) => this.handleRequest(req),
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;

    // Close all SSE connections
    for (const [id, client] of this.sseClients) {
      try {
        client.controller.close();
      } catch {
        // Already closed
      }
      this.sseClients.delete(id);
    }

    this.server.stop();
    this.server = null;
  }

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // Handle CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: this.corsHeaders() });
    }

    // Auth check (skip for OPTIONS already handled above)
    if (!this.authenticate(req)) {
      return this.json({ error: "Unauthorized" }, 401);
    }

    try {
      // GET /health
      if (method === "GET" && path === "/health") {
        return this.json({
          status: "ok",
          uptime: Math.floor((Date.now() - this.startTime) / 1000),
          sessions: this.sessions.size,
        });
      }

      // GET /doc
      if (method === "GET" && path === "/doc") {
        if (!this.config.enableDocs) {
          return this.json({ error: "Documentation disabled" }, 404);
        }
        const spec = {
          ...OPENAPI_SPEC,
          servers: [{ url: this.getUrl() }],
        };
        return this.json(spec);
      }

      // GET /sessions
      if (method === "GET" && path === "/sessions") {
        const list = Array.from(this.sessions.values()).map((s) => ({
          id: s.id,
          createdAt: s.createdAt,
          lastActivity: s.lastActivity,
          turnCount: s.turnCount,
          messageCount: s.messages.length,
        }));
        return this.json(list);
      }

      // POST /sessions
      if (method === "POST" && path === "/sessions") {
        const now = new Date().toISOString();
        const session: SdkSession = {
          id: generateId(),
          createdAt: now,
          lastActivity: now,
          turnCount: 0,
          messages: [],
        };
        this.sessions.set(session.id, session);
        this.broadcastEvent(session.id, "session:created", { id: session.id });
        return this.json(session, 201);
      }

      // Routes with session ID: /sessions/:id[/...]
      const sessionMatch = path.match(/^\/sessions\/([^/]+)(\/.*)?$/);
      if (sessionMatch) {
        const sessionId = sessionMatch[1];
        const subPath = sessionMatch[2] ?? "";

        // GET /sessions/:id
        if (method === "GET" && subPath === "") {
          const session = this.sessions.get(sessionId);
          if (!session) return this.json({ error: "Session not found" }, 404);
          return this.json(session);
        }

        // DELETE /sessions/:id
        if (method === "DELETE" && subPath === "") {
          const session = this.sessions.get(sessionId);
          if (!session) return this.json({ error: "Session not found" }, 404);

          // Close any SSE clients for this session
          for (const [id, client] of this.sseClients) {
            if (client.sessionId === sessionId) {
              try {
                client.controller.close();
              } catch {
                // Already closed
              }
              this.sseClients.delete(id);
            }
          }

          this.sessions.delete(sessionId);
          this.broadcastEvent(sessionId, "session:destroyed", { id: sessionId });
          return this.json({ ok: true, id: sessionId });
        }

        // POST /sessions/:id/messages
        if (method === "POST" && subPath === "/messages") {
          const session = this.sessions.get(sessionId);
          if (!session) return this.json({ error: "Session not found" }, 404);

          let body: { content?: string };
          try {
            body = await req.json();
          } catch {
            return this.json({ error: "Invalid JSON body" }, 400);
          }

          if (!body.content || typeof body.content !== "string") {
            return this.json({ error: "Missing required field: content (string)" }, 400);
          }

          const now = new Date().toISOString();

          // Record user message
          const userMessage = { role: "user" as const, content: body.content, timestamp: now };
          session.messages.push(userMessage);
          session.turnCount++;
          session.lastActivity = now;

          this.broadcastEvent(sessionId, "message:user", userMessage);

          // Stub assistant response (real orchestrator wires in later)
          const assistantTimestamp = new Date().toISOString();
          const assistantMessage = {
            role: "assistant" as const,
            content: `[stub] Received: ${body.content}`,
            timestamp: assistantTimestamp,
          };
          session.messages.push(assistantMessage);
          session.turnCount++;
          session.lastActivity = assistantTimestamp;

          this.broadcastEvent(sessionId, "message:assistant", assistantMessage);

          return this.json(assistantMessage);
        }

        // GET /sessions/:id/events (SSE)
        if (method === "GET" && subPath === "/events") {
          const session = this.sessions.get(sessionId);
          if (!session) return this.json({ error: "Session not found" }, 404);

          return this.setupSse(sessionId);
        }

        return this.json({ error: "Not found" }, 404);
      }

      return this.json({ error: "Not found" }, 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal server error";
      return this.json({ error: message }, 500);
    }
  }

  private setupSse(sessionId: string): Response {
    const clientId = generateId();

    const stream = new ReadableStream({
      start: (controller) => {
        const client: SseClient = { id: clientId, sessionId, controller };
        this.sseClients.set(clientId, client);

        // Send initial connected event
        const data = JSON.stringify({ type: "connected", clientId, sessionId });
        controller.enqueue(new TextEncoder().encode(`event: connected\ndata: ${data}\n\n`));
      },
      cancel: () => {
        this.sseClients.delete(clientId);
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        ...this.corsHeaders(),
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  }

  private broadcastEvent(sessionId: string, event: string, data: unknown): void {
    const encoder = new TextEncoder();
    const payload = JSON.stringify(data);
    const chunk = encoder.encode(`event: ${event}\ndata: ${payload}\n\n`);

    for (const [id, client] of this.sseClients) {
      if (client.sessionId !== sessionId) continue;
      try {
        client.controller.enqueue(chunk);
      } catch {
        // Client disconnected, clean up
        this.sseClients.delete(id);
      }
    }
  }

  private authenticate(req: Request): boolean {
    if (!this.config.authToken) return true;

    const header = req.headers.get("Authorization");
    if (!header) return false;

    const parts = header.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") return false;

    return parts[1] === this.config.authToken;
  }

  private corsHeaders(): Record<string, string> {
    const origin = this.config.corsOrigins.includes("*")
      ? "*"
      : this.config.corsOrigins.join(", ");

    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    };
  }

  private json(data: unknown, status: number = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        ...this.corsHeaders(),
        "Content-Type": "application/json",
      },
    });
  }

  isRunning(): boolean {
    return this.server !== null;
  }

  getPort(): number {
    return this.config.port;
  }

  getUrl(): string {
    return `http://${this.config.host}:${this.config.port}`;
  }
}
