import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpConfig } from "../config/types.ts";

export interface McpToolInfo {
  serverName: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export class McpClientManager {
  private clients = new Map<string, Client>();
  private transports = new Map<string, StdioClientTransport>();
  private toolCache: McpToolInfo[] = [];
  private config: McpConfig | null = null;

  async connect(config: McpConfig): Promise<void> {
    this.config = config;
    const entries = Object.entries(config.servers);
    if (entries.length === 0) return;

    for (const [name, serverConfig] of entries) {
      try {
        const transport = new StdioClientTransport({
          command: serverConfig.command,
          args: serverConfig.args,
          env: serverConfig.env,
          stderr: "pipe",
        });

        const client = new Client(
          { name: "orc", version: "0.1.0" },
        );

        await client.connect(transport);

        const { tools } = await client.listTools();
        for (const tool of tools) {
          this.toolCache.push({
            serverName: name,
            name: tool.name,
            description: tool.description ?? "",
            inputSchema: tool.inputSchema as Record<string, unknown>,
          });
        }

        this.clients.set(name, client);
        this.transports.set(name, transport);
      } catch {
        // Graceful skip — don't block orc startup for a single server failure
      }
    }
  }

  getConnectedServers(): string[] {
    return [...this.clients.keys()];
  }

  getTools(serverNames?: string[]): McpToolInfo[] {
    if (!serverNames) return [...this.toolCache];
    return this.toolCache.filter(t => serverNames.includes(t.serverName));
  }

  getToolCount(): number {
    return this.toolCache.length;
  }

  formatToolsForPrompt(serverNames?: string[]): string {
    const tools = this.getTools(serverNames);
    if (tools.length === 0) return "";

    const lines = tools.map(t => {
      const params = t.inputSchema.properties
        ? Object.keys(t.inputSchema.properties as Record<string, unknown>).join(", ")
        : "";
      return `- ${t.name}(${params}): ${t.description}`;
    });

    return `## Available MCP Tools\n\nThe following external tools are available via MCP servers. You can reference them in your response when relevant.\n\n${lines.join("\n")}`;
  }

  generateMcpConfigJson(serverNames?: string[]): string | null {
    if (!this.config) return null;

    const names = serverNames ?? [...this.clients.keys()];
    if (names.length === 0) return null;

    const mcpServers: Record<string, { command: string; args?: string[] }> = {};
    for (const name of names) {
      const server = this.config.servers[name];
      if (!server) continue;
      mcpServers[name] = {
        command: server.command,
        args: server.args,
      };
    }

    if (Object.keys(mcpServers).length === 0) return null;

    const configObj = { mcpServers };
    const tmpPath = join(tmpdir(), `orc-mcp-${Date.now()}.json`);
    writeFileSync(tmpPath, JSON.stringify(configObj, null, 2));
    return tmpPath;
  }

  async disconnect(): Promise<void> {
    for (const [name, client] of this.clients) {
      try {
        await client.close();
      } catch { /* already dead */ }
      this.clients.delete(name);
      this.transports.delete(name);
    }
    this.toolCache = [];
    this.config = null;
  }
}
