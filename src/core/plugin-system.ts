import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";

export type PluginEvent =
  | "session:start" | "session:end"
  | "message:before" | "message:after"
  | "tool:before" | "tool:after"
  | "agent:start" | "agent:end"
  | "edit:after" | "write:after"
  | "compaction:before" | "compaction:after"
  | "error:recover";

export interface PluginHook {
  event: PluginEvent;
  handler: (context: PluginHookContext) => Promise<void | string>;
  priority?: number; // lower = runs first, default 100
}

export interface PluginHookContext {
  event: PluginEvent;
  data: Record<string, unknown>;
  projectDir: string;
  sessionId?: string;
  agentName?: string;
  /** Plugins can set this to modify behavior */
  modified?: Record<string, unknown>;
}

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  hooks: PluginHook[];
  tools?: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    handler: (args: Record<string, unknown>) => Promise<string>;
  }>;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  sourcePath: string;
  enabled: boolean;
}

interface RegisteredHook {
  pluginName: string;
  hook: PluginHook;
}

function isPluginManifest(obj: unknown): obj is PluginManifest {
  if (obj === null || typeof obj !== "object") return false;
  const candidate = obj as Record<string, unknown>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.version === "string" &&
    typeof candidate.description === "string" &&
    Array.isArray(candidate.hooks)
  );
}

export class PluginManager {
  private plugins: Map<string, LoadedPlugin> = new Map();
  private hooks: Map<PluginEvent, RegisteredHook[]> = new Map();
  private searchPaths: string[];

  constructor(projectDir: string) {
    this.searchPaths = [
      join(projectDir, ".orchestrator", "plugins"),
      join(process.env.HOME ?? "", ".orchestrator", "plugins"),
    ];
  }

  /** Load all plugins from search paths */
  async loadAll(): Promise<number> {
    this.plugins.clear();
    this.hooks.clear();

    for (const searchPath of this.searchPaths) {
      if (!existsSync(searchPath)) continue;

      // Load single-file plugins (*.ts, *.js)
      const glob = new Bun.Glob("*.{ts,js}");
      for await (const entry of glob.scan({ cwd: searchPath, absolute: true })) {
        await this.loadPlugin(entry);
      }

      // Load directory plugins (dirs with index.ts or index.js)
      try {
        const entries = readdirSync(searchPath, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const dirPath = join(searchPath, entry.name);
          const indexTs = join(dirPath, "index.ts");
          const indexJs = join(dirPath, "index.js");
          if (existsSync(indexTs)) {
            await this.loadPlugin(indexTs);
          } else if (existsSync(indexJs)) {
            await this.loadPlugin(indexJs);
          }
        }
      } catch {
        // Ignore errors reading directory contents
      }
    }

    return this.plugins.size;
  }

  private async loadPlugin(filePath: string): Promise<void> {
    try {
      const mod = await import(`${filePath}?t=${Date.now()}`);
      const manifest: unknown = mod.default ?? mod;

      if (!isPluginManifest(manifest)) return;

      const loaded: LoadedPlugin = {
        manifest,
        sourcePath: filePath,
        enabled: true,
      };

      this.plugins.set(manifest.name, loaded);
      this.registerHooks(manifest);
    } catch {
      // One broken plugin should not prevent others from loading
    }
  }

  private registerHooks(manifest: PluginManifest): void {
    for (const hook of manifest.hooks) {
      const event = hook.event;
      if (!this.hooks.has(event)) {
        this.hooks.set(event, []);
      }
      const list = this.hooks.get(event)!;
      list.push({ pluginName: manifest.name, hook });
      // Sort by priority (lower = first); default priority is 100
      list.sort((a, b) => (a.hook.priority ?? 100) - (b.hook.priority ?? 100));
    }
  }

  /** Execute all hooks for an event, in priority order */
  async emit(
    event: PluginEvent,
    context: Omit<PluginHookContext, "event">,
  ): Promise<PluginHookContext> {
    const fullContext: PluginHookContext = { ...context, event };
    const registeredHooks = this.hooks.get(event);
    if (!registeredHooks || registeredHooks.length === 0) return fullContext;

    for (const { pluginName, hook } of registeredHooks) {
      // Skip hooks from disabled plugins
      const plugin = this.plugins.get(pluginName);
      if (!plugin || !plugin.enabled) continue;

      try {
        await hook.handler(fullContext);
      } catch {
        // One failing hook should not break others
      }
    }

    return fullContext;
  }

  /** Get a plugin by name */
  get(name: string): LoadedPlugin | undefined {
    return this.plugins.get(name);
  }

  /** Enable or disable a plugin. Returns true if the plugin was found. */
  setEnabled(name: string, enabled: boolean): boolean {
    const plugin = this.plugins.get(name);
    if (!plugin) return false;
    plugin.enabled = enabled;
    return true;
  }

  /** List all loaded plugins with summary info */
  list(): Array<{
    name: string;
    version: string;
    description: string;
    enabled: boolean;
    hookCount: number;
  }> {
    return Array.from(this.plugins.values()).map((p) => ({
      name: p.manifest.name,
      version: p.manifest.version,
      description: p.manifest.description,
      enabled: p.enabled,
      hookCount: p.manifest.hooks.length,
    }));
  }

  /** Get tools provided by all enabled plugins */
  getPluginTools(): Array<{
    pluginName: string;
    name: string;
    description: string;
  }> {
    const results: Array<{ pluginName: string; name: string; description: string }> = [];

    for (const plugin of this.plugins.values()) {
      if (!plugin.enabled) continue;
      if (!plugin.manifest.tools) continue;

      for (const tool of plugin.manifest.tools) {
        results.push({
          pluginName: plugin.manifest.name,
          name: tool.name,
          description: tool.description,
        });
      }
    }

    return results;
  }

  /** Reload all plugins from search paths */
  async reload(): Promise<number> {
    return this.loadAll();
  }
}
