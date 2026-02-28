import { basename, join } from "node:path";
import { existsSync } from "node:fs";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<string>;
}

export interface ToolContext {
  projectDir: string;
  agentName: string;
  sessionId: string;
}

export interface LoadedTool {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  sourcePath: string;
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<string>;
}

function isToolDefinition(obj: unknown): obj is ToolDefinition {
  if (obj === null || typeof obj !== "object") return false;
  const candidate = obj as Record<string, unknown>;
  return (
    typeof candidate.description === "string" &&
    typeof candidate.execute === "function" &&
    candidate.parameters !== null &&
    typeof candidate.parameters === "object"
  );
}

export class CustomToolLoader {
  private tools: Map<string, LoadedTool> = new Map();
  private searchPaths: string[];

  constructor(projectDir: string) {
    this.searchPaths = [
      join(projectDir, ".orchestrator", "tools"),
      join(projectDir, "tools"),
      join(process.env.HOME ?? "", ".orchestrator", "tools"),
    ];
  }

  /** Scan all search paths and load tool definitions */
  async loadAll(): Promise<number> {
    this.tools.clear();

    for (const searchPath of this.searchPaths) {
      if (!existsSync(searchPath)) continue;

      const glob = new Bun.Glob("*.{ts,js}");
      for await (const entry of glob.scan({ cwd: searchPath, absolute: true })) {
        await this.loadFile(entry);
      }
    }

    return this.tools.size;
  }

  private async loadFile(filePath: string): Promise<void> {
    try {
      // Bust module cache on reload by appending a query param
      const mod = await import(`${filePath}?t=${Date.now()}`);
      const fileBaseName = basename(filePath).replace(/\.(ts|js)$/, "");

      // Check default export first
      if (mod.default) {
        if (isToolDefinition(mod.default)) {
          this.registerTool(mod.default, fileBaseName, filePath);
        }
      }

      // Check all named exports
      for (const [exportName, exportValue] of Object.entries(mod)) {
        if (exportName === "default") continue;
        if (!isToolDefinition(exportValue)) continue;

        const toolName = exportValue.name
          ? exportValue.name
          : `${fileBaseName}_${exportName}`;
        this.registerTool(exportValue, toolName, filePath);
      }

      // If only a default export that is a tool definition, it was handled above.
      // If default export was not a tool but has no named exports, nothing to load.
    } catch {
      // One broken tool file should not prevent others from loading
    }
  }

  private registerTool(
    def: ToolDefinition,
    fallbackName: string,
    sourcePath: string,
  ): void {
    const name = def.name || fallbackName;
    this.tools.set(name, {
      name,
      description: def.description,
      parameters: def.parameters,
      sourcePath,
      execute: def.execute,
    });
  }

  /** Get a tool by name */
  get(name: string): LoadedTool | undefined {
    return this.tools.get(name);
  }

  /** List all loaded tools */
  list(): LoadedTool[] {
    return Array.from(this.tools.values());
  }

  /** Execute a tool by name */
  async execute(
    name: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return `Error: tool "${name}" not found`;
    }

    // Validate required parameters
    for (const [paramName, paramDef] of Object.entries(tool.parameters)) {
      if (paramDef.required && !(paramName in args)) {
        return `Error: missing required parameter "${paramName}" for tool "${name}"`;
      }
    }

    try {
      return await tool.execute(args, context);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error executing tool "${name}": ${message}`;
    }
  }

  /** Format tools for injection into a system prompt */
  formatForPrompt(): string {
    const tools = this.list();
    if (tools.length === 0) return "";

    const lines: string[] = ["Available Custom Tools:"];

    for (const tool of tools) {
      lines.push(`- ${tool.name}: ${tool.description}`);

      const params = Object.entries(tool.parameters);
      if (params.length > 0) {
        const paramDescriptions = params.map(([pName, pDef]) => {
          const req = pDef.required ? ", required" : "";
          return `${pName} (${pDef.type}${req})`;
        });
        lines.push(`  Parameters: ${paramDescriptions.join(", ")}`);
      }
    }

    return lines.join("\n");
  }

  /** Reload tools (for hot-reload on file change) */
  async reload(): Promise<number> {
    return this.loadAll();
  }

  /** Add an additional search path */
  addSearchPath(path: string): void {
    if (!this.searchPaths.includes(path)) {
      this.searchPaths.push(path);
    }
  }
}
