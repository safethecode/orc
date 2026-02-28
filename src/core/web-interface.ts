import { join } from "node:path";
import { mkdir, stat } from "node:fs/promises";

export interface WebInterfaceConfig {
  port?: number;
  host?: string;
  staticDir?: string;
  sdkServerUrl?: string;
  authEnabled?: boolean;
  authUsername?: string;
  authPassword?: string;
}

export interface WebSocketClient {
  id: string;
  ws: unknown;
  subscribedEvents: Set<string>;
  connectedAt: string;
}

type BunWebSocket = {
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  data: { clientId: string };
};

type BunServer = {
  stop(closeActiveConnections?: boolean): void;
  port: number;
  hostname: string;
};

export class WebInterface {
  private server: BunServer | null = null;
  private config: Required<WebInterfaceConfig>;
  private clients: Map<string, WebSocketClient> = new Map();
  private startedAt: string | null = null;

  constructor(config?: WebInterfaceConfig) {
    this.config = {
      port: config?.port ?? 4322,
      host: config?.host ?? "127.0.0.1",
      staticDir: config?.staticDir ?? `${process.env.HOME}/.orchestrator/web`,
      sdkServerUrl: config?.sdkServerUrl ?? "http://127.0.0.1:4321",
      authEnabled: config?.authEnabled ?? false,
      authUsername: config?.authUsername ?? "admin",
      authPassword: config?.authPassword ?? "",
    };
  }

  async start(): Promise<void> {
    if (this.server) return;

    await mkdir(this.config.staticDir, { recursive: true });

    const self = this;

    this.server = Bun.serve({
      port: this.config.port,
      hostname: this.config.host,

      async fetch(req: Request, server: unknown): Promise<Response> {
        const url = new URL(req.url);

        // Attempt WebSocket upgrade for /ws path
        if (url.pathname === "/ws") {
          const clientId = `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          const upgraded = (server as { upgrade(req: Request, opts: unknown): boolean }).upgrade(req, {
            data: { clientId },
          });
          if (upgraded) return undefined as unknown as Response;
          return new Response("WebSocket upgrade failed", { status: 400 });
        }

        return self.handleHttp(req);
      },

      websocket: {
        open(ws: BunWebSocket) {
          self.handleWsOpen(ws, ws.data.clientId);
        },
        message(ws: BunWebSocket, message: string | Buffer) {
          const msg = typeof message === "string" ? message : message.toString();
          self.handleWsMessage(ws, ws.data.clientId, msg);
        },
        close(ws: BunWebSocket) {
          self.handleWsClose(ws.data.clientId);
        },
      },
    }) as unknown as BunServer;

    this.startedAt = new Date().toISOString();
  }

  async stop(): Promise<void> {
    if (!this.server) return;

    // Close all WebSocket connections
    for (const [, client] of this.clients) {
      try {
        (client.ws as BunWebSocket).close(1000, "Server shutting down");
      } catch {
        // Client may already be disconnected
      }
    }

    this.clients.clear();
    this.server.stop(true);
    this.server = null;
    this.startedAt = null;
  }

  private async handleHttp(req: Request): Promise<Response> {
    if (this.config.authEnabled && !this.checkAuth(req)) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="Orchestrator"' },
      });
    }

    const url = new URL(req.url);
    const path = url.pathname;

    // GET / — serve built-in SPA
    if (path === "/" || path === "/index.html") {
      return new Response(this.getIndexHtml(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // GET /api/status
    if (path === "/api/status") {
      const uptimeMs = this.startedAt
        ? Date.now() - new Date(this.startedAt).getTime()
        : 0;
      return Response.json({
        uptime: uptimeMs,
        uptimeHuman: this.formatUptime(uptimeMs),
        clients: this.clients.size,
        sdkUrl: this.config.sdkServerUrl,
        startedAt: this.startedAt,
      });
    }

    // GET /api/clients
    if (path === "/api/clients") {
      const clientList = [...this.clients.values()].map((c) => ({
        id: c.id,
        subscribedEvents: [...c.subscribedEvents],
        connectedAt: c.connectedAt,
      }));
      return Response.json(clientList);
    }

    // GET /api/proxy/* — proxy to SDK server
    if (path.startsWith("/api/proxy/")) {
      const proxyPath = path.slice("/api/proxy".length);
      return this.proxyToSdk(proxyPath, req);
    }

    // GET /static/* — serve static files
    if (path.startsWith("/static/")) {
      return this.serveStatic(path.slice("/static/".length));
    }

    return new Response("Not Found", { status: 404 });
  }

  private handleWsOpen(ws: unknown, clientId: string): void {
    const client: WebSocketClient = {
      id: clientId,
      ws,
      subscribedEvents: new Set(["*"]),
      connectedAt: new Date().toISOString(),
    };
    this.clients.set(clientId, client);

    // Send welcome message
    const welcome = JSON.stringify({
      type: "connected",
      clientId,
      serverTime: new Date().toISOString(),
    });
    (ws as BunWebSocket).send(welcome);
  }

  private handleWsMessage(ws: unknown, clientId: string, message: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    let parsed: { type: string; events?: string[]; content?: string };
    try {
      parsed = JSON.parse(message);
    } catch {
      (ws as BunWebSocket).send(
        JSON.stringify({ type: "error", message: "Invalid JSON" }),
      );
      return;
    }

    switch (parsed.type) {
      case "subscribe": {
        const events = parsed.events ?? ["*"];
        client.subscribedEvents = new Set(events);
        (ws as BunWebSocket).send(
          JSON.stringify({
            type: "subscribed",
            events: [...client.subscribedEvents],
          }),
        );
        break;
      }

      case "unsubscribe": {
        const events = parsed.events ?? [];
        for (const evt of events) {
          client.subscribedEvents.delete(evt);
        }
        (ws as BunWebSocket).send(
          JSON.stringify({
            type: "unsubscribed",
            events: [...client.subscribedEvents],
          }),
        );
        break;
      }

      case "message": {
        // Relay message to all other clients
        const relay = JSON.stringify({
          type: "message",
          from: clientId,
          content: parsed.content ?? "",
          timestamp: new Date().toISOString(),
        });
        for (const [id, other] of this.clients) {
          if (id === clientId) continue;
          try {
            (other.ws as BunWebSocket).send(relay);
          } catch {
            // Client may be disconnected
          }
        }
        break;
      }

      case "ping": {
        (ws as BunWebSocket).send(
          JSON.stringify({ type: "pong", timestamp: new Date().toISOString() }),
        );
        break;
      }

      default: {
        (ws as BunWebSocket).send(
          JSON.stringify({ type: "error", message: `Unknown message type: ${parsed.type}` }),
        );
      }
    }
  }

  private handleWsClose(clientId: string): void {
    this.clients.delete(clientId);
  }

  broadcastEvent(eventType: string, data: unknown): void {
    const payload = JSON.stringify({
      type: "event",
      event: eventType,
      data,
      timestamp: new Date().toISOString(),
    });

    for (const [, client] of this.clients) {
      if (
        client.subscribedEvents.has("*") ||
        client.subscribedEvents.has(eventType)
      ) {
        try {
          (client.ws as BunWebSocket).send(payload);
        } catch {
          // Client may be disconnected
        }
      }
    }
  }

  sendToClient(clientId: string, eventType: string, data: unknown): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    const payload = JSON.stringify({
      type: "event",
      event: eventType,
      data,
      timestamp: new Date().toISOString(),
    });

    try {
      (client.ws as BunWebSocket).send(payload);
    } catch {
      // Client may be disconnected
    }
  }

  private getIndexHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Orchestrator</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0d1117;
    --bg-secondary: #161b22;
    --bg-tertiary: #21262d;
    --border: #30363d;
    --text: #c9d1d9;
    --text-muted: #8b949e;
    --accent: #58a6ff;
    --green: #3fb950;
    --red: #f85149;
    --yellow: #d29922;
    --mono: "SF Mono", "Cascadia Code", "Fira Code", "JetBrains Mono", Menlo, Consolas, monospace;
  }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--mono);
    font-size: 13px;
    line-height: 1.5;
    height: 100vh;
    display: flex;
    flex-direction: column;
  }

  /* Header */
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-secondary);
    flex-shrink: 0;
  }
  header h1 { font-size: 14px; font-weight: 600; color: var(--text); }
  .status-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 10px;
    border-radius: 12px;
    font-size: 11px;
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
  }
  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--red);
  }
  .status-dot.connected { background: var(--green); }

  /* Main layout */
  main {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* Info bar */
  .info-bar {
    display: flex;
    gap: 16px;
    padding: 6px 16px;
    font-size: 11px;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border);
    background: var(--bg-secondary);
    flex-shrink: 0;
  }
  .info-bar span { display: flex; align-items: center; gap: 4px; }

  /* Events panel */
  .events {
    flex: 1;
    overflow-y: auto;
    padding: 8px 16px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .events::-webkit-scrollbar { width: 6px; }
  .events::-webkit-scrollbar-track { background: transparent; }
  .events::-webkit-scrollbar-thumb {
    background: var(--bg-tertiary);
    border-radius: 3px;
  }
  .event-row {
    display: flex;
    gap: 10px;
    padding: 3px 8px;
    border-radius: 4px;
    white-space: pre-wrap;
    word-break: break-all;
  }
  .event-row:hover { background: var(--bg-secondary); }
  .event-time { color: var(--text-muted); flex-shrink: 0; }
  .event-type {
    color: var(--accent);
    font-weight: 600;
    flex-shrink: 0;
    min-width: 120px;
  }
  .event-data { color: var(--text); flex: 1; }
  .event-row.system .event-type { color: var(--yellow); }
  .event-row.error .event-type { color: var(--red); }
  .event-row.message .event-type { color: var(--green); }

  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    color: var(--text-muted);
    font-size: 12px;
  }

  /* Input bar */
  .input-bar {
    display: flex;
    padding: 8px 16px;
    gap: 8px;
    border-top: 1px solid var(--border);
    background: var(--bg-secondary);
    flex-shrink: 0;
  }
  .input-bar input {
    flex: 1;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px 12px;
    font-family: var(--mono);
    font-size: 13px;
    outline: none;
  }
  .input-bar input:focus { border-color: var(--accent); }
  .input-bar input::placeholder { color: var(--text-muted); }
  .input-bar button {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: 6px;
    padding: 6px 16px;
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .input-bar button:hover { opacity: 0.9; }
  .input-bar button:disabled { opacity: 0.4; cursor: default; }
</style>
</head>
<body>
  <header>
    <h1>orc / web</h1>
    <div class="status-badge">
      <div class="status-dot" id="statusDot"></div>
      <span id="statusText">disconnected</span>
    </div>
  </header>

  <div class="info-bar">
    <span id="infoUptime">uptime: --</span>
    <span id="infoClients">clients: 0</span>
    <span id="infoEvents">events: 0</span>
  </div>

  <main>
    <div class="events" id="events">
      <div class="empty-state" id="emptyState">waiting for events...</div>
    </div>
  </main>

  <div class="input-bar">
    <input type="text" id="msgInput" placeholder="send message..." autocomplete="off" />
    <button id="sendBtn" disabled>send</button>
  </div>

<script>
(function() {
  const eventsEl = document.getElementById("events");
  const emptyState = document.getElementById("emptyState");
  const statusDot = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");
  const infoUptime = document.getElementById("infoUptime");
  const infoClients = document.getElementById("infoClients");
  const infoEvents = document.getElementById("infoEvents");
  const msgInput = document.getElementById("msgInput");
  const sendBtn = document.getElementById("sendBtn");

  let ws = null;
  let eventCount = 0;
  let reconnectTimer = null;
  const MAX_EVENTS = 500;

  function connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(proto + "//" + location.host + "/ws");

    ws.onopen = function() {
      statusDot.classList.add("connected");
      statusText.textContent = "connected";
      sendBtn.disabled = false;
      addEvent("system", "connected", "WebSocket connection established");

      // Subscribe to all events
      ws.send(JSON.stringify({ type: "subscribe", events: ["*"] }));

      // Fetch server status
      fetchStatus();
    };

    ws.onclose = function() {
      statusDot.classList.remove("connected");
      statusText.textContent = "disconnected";
      sendBtn.disabled = true;
      addEvent("system", "disconnected", "WebSocket connection closed");

      // Reconnect after 3 seconds
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 3000);
    };

    ws.onerror = function() {
      // onclose will fire after onerror
    };

    ws.onmessage = function(e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      switch (msg.type) {
        case "connected":
          addEvent("system", "hello", "client id: " + msg.clientId);
          break;
        case "event":
          addEvent("event", msg.event, JSON.stringify(msg.data));
          break;
        case "message":
          addEvent("message", "msg:" + msg.from, msg.content);
          break;
        case "subscribed":
          addEvent("system", "subscribed", msg.events.join(", "));
          break;
        case "pong":
          addEvent("system", "pong", msg.timestamp);
          break;
        case "error":
          addEvent("error", "error", msg.message);
          break;
        default:
          addEvent("event", msg.type, JSON.stringify(msg));
      }
    };
  }

  function addEvent(cls, type, data) {
    if (emptyState) emptyState.remove();

    eventCount++;
    infoEvents.textContent = "events: " + eventCount;

    var row = document.createElement("div");
    row.className = "event-row " + cls;

    var time = document.createElement("span");
    time.className = "event-time";
    var d = new Date();
    time.textContent = d.toTimeString().slice(0, 8) + "." + String(d.getMilliseconds()).padStart(3, "0");

    var typeEl = document.createElement("span");
    typeEl.className = "event-type";
    typeEl.textContent = type;

    var dataEl = document.createElement("span");
    dataEl.className = "event-data";
    dataEl.textContent = data;

    row.appendChild(time);
    row.appendChild(typeEl);
    row.appendChild(dataEl);
    eventsEl.appendChild(row);

    // Limit displayed events
    while (eventsEl.children.length > MAX_EVENTS) {
      eventsEl.removeChild(eventsEl.firstChild);
    }

    // Auto-scroll to bottom
    eventsEl.scrollTop = eventsEl.scrollHeight;
  }

  function sendMessage() {
    var text = msgInput.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;

    ws.send(JSON.stringify({ type: "message", content: text }));
    addEvent("message", "you", text);
    msgInput.value = "";
  }

  function fetchStatus() {
    fetch("/api/status")
      .then(function(r) { return r.json(); })
      .then(function(data) {
        infoUptime.textContent = "uptime: " + (data.uptimeHuman || "--");
        infoClients.textContent = "clients: " + data.clients;
      })
      .catch(function() {});
  }

  // Refresh status periodically
  setInterval(fetchStatus, 5000);

  sendBtn.addEventListener("click", sendMessage);
  msgInput.addEventListener("keydown", function(e) {
    if (e.key === "Enter") sendMessage();
  });

  connect();
})();
</script>
</body>
</html>`;
  }

  private checkAuth(req: Request): boolean {
    const header = req.headers.get("Authorization");
    if (!header) return false;

    const parts = header.split(" ");
    if (parts.length !== 2 || parts[0] !== "Basic") return false;

    let decoded: string;
    try {
      decoded = atob(parts[1]);
    } catch {
      return false;
    }

    const colonIdx = decoded.indexOf(":");
    if (colonIdx === -1) return false;

    const username = decoded.slice(0, colonIdx);
    const password = decoded.slice(colonIdx + 1);

    return username === this.config.authUsername && password === this.config.authPassword;
  }

  private async proxyToSdk(path: string, req: Request): Promise<Response> {
    const targetUrl = `${this.config.sdkServerUrl}${path}`;

    try {
      const headers = new Headers(req.headers);
      headers.delete("host");

      const proxyReq: RequestInit = {
        method: req.method,
        headers,
      };

      if (req.method !== "GET" && req.method !== "HEAD") {
        proxyReq.body = req.body;
      }

      const resp = await fetch(targetUrl, proxyReq);

      // Forward response headers
      const respHeaders = new Headers(resp.headers);
      respHeaders.set("X-Proxy-Target", targetUrl);

      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: respHeaders,
      });
    } catch (err) {
      return Response.json(
        {
          error: "Proxy error",
          message: err instanceof Error ? err.message : "Failed to reach SDK server",
          target: targetUrl,
        },
        { status: 502 },
      );
    }
  }

  private async serveStatic(relativePath: string): Promise<Response> {
    // Prevent directory traversal
    const normalized = relativePath.replace(/\.\./g, "");
    const filePath = join(this.config.staticDir, normalized);

    try {
      const file = Bun.file(filePath);
      const exists = await file.exists();
      if (!exists) return new Response("Not Found", { status: 404 });

      const info = await stat(filePath);
      if (info.isDirectory()) return new Response("Not Found", { status: 404 });

      return new Response(file, {
        headers: { "Content-Type": this.getMimeType(filePath) },
      });
    } catch {
      return new Response("Not Found", { status: 404 });
    }
  }

  private getMimeType(filePath: string): string {
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    const mimeTypes: Record<string, string> = {
      html: "text/html; charset=utf-8",
      css: "text/css; charset=utf-8",
      js: "application/javascript; charset=utf-8",
      json: "application/json; charset=utf-8",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      svg: "image/svg+xml",
      ico: "image/x-icon",
      woff: "font/woff",
      woff2: "font/woff2",
      ttf: "font/ttf",
      txt: "text/plain; charset=utf-8",
    };
    return mimeTypes[ext] ?? "application/octet-stream";
  }

  private formatUptime(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
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

  getClientCount(): number {
    return this.clients.size;
  }
}
