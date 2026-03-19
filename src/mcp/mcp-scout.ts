import { spawn } from "node:child_process";
import { MCP_CATALOG, getCatalogEntry, getCatalogText, type McpCatalogEntry } from "./catalog.ts";

export interface McpScoutResult {
  needed: boolean;
  servers: McpCatalogEntry[];
  durationMs: number;
}

const TIMEOUT_MS = 5000;
const MAX_SERVERS = 3;

export async function scoutMcp(
  input: string,
  signal?: AbortSignal,
): Promise<McpScoutResult> {
  const start = Date.now();

  if (MCP_CATALOG.length === 0) {
    return { needed: false, servers: [], durationMs: Date.now() - start };
  }

  const catalogText = getCatalogText();

  const prompt = `You are an MCP server matcher. Given a user request and a list of available MCP servers, decide if any server would help complete the task.

User request: ${input}

Available MCP servers:
${catalogText}

Respond with ONLY a JSON object (no markdown, no explanation):
{"needed": true/false, "servers": ["server-name"]}

Rules:
- Maximum ${MAX_SERVERS} servers
- Only pick servers clearly needed for the task
- Servers marked [requires ENV_VAR] need that env variable — only pick if the task clearly needs that service
- For pure coding/refactoring tasks that don't need external services, return {"needed": false, "servers": []}
- "git" server is useful when user mentions git operations, repo history, or branching
- "fetch" server is useful when user needs to access web URLs or documentation
- "filesystem" is rarely needed since the agent already has file access`;

  try {
    const text = await runHaiku(prompt, signal);
    const parsed = parseJson(text);

    if (!parsed || !parsed.needed) {
      return { needed: false, servers: [], durationMs: Date.now() - start };
    }

    const names: string[] = Array.isArray(parsed.servers)
      ? parsed.servers.slice(0, MAX_SERVERS)
      : [];

    // Filter: entry must exist and env hint must be satisfied
    const entries = names
      .map(n => getCatalogEntry(n))
      .filter((e): e is McpCatalogEntry => {
        if (!e) return false;
        if (e.envHint && !process.env[e.envHint]) return false;
        return true;
      });

    return {
      needed: entries.length > 0,
      servers: entries,
      durationMs: Date.now() - start,
    };
  } catch {
    return { needed: false, servers: [], durationMs: Date.now() - start };
  }
}

function runHaiku(prompt: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("claude", [
      "-p", prompt,
      "--model", "sonnet",
      "--max-turns", "5",
    ], { stdio: ["ignore", "pipe", "pipe"], signal });

    const chunks: Buffer[] = [];
    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("mcp scout timeout"));
    }, TIMEOUT_MS);

    proc.on("close", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf-8").trim());
    });

    proc.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function parseJson(text: string): { needed: boolean; servers: string[] } | null {
  try {
    return JSON.parse(text);
  } catch { /* continue */ }

  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch { /* fall through */ }
  }

  return null;
}
