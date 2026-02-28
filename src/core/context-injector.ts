import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";

export interface ContextFile {
  path: string;
  content: string;
  directory: string;
  filename: string;
}

interface CacheEntry {
  files: ContextFile[];
  mtime: number;
}

export class ContextInjector {
  private cache: Map<string, CacheEntry> = new Map();
  private targetFiles = ["AGENTS.md", "CLAUDE.md", "CONVENTIONS.md"];
  private maxContentLength = 500; // max lines per file
  private projectRoot: string;

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot ?? process.cwd();
  }

  collect(filePath?: string): ContextFile[] {
    const startDir = filePath ? dirname(resolve(filePath)) : this.projectRoot;
    const results: ContextFile[] = [];
    const seen = new Set<string>();

    // Walk from startDir up to projectRoot (inclusive)
    let current = resolve(startDir);
    const root = resolve(this.projectRoot);

    while (true) {
      const dirFiles = this.collectFromDirectory(current);
      for (const file of dirFiles) {
        if (!seen.has(file.path)) {
          seen.add(file.path);
          results.push(file);
        }
      }

      // Stop if we've reached (or passed) the project root
      if (current === root || !current.startsWith(root)) break;

      const parent = dirname(current);
      // Prevent infinite loop at filesystem root
      if (parent === current) break;
      current = parent;
    }

    // If startDir was above projectRoot, we still want projectRoot context
    if (!seen.has(root)) {
      const rootFiles = this.collectFromDirectory(root);
      for (const file of rootFiles) {
        if (!seen.has(file.path)) {
          seen.add(file.path);
          results.push(file);
        }
      }
    }

    // Collect global context files
    const globalFiles = this.collectGlobal();
    for (const file of globalFiles) {
      if (!seen.has(file.path)) {
        seen.add(file.path);
        results.push(file);
      }
    }

    return results;
  }

  private collectFromDirectory(dir: string): ContextFile[] {
    // Check cache validity
    const cached = this.cache.get(dir);
    if (cached) {
      // Verify cache is still fresh by checking mtimes
      let stillFresh = true;
      for (const target of this.targetFiles) {
        const filePath = join(dir, target);
        if (existsSync(filePath)) {
          try {
            const stat = statSync(filePath);
            if (stat.mtimeMs > cached.mtime) {
              stillFresh = false;
              break;
            }
          } catch {
            stillFresh = false;
            break;
          }
        }
      }
      if (stillFresh) return cached.files;
    }

    const files: ContextFile[] = [];
    const now = Date.now();

    for (const target of this.targetFiles) {
      const filePath = join(dir, target);
      if (!existsSync(filePath)) continue;

      try {
        const raw = readFileSync(filePath, "utf-8");
        const lines = raw.split("\n");
        const truncated = lines.length > this.maxContentLength
          ? lines.slice(0, this.maxContentLength).join("\n") + "\n...(truncated)"
          : raw;

        files.push({
          path: filePath,
          content: truncated,
          directory: dir,
          filename: basename(filePath),
        });
      } catch {
        // Skip unreadable files
      }
    }

    this.cache.set(dir, { files, mtime: now });
    return files;
  }

  private collectGlobal(): ContextFile[] {
    const home = process.env.HOME;
    if (!home) return [];

    const globalDir = join(home, ".orchestrator");
    if (!existsSync(globalDir)) return [];

    const files: ContextFile[] = [];

    for (const target of this.targetFiles) {
      const filePath = join(globalDir, target);
      if (!existsSync(filePath)) continue;

      try {
        const raw = readFileSync(filePath, "utf-8");
        const lines = raw.split("\n");
        const truncated = lines.length > this.maxContentLength
          ? lines.slice(0, this.maxContentLength).join("\n") + "\n...(truncated)"
          : raw;

        files.push({
          path: filePath,
          content: truncated,
          directory: globalDir,
          filename: basename(filePath),
        });
      } catch {
        // Skip unreadable files
      }
    }

    return files;
  }

  formatForPrompt(files?: ContextFile[]): string {
    const contextFiles = files ?? this.collect();
    if (contextFiles.length === 0) return "";

    const sections = contextFiles.map((file) => {
      return `---\n# ${file.filename} (${file.directory})\n${file.content}\n---`;
    });

    return `Project Context:\n${sections.join("\n")}`;
  }

  invalidate(directory: string): void {
    const resolved = resolve(directory);
    this.cache.delete(resolved);
  }

  clearCache(): void {
    this.cache.clear();
  }

  setProjectRoot(root: string): void {
    this.projectRoot = resolve(root);
    this.clearCache();
  }
}
