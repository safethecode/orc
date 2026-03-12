// ── Codebase Content Collector ────────────────────────────────────────
// Collects source file contents relevant to the current prompt and formats
// them for system prompt injection. Only injects files that match the prompt
// context — not a blind dump. Agents should NOT re-read injected files.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, basename, dirname } from "node:path";

// ── Types ────────────────────────────────────────────────────────────

export interface CollectedFile {
  path: string;
  content: string;
  lines: number;
  truncated: boolean;
  size: number;
  relevance: number;
}

export interface CodebaseContent {
  files: CollectedFile[];
  totalChars: number;
  allPaths: string[];
}

// ── Constants ────────────────────────────────────────────────────────

const MAX_LINES_PER_FILE = 500;
const MAX_FILE_SIZE = 50 * 1024; // 50KB
const RELEVANT_CHAR_BUDGET = 80_000; // ~23K tokens for relevant files only
const CONFIG_BUDGET = 10_000; // separate budget for config files

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

const ALLOWED_MD_NAMES = new Set([
  "readme.md", "claude.md", "agents.md", "conventions.md", "contributing.md",
]);

// Words too common to be meaningful for relevance
const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been",
  "do", "does", "did", "will", "would", "could", "should",
  "have", "has", "had", "not", "but", "and", "or", "if", "then",
  "this", "that", "it", "its", "in", "on", "at", "to", "for",
  "of", "with", "from", "by", "as", "so", "no", "yes",
  "make", "use", "add", "get", "set", "new", "all", "my",
  "please", "want", "need", "like", "just", "also",
  "만들어", "해줘", "수정", "변경", "추가", "삭제", "확인",
  "이", "그", "저", "것", "들", "를", "을", "에", "의", "로",
]);

// ── Collector ────────────────────────────────────────────────────────

export class CodebaseContentCollector {
  private projectDir: string;
  private cachedPaths: string[] | null = null;
  private cachedGitHead: string | null = null;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
  }

  /** Collect files relevant to the given prompt. Config files always included. */
  collect(prompt?: string): CodebaseContent {
    const currentHead = this.readGitHead();

    // Cache the file list (not content) — invalidate on git HEAD change
    if (!this.cachedPaths || this.cachedGitHead !== currentHead) {
      this.cachedPaths = this.walkFiles(this.projectDir, "", 0);
      this.cachedGitHead = currentHead;
    }

    const allPaths = this.cachedPaths;
    const keywords = prompt ? this.extractKeywords(prompt) : [];

    // Score each file by relevance to the prompt
    const scored: Array<{ path: string; score: number; isConfig: boolean }> = [];
    for (const filePath of allPaths) {
      const name = basename(filePath);
      const isConfig = CONFIG_FILES.has(name);
      const score = isConfig ? 100 : this.scoreRelevance(filePath, keywords);
      scored.push({ path: filePath, score, isConfig });
    }

    // Separate config files from content files
    const configFiles = scored.filter(f => f.isConfig);
    const contentFiles = scored.filter(f => !f.isConfig && f.score > 0);

    // Sort content files by relevance (highest first)
    contentFiles.sort((a, b) => b.score - a.score);

    // Collect config files first (separate budget)
    const files: CollectedFile[] = [];
    let configChars = 0;

    for (const { path: filePath } of configFiles) {
      const collected = this.readFile(filePath, 100);
      if (!collected) continue;
      if (configChars + collected.content.length > CONFIG_BUDGET) continue;
      files.push(collected);
      configChars += collected.content.length;
    }

    // Collect relevant content files
    let contentChars = 0;
    for (const { path: filePath, score } of contentFiles) {
      const collected = this.readFile(filePath, score);
      if (!collected) continue;
      if (contentChars + collected.content.length > RELEVANT_CHAR_BUDGET) break;
      files.push(collected);
      contentChars += collected.content.length;
    }

    return {
      files,
      totalChars: configChars + contentChars,
      allPaths,
    };
  }

  formatForPrompt(content: CodebaseContent): string {
    if (content.files.length === 0 && content.allPaths.length === 0) return "";

    const parts: string[] = [];

    if (content.files.length > 0) {
      parts.push(`[CODEBASE CONTENT — ${content.files.length} files injected]`);
      parts.push("IMPORTANT: These files are already in your context. Do NOT use Read, Bash, or Glob to re-read them.");
      parts.push("Only use tools for files NOT listed here.\n");

      for (const file of content.files) {
        parts.push(`=== ${file.path} ===`);
        parts.push(file.content);
      }
    }

    // List remaining paths (no content) so agent knows what exists
    const injectedPaths = new Set(content.files.map(f => f.path));
    const otherPaths = content.allPaths.filter(p => !injectedPaths.has(p));

    if (otherPaths.length > 0) {
      parts.push(`\n[OTHER FILES — ${otherPaths.length} files available via Read tool]`);
      parts.push(otherPaths.join("\n"));
    }

    parts.push("[END CODEBASE CONTENT]");
    return parts.join("\n");
  }

  invalidateCache(): void {
    this.cachedPaths = null;
    this.cachedGitHead = null;
  }

  // ── Private helpers ──────────────────────────────────────────────

  private readFile(filePath: string, relevance: number): CollectedFile | null {
    const absPath = join(this.projectDir, filePath);
    let stat;
    try {
      stat = statSync(absPath);
    } catch {
      return null;
    }
    if (stat.size > MAX_FILE_SIZE) return null;

    let raw: string;
    try {
      raw = readFileSync(absPath, "utf-8");
    } catch {
      return null;
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

    return { path: filePath, content, lines: lines.length, truncated, size: stat.size, relevance };
  }

  /** Extract meaningful keywords from a prompt for file relevance scoring. */
  private extractKeywords(prompt: string): string[] {
    // Split on whitespace, punctuation, camelCase, and path separators
    const raw = prompt
      .replace(/([a-z])([A-Z])/g, "$1 $2") // camelCase split
      .replace(/[^\w가-힣\s/.-]/g, " ")
      .toLowerCase()
      .split(/[\s/]+/)
      .filter(w => w.length > 1);

    const unique = new Set<string>();
    for (const w of raw) {
      if (!STOP_WORDS.has(w)) unique.add(w);
    }

    // Also extract file paths or component names mentioned directly
    const pathMatches = prompt.match(/[\w\-./]+\.[\w]+/g) ?? [];
    for (const p of pathMatches) {
      unique.add(p.toLowerCase());
      // Also add the stem without extension
      const stem = basename(p, extname(p)).toLowerCase();
      if (stem.length > 1) unique.add(stem);
    }

    return [...unique];
  }

  /** Score a file path's relevance to the keywords. 0 = not relevant. */
  private scoreRelevance(filePath: string, keywords: string[]): number {
    if (keywords.length === 0) {
      // No prompt: return base score by depth (shallow = more relevant)
      const depth = filePath.split("/").length;
      return Math.max(1, 10 - depth);
    }

    const lower = filePath.toLowerCase();
    const name = basename(lower, extname(lower));
    const dir = dirname(lower);
    let score = 0;

    for (const kw of keywords) {
      // Exact filename match (strongest signal)
      if (name === kw) { score += 50; continue; }
      // Filename contains keyword
      if (name.includes(kw)) { score += 30; continue; }
      // Directory path contains keyword
      if (dir.includes(kw)) { score += 20; continue; }
      // Full path contains keyword
      if (lower.includes(kw)) { score += 10; continue; }
    }

    return score;
  }

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
        if (this.shouldInclude(entry.name)) {
          results.push(entryRel);
        }
      }
    }

    return results;
  }

  private shouldInclude(fileName: string): boolean {
    const ext = extname(fileName).toLowerCase();
    if (!INCLUDE_EXTENSIONS.has(ext)) return false;

    for (const pattern of IGNORE_PATTERNS) {
      if (pattern.test(fileName)) return false;
    }

    if (ext === ".md") {
      return ALLOWED_MD_NAMES.has(fileName.toLowerCase());
    }

    return true;
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
