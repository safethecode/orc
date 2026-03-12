// ── Codebase Content Collector ────────────────────────────────────────
// Collects actual source file contents and formats them for system prompt
// injection, so agents can reference code without Read tool calls.
// Cached in-memory, invalidated when git HEAD changes.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";

// ── Types ────────────────────────────────────────────────────────────

export interface CollectedFile {
  path: string;
  content: string;
  lines: number;
  truncated: boolean;
  size: number;
}

export interface CodebaseContent {
  files: CollectedFile[];
  totalChars: number;
  omittedFiles: string[];
}

// ── Constants ────────────────────────────────────────────────────────

const MAX_LINES_PER_FILE = 500;
const MAX_FILE_SIZE = 50 * 1024; // 50KB
const TOTAL_CHAR_BUDGET = 150_000; // ~43K tokens

const INCLUDE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx",
  ".py", ".go", ".rs", ".java", ".rb",
  ".css", ".scss", ".html",
  ".json", ".yaml", ".yml", ".toml",
  ".md",
]);

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt",
  "__pycache__", ".venv", "venv", "target", "vendor",
  ".DS_Store", ".cache", ".turbo", ".parcel-cache",
  "coverage", ".nyc_output", ".svelte-kit", ".output",
  ".vercel", ".netlify", "out", ".expo",
]);

const IGNORE_PATTERNS = [
  /\.lock$/,
  /\.map$/,
  /\.min\./,
  /\.d\.ts$/,
  /\.d\.mts$/,
  /\.d\.cts$/,
];

const CONFIG_FILES = new Set([
  "package.json", "tsconfig.json", "tsconfig.base.json",
  "biome.json", "biome.jsonc",
  ".eslintrc.json", ".eslintrc.js", ".eslintrc.cjs",
  ".prettierrc", ".prettierrc.json",
  "vite.config.ts", "vite.config.js",
  "next.config.js", "next.config.mjs", "next.config.ts",
  "tailwind.config.ts", "tailwind.config.js",
  "drizzle.config.ts",
  "vitest.config.ts",
  "deno.json",
]);

const ENTRY_NAMES = new Set([
  "index.ts", "index.tsx", "index.js", "index.jsx",
  "main.ts", "main.tsx", "main.js",
  "app.ts", "app.tsx", "app.js",
  "cli.ts", "cli.js",
  "mod.ts", "lib.rs", "main.go", "main.py",
]);

const ALLOWED_MD_NAMES = new Set([
  "readme.md", "claude.md", "agents.md", "conventions.md", "contributing.md",
]);

// ── Collector ────────────────────────────────────────────────────────

export class CodebaseContentCollector {
  private projectDir: string;
  private cachedContent: CodebaseContent | null = null;
  private cachedGitHead: string | null = null;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
  }

  collect(): CodebaseContent {
    const currentHead = this.readGitHead();
    if (this.cachedContent && this.cachedGitHead === currentHead) {
      return this.cachedContent;
    }

    const allFiles = this.walkFiles(this.projectDir, "", 0);
    const sorted = this.prioritize(allFiles);

    const files: CollectedFile[] = [];
    const omitted: string[] = [];
    let totalChars = 0;

    for (const filePath of sorted) {
      const absPath = join(this.projectDir, filePath);
      let stat;
      try {
        stat = statSync(absPath);
      } catch {
        continue;
      }

      if (stat.size > MAX_FILE_SIZE) {
        omitted.push(filePath);
        continue;
      }

      let raw: string;
      try {
        raw = readFileSync(absPath, "utf-8");
      } catch {
        continue;
      }

      const lines = raw.split("\n");
      let content: string;
      let truncated = false;

      if (lines.length > MAX_LINES_PER_FILE) {
        content = lines.slice(0, MAX_LINES_PER_FILE).join("\n") + `\n... truncated (${lines.length} lines total)`;
        truncated = true;
      } else {
        content = raw;
      }

      if (totalChars + content.length > TOTAL_CHAR_BUDGET) {
        omitted.push(filePath);
        continue;
      }

      files.push({
        path: filePath,
        content,
        lines: lines.length,
        truncated,
        size: stat.size,
      });
      totalChars += content.length;
    }

    // Remaining sorted files that weren't processed go to omitted
    const includedPaths = new Set(files.map(f => f.path));
    for (const filePath of sorted) {
      if (!includedPaths.has(filePath) && !omitted.includes(filePath)) {
        omitted.push(filePath);
      }
    }

    const result: CodebaseContent = { files, totalChars, omittedFiles: omitted };
    this.cachedContent = result;
    this.cachedGitHead = currentHead;
    return result;
  }

  formatForPrompt(content: CodebaseContent): string {
    if (content.files.length === 0) return "";

    const parts: string[] = [];
    parts.push(`[CODEBASE CONTENT — ${content.files.length} source files]`);

    for (const file of content.files) {
      parts.push(`\n=== ${file.path} ===`);
      parts.push(file.content);
    }

    if (content.omittedFiles.length > 0) {
      parts.push(`\n... ${content.omittedFiles.length} files omitted (budget exceeded)`);
    }

    parts.push("[END CODEBASE CONTENT]");
    return parts.join("\n");
  }

  invalidateCache(): void {
    this.cachedContent = null;
    this.cachedGitHead = null;
  }

  // ── Private helpers ──────────────────────────────────────────────

  private walkFiles(dir: string, relPath: string, depth: number): string[] {
    if (depth > 8) return [];

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const results: string[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".claude") continue;
      if (IGNORE_DIRS.has(entry.name)) continue;

      const entryRel = relPath ? `${relPath}/${entry.name}` : entry.name;

      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        results.push(...this.walkFiles(join(dir, entry.name), entryRel, depth + 1));
      } else if (entry.isFile()) {
        if (this.shouldInclude(entry.name, entryRel)) {
          results.push(entryRel);
        }
      }
    }

    return results;
  }

  private shouldInclude(fileName: string, _relPath: string): boolean {
    const ext = extname(fileName).toLowerCase();
    if (!INCLUDE_EXTENSIONS.has(ext)) return false;

    for (const pattern of IGNORE_PATTERNS) {
      if (pattern.test(fileName)) return false;
    }

    // .md files: only allow specific names
    if (ext === ".md") {
      return ALLOWED_MD_NAMES.has(fileName.toLowerCase());
    }

    return true;
  }

  private prioritize(files: string[]): string[] {
    const config: string[] = [];
    const entry: string[] = [];
    const rest: string[] = [];

    for (const f of files) {
      const name = basename(f);
      if (CONFIG_FILES.has(name)) {
        config.push(f);
      } else if (ENTRY_NAMES.has(name)) {
        entry.push(f);
      } else {
        rest.push(f);
      }
    }

    // Sort rest by depth (shallow first), then alphabetically
    rest.sort((a, b) => {
      const depthA = a.split("/").length;
      const depthB = b.split("/").length;
      if (depthA !== depthB) return depthA - depthB;
      return a.localeCompare(b);
    });

    return [...config, ...entry, ...rest];
  }

  private readGitHead(): string {
    try {
      const headPath = join(this.projectDir, ".git", "HEAD");
      const content = readFileSync(headPath, "utf-8").trim();
      if (content.startsWith("ref: ")) {
        const refPath = join(this.projectDir, ".git", content.slice(5));
        if (existsSync(refPath)) {
          return readFileSync(refPath, "utf-8").trim().slice(0, 12);
        }
      }
      return content.slice(0, 12);
    } catch {
      return "no-git";
    }
  }
}
