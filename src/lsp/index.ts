import { LspClient } from "./client.ts";
import {
  BUILT_IN_SERVERS,
  detectServerForFile,
  findProjectRoot,
  isServerInstalled,
} from "./servers.ts";
import type { LspServerDef } from "./servers.ts";

export interface LspDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source: string;
}

export interface LspSymbol {
  name: string;
  kind: string;
  file: string;
  line: number;
  column: number;
}

export interface LspLocation {
  file: string;
  line: number;
  column: number;
}

/** Map from LSP SymbolKind numeric values to human-readable names */
const SYMBOL_KIND_MAP: Record<number, string> = {
  1: "File",
  2: "Module",
  3: "Namespace",
  4: "Package",
  5: "Class",
  6: "Method",
  7: "Property",
  8: "Field",
  9: "Constructor",
  10: "Enum",
  11: "Interface",
  12: "Function",
  13: "Variable",
  14: "Constant",
  15: "String",
  16: "Number",
  17: "Boolean",
  18: "Array",
  19: "Object",
  20: "Key",
  21: "Null",
  22: "EnumMember",
  23: "Struct",
  24: "Event",
  25: "Operator",
  26: "TypeParameter",
};

/** Map from LSP DiagnosticSeverity numeric values to string labels */
const SEVERITY_MAP: Record<number, LspDiagnostic["severity"]> = {
  1: "error",
  2: "warning",
  3: "info",
  4: "hint",
};

export class LspManager {
  private clients: Map<string, LspClient> = new Map();
  private brokenServers: Set<string> = new Set();
  private projectDir: string;
  private customServers: LspServerDef[] = [];
  private diagnosticsCache: Map<string, LspDiagnostic[]> = new Map();

  constructor(projectDir: string) {
    this.projectDir = projectDir;
  }

  /**
   * Get or start an LSP client for the given file. Returns null if no
   * server matches, the server is broken, or it cannot be started.
   */
  async getClientForFile(filePath: string): Promise<LspClient | null> {
    // Try custom servers first, then built-in
    const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
    let serverDef: LspServerDef | undefined = this.customServers.find((s) =>
      s.extensions.includes(ext),
    );
    if (!serverDef) {
      serverDef = detectServerForFile(filePath);
    }
    if (!serverDef) return null;

    // Already running?
    const existing = this.clients.get(serverDef.name);
    if (existing?.isRunning) return existing;

    // Previously failed?
    if (this.brokenServers.has(serverDef.name)) return null;

    // Check installation
    const installed = await isServerInstalled(serverDef);
    if (!installed) {
      this.brokenServers.add(serverDef.name);
      return null;
    }

    // Find project root for initialization
    const root =
      findProjectRoot(filePath, serverDef.rootMarkers) ?? this.projectDir;
    const rootUri = this.fileToUri(root);

    // Start the client
    const client = new LspClient(serverDef.name);
    const started = await client.start(serverDef.command);
    if (!started) {
      this.brokenServers.add(serverDef.name);
      return null;
    }

    // Listen for diagnostics notifications
    client.on("notification", (notification: { method: string; params: unknown }) => {
      if (notification.method === "textDocument/publishDiagnostics") {
        this.handleDiagnostics(notification.params);
      }
    });

    try {
      await client.initialize(rootUri);
    } catch {
      this.brokenServers.add(serverDef.name);
      try {
        await client.shutdown();
      } catch {
        // ignore
      }
      return null;
    }

    this.clients.set(serverDef.name, client);
    return client;
  }

  /** Go to the definition of the symbol at the given position */
  async gotoDefinition(
    file: string,
    line: number,
    column: number,
  ): Promise<LspLocation | null> {
    const client = await this.getClientForFile(file);
    if (!client) return null;

    try {
      const result = await client.request<unknown>("textDocument/definition", {
        textDocument: { uri: this.fileToUri(file) },
        position: { line, character: column },
      });

      return this.parseLocation(result);
    } catch {
      return null;
    }
  }

  /** Find all references of the symbol at the given position */
  async findReferences(
    file: string,
    line: number,
    column: number,
  ): Promise<LspLocation[]> {
    const client = await this.getClientForFile(file);
    if (!client) return [];

    try {
      const result = await client.request<unknown>("textDocument/references", {
        textDocument: { uri: this.fileToUri(file) },
        position: { line, character: column },
        context: { includeDeclaration: true },
      });

      return this.parseLocations(result);
    } catch {
      return [];
    }
  }

  /** Get hover information at the given position */
  async hover(
    file: string,
    line: number,
    column: number,
  ): Promise<string | null> {
    const client = await this.getClientForFile(file);
    if (!client) return null;

    try {
      const result = await client.request<unknown>("textDocument/hover", {
        textDocument: { uri: this.fileToUri(file) },
        position: { line, character: column },
      });

      if (!result || typeof result !== "object") return null;

      const hover = result as { contents?: unknown };
      if (!hover.contents) return null;

      return this.extractHoverText(hover.contents);
    } catch {
      return null;
    }
  }

  /** Get document symbols for the given file */
  async documentSymbols(file: string): Promise<LspSymbol[]> {
    const client = await this.getClientForFile(file);
    if (!client) return [];

    try {
      const result = await client.request<unknown>(
        "textDocument/documentSymbol",
        {
          textDocument: { uri: this.fileToUri(file) },
        },
      );

      if (!Array.isArray(result)) return [];

      return this.flattenSymbols(result, file);
    } catch {
      return [];
    }
  }

  /** Get diagnostics for the given file from the cache */
  async getDiagnostics(file: string): Promise<LspDiagnostic[]> {
    // Ensure the client is running so diagnostics can be pushed
    await this.getClientForFile(file);

    // Notify the server that we opened the file so it publishes diagnostics
    const client = await this.getClientForFile(file);
    if (client) {
      try {
        const { readFileSync } = await import("node:fs");
        const text = readFileSync(file, "utf-8");
        client.notify("textDocument/didOpen", {
          textDocument: {
            uri: this.fileToUri(file),
            languageId: this.guessLanguageId(file),
            version: 1,
            text,
          },
        });

        // Give the server a brief moment to publish diagnostics
        await new Promise((r) => setTimeout(r, 500));
      } catch {
        // File unreadable or notification failed — fall through
      }
    }

    const uri = this.fileToUri(file);
    return this.diagnosticsCache.get(uri) ?? [];
  }

  /** Register a custom LSP server definition */
  registerServer(def: LspServerDef): void {
    this.customServers.push(def);
    // Clear broken status in case user re-registers after fixing
    this.brokenServers.delete(def.name);
  }

  /** Shutdown all running LSP servers */
  async shutdownAll(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const client of this.clients.values()) {
      promises.push(
        client.shutdown().catch(() => {
          /* ignore */
        }),
      );
    }
    await Promise.all(promises);
    this.clients.clear();
    this.diagnosticsCache.clear();
  }

  /** List names of all currently active LSP servers */
  listActive(): string[] {
    const active: string[] = [];
    for (const [name, client] of this.clients) {
      if (client.isRunning) active.push(name);
    }
    return active;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private fileToUri(file: string): string {
    return `file://${file}`;
  }

  private uriToFile(uri: string): string {
    return uri.replace("file://", "");
  }

  /** Handle textDocument/publishDiagnostics notifications */
  private handleDiagnostics(params: unknown): void {
    if (!params || typeof params !== "object") return;

    const p = params as {
      uri?: string;
      diagnostics?: Array<{
        range?: { start?: { line?: number; character?: number } };
        severity?: number;
        message?: string;
        source?: string;
      }>;
    };

    if (!p.uri || !Array.isArray(p.diagnostics)) return;

    const diags: LspDiagnostic[] = p.diagnostics.map((d) => ({
      file: this.uriToFile(p.uri!),
      line: d.range?.start?.line ?? 0,
      column: d.range?.start?.character ?? 0,
      severity: SEVERITY_MAP[d.severity ?? 4] ?? "hint",
      message: d.message ?? "",
      source: d.source ?? "",
    }));

    this.diagnosticsCache.set(p.uri, diags);
  }

  /**
   * Parse a single Location or the first element of a Location[] from an LSP
   * definition/declaration response.
   */
  private parseLocation(result: unknown): LspLocation | null {
    if (!result) return null;

    // Could be a single Location, a Location[], or a LocationLink[]
    const item = Array.isArray(result) ? result[0] : result;
    if (!item || typeof item !== "object") return null;

    const loc = item as {
      uri?: string;
      targetUri?: string;
      range?: { start?: { line?: number; character?: number } };
      targetRange?: { start?: { line?: number; character?: number } };
    };

    const uri = loc.uri ?? loc.targetUri;
    const range = loc.range ?? loc.targetRange;

    if (!uri) return null;

    return {
      file: this.uriToFile(uri),
      line: range?.start?.line ?? 0,
      column: range?.start?.character ?? 0,
    };
  }

  /** Parse a Location[] from an LSP references response */
  private parseLocations(result: unknown): LspLocation[] {
    if (!Array.isArray(result)) return [];

    const locations: LspLocation[] = [];
    for (const item of result) {
      if (!item || typeof item !== "object") continue;

      const loc = item as {
        uri?: string;
        range?: { start?: { line?: number; character?: number } };
      };

      if (!loc.uri) continue;

      locations.push({
        file: this.uriToFile(loc.uri),
        line: loc.range?.start?.line ?? 0,
        column: loc.range?.start?.character ?? 0,
      });
    }
    return locations;
  }

  /** Extract plaintext from an LSP Hover contents value */
  private extractHoverText(contents: unknown): string | null {
    // MarkedString — plain string
    if (typeof contents === "string") return contents;

    // MarkupContent — { kind, value }
    if (
      typeof contents === "object" &&
      contents !== null &&
      "value" in (contents as Record<string, unknown>)
    ) {
      return (contents as { value: string }).value;
    }

    // MarkedString[] — array of strings or { language, value }
    if (Array.isArray(contents)) {
      const parts: string[] = [];
      for (const part of contents) {
        if (typeof part === "string") {
          parts.push(part);
        } else if (
          typeof part === "object" &&
          part !== null &&
          "value" in (part as Record<string, unknown>)
        ) {
          parts.push((part as { value: string }).value);
        }
      }
      return parts.length > 0 ? parts.join("\n") : null;
    }

    return null;
  }

  /**
   * Flatten document symbols, handling both SymbolInformation[] and
   * DocumentSymbol[] (which can be hierarchical).
   */
  private flattenSymbols(
    items: unknown[],
    file: string,
  ): LspSymbol[] {
    const symbols: LspSymbol[] = [];

    for (const item of items) {
      if (!item || typeof item !== "object") continue;

      const sym = item as {
        name?: string;
        kind?: number;
        range?: { start?: { line?: number; character?: number } };
        location?: {
          uri?: string;
          range?: { start?: { line?: number; character?: number } };
        };
        selectionRange?: { start?: { line?: number; character?: number } };
        children?: unknown[];
      };

      const name = sym.name ?? "";
      const kind = SYMBOL_KIND_MAP[sym.kind ?? 0] ?? "Unknown";

      // DocumentSymbol has range/selectionRange; SymbolInformation has location
      let line = 0;
      let column = 0;
      let symbolFile = file;

      if (sym.selectionRange?.start) {
        line = sym.selectionRange.start.line ?? 0;
        column = sym.selectionRange.start.character ?? 0;
      } else if (sym.range?.start) {
        line = sym.range.start.line ?? 0;
        column = sym.range.start.character ?? 0;
      } else if (sym.location) {
        if (sym.location.uri) symbolFile = this.uriToFile(sym.location.uri);
        line = sym.location.range?.start?.line ?? 0;
        column = sym.location.range?.start?.character ?? 0;
      }

      symbols.push({ name, kind, file: symbolFile, line, column });

      // Recurse into children (DocumentSymbol hierarchy)
      if (Array.isArray(sym.children) && sym.children.length > 0) {
        symbols.push(...this.flattenSymbols(sym.children, file));
      }
    }

    return symbols;
  }

  /** Guess a languageId string from a file path for didOpen notifications */
  private guessLanguageId(file: string): string {
    const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
    const map: Record<string, string> = {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".jsx": "javascriptreact",
      ".mjs": "javascript",
      ".cjs": "javascript",
      ".py": "python",
      ".pyi": "python",
      ".go": "go",
      ".rs": "rust",
      ".c": "c",
      ".h": "c",
      ".cpp": "cpp",
      ".hpp": "cpp",
      ".cc": "cpp",
      ".cxx": "cpp",
      ".hxx": "cpp",
      ".sh": "shellscript",
      ".bash": "shellscript",
      ".zsh": "shellscript",
      ".yaml": "yaml",
      ".yml": "yaml",
      ".css": "css",
      ".scss": "scss",
      ".less": "less",
      ".svelte": "svelte",
      ".vue": "vue",
    };
    return map[ext] ?? "plaintext";
  }
}

export { LspClient } from "./client.ts";
export type { LspServerDef } from "./servers.ts";
export {
  BUILT_IN_SERVERS,
  detectServerForFile,
  findProjectRoot,
  isServerInstalled,
} from "./servers.ts";
