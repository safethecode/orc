import { watch, type FSWatcher } from "node:fs";
import { EventEmitter } from "node:events";
import { resolve, relative } from "node:path";

export type FileChangeType = "add" | "change" | "unlink";

export interface FileChangeEvent {
  file: string;
  absolutePath: string;
  type: FileChangeType;
  timestamp: number;
}

export interface FileWatcherConfig {
  ignorePatterns: string[];
  debounceMs: number;
}

const DEFAULT_IGNORE = [
  "node_modules/**",
  ".git/**",
  "dist/**",
  "build/**",
  "*.log",
  ".DS_Store",
  "*.swp",
  "*.swo",
];

export class FileWatcher extends EventEmitter {
  private watchers: FSWatcher[] = [];
  private rootDir: string;
  private config: FileWatcherConfig;
  private debounceTimers: Map<string, Timer> = new Map();
  private running = false;

  constructor(rootDir: string, config?: Partial<FileWatcherConfig>) {
    super();
    this.rootDir = resolve(rootDir);
    this.config = {
      ignorePatterns: config?.ignorePatterns ?? DEFAULT_IGNORE,
      debounceMs: config?.debounceMs ?? 100,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    const watcher = watch(
      this.rootDir,
      { recursive: true },
      (eventType, filename) => {
        if (!filename) return;

        const relativePath = filename;
        const absolutePath = resolve(this.rootDir, relativePath);

        if (this.shouldIgnore(relativePath)) return;

        const existing = this.debounceTimers.get(relativePath);
        if (existing) clearTimeout(existing);

        const timer = setTimeout(async () => {
          this.debounceTimers.delete(relativePath);

          let changeType: FileChangeType;
          try {
            const stat = await Bun.file(absolutePath).exists();
            if (!stat) {
              changeType = "unlink";
            } else {
              changeType = eventType === "rename" ? "add" : "change";
            }
          } catch {
            changeType = "unlink";
          }

          const event: FileChangeEvent = {
            file: relativePath,
            absolutePath,
            type: changeType,
            timestamp: Date.now(),
          };

          this.emit("change", event);
        }, this.config.debounceMs);

        this.debounceTimers.set(relativePath, timer);
      },
    );

    this.watchers.push(watcher);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];

    this.debounceTimers.forEach((timer) => {
      clearTimeout(timer);
    });
    this.debounceTimers.clear();
  }

  private shouldIgnore(filePath: string): boolean {
    for (const pattern of this.config.ignorePatterns) {
      if (this.matchGlob(pattern, filePath)) return true;
    }
    return false;
  }

  private matchGlob(pattern: string, path: string): boolean {
    // Normalize separators to forward slash
    const normalized = path.replace(/\\/g, "/");

    // Handle ** (matches any depth of directories)
    if (pattern.includes("**")) {
      const parts = pattern.split("**");
      if (parts.length === 2) {
        const prefix = parts[0];
        const suffix = parts[1].replace(/^\//, "");

        // "dir/**" matches anything inside dir
        if (!suffix) {
          return normalized.startsWith(prefix) || normalized === prefix.replace(/\/$/, "");
        }

        // "**/*.ext" or "dir/**/file" style
        if (prefix) {
          if (!normalized.startsWith(prefix)) return false;
          const rest = normalized.slice(prefix.length);
          return this.matchSimpleGlob(suffix, rest);
        }

        // Leading **: match suffix anywhere in path
        const segments = normalized.split("/");
        for (let i = 0; i < segments.length; i++) {
          const subPath = segments.slice(i).join("/");
          if (this.matchSimpleGlob(suffix, subPath)) return true;
        }
        return false;
      }
    }

    // No **, do a simple glob match against the full path or the basename
    if (!pattern.includes("/")) {
      // Pattern without slash matches against filename only
      const basename = normalized.split("/").pop() ?? normalized;
      return this.matchSimpleGlob(pattern, basename);
    }

    return this.matchSimpleGlob(pattern, normalized);
  }

  private matchSimpleGlob(pattern: string, str: string): boolean {
    // Convert simple glob to regex: * matches anything except /, ? matches single char
    let regex = "^";
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i];
      if (c === "*") {
        regex += "[^/]*";
      } else if (c === "?") {
        regex += "[^/]";
      } else if (".+^${}()|[]\\".includes(c)) {
        regex += "\\" + c;
      } else {
        regex += c;
      }
    }
    regex += "$";

    try {
      return new RegExp(regex).test(str);
    } catch {
      return false;
    }
  }

  get isRunning(): boolean {
    return this.running;
  }
}
