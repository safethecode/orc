// ── Codebase Scanner ──────────────────────────────────────────────────
// Scans the project directory tree and produces a structured summary
// that gets injected into every agent's system prompt. Cached in SQLite
// and invalidated when git HEAD or directory structure changes.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";
import { createHash } from "node:crypto";
import type { MemoryStore } from "./memory-store.ts";

// ── Types ────────────────────────────────────────────────────────────

export interface ModuleInfo {
  path: string;
  purpose: string;
  fileCount: number;
  keyFiles: string[];
}

export interface TechStackDetail {
  category: string;
  name: string;
}

export interface CodebaseScanResult {
  projectName: string;
  totalFiles: number;
  totalDirs: number;
  languages: Record<string, number>;
  modules: ModuleInfo[];
  techStack: TechStackDetail[];
  entryPoints: string[];
  testSetup: { testDirs: string[]; pattern: string };
  buildScripts: Record<string, string>;
  scannedAt: string;
  gitHead: string;
  structureHash: string;
}

// ── Ignore patterns ──────────────────────────────────────────────────

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt",
  "__pycache__", ".venv", "venv", "target", "vendor",
  ".DS_Store", ".cache", ".turbo", ".parcel-cache",
  "coverage", ".nyc_output", ".svelte-kit", ".output",
  ".vercel", ".netlify", "out", ".expo",
]);

const IGNORE_EXTENSIONS = new Set([
  ".lock", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
  ".woff", ".woff2", ".ttf", ".eot", ".mp3", ".mp4", ".webm",
  ".db", ".sqlite", ".db-journal", ".db-wal",
  ".map", ".min.js", ".min.css",
]);

// ── Module purpose inference ─────────────────────────────────────────

const DIR_PURPOSES: Record<string, string> = {
  src: "Source code root",
  lib: "Library code",
  test: "Test suite", tests: "Test suite", __tests__: "Test suite",
  docs: "Documentation", doc: "Documentation",
  scripts: "Build/utility scripts",
  config: "Configuration",
  api: "API routes/handlers",
  components: "UI components",
  pages: "Page routes",
  app: "Application routes",
  hooks: "React hooks",
  utils: "Utility functions", helpers: "Helper functions",
  types: "Type definitions",
  middleware: "Middleware layer",
  services: "Service/business logic",
  models: "Data models",
  controllers: "Request controllers",
  routes: "Route definitions",
  stores: "State stores", store: "State store",
  agents: "Agent implementations",
  core: "Core logic",
  db: "Database schema and access", database: "Database layer",
  memory: "Memory/knowledge persistence",
  repl: "REPL interface",
  session: "Session management",
  sandbox: "Security sandbox",
  logging: "Logging infrastructure",
  mcp: "MCP integration",
  messaging: "Inter-agent messaging",
  benchmark: "Benchmarking",
  lsp: "Language Server Protocol",
  public: "Static assets",
  assets: "Asset files",
  styles: "Stylesheets",
  i18n: "Internationalization", locales: "Locale files",
  migrations: "Database migrations",
  prisma: "Prisma schema and migrations",
  fixtures: "Test fixtures",
  mocks: "Test mocks",
  plugins: "Plugin system",
  workers: "Background workers",
  cli: "CLI interface",
  tui: "Terminal UI",
};

// ── Tech stack detection ─────────────────────────────────────────────

const TECH_MAP: Record<string, { category: string; name: string }> = {
  // Frameworks
  next: { category: "framework", name: "Next.js" },
  react: { category: "ui", name: "React" },
  vue: { category: "ui", name: "Vue" },
  svelte: { category: "ui", name: "Svelte" },
  angular: { category: "ui", name: "Angular" },
  express: { category: "server", name: "Express" },
  fastify: { category: "server", name: "Fastify" },
  hono: { category: "server", name: "Hono" },
  koa: { category: "server", name: "Koa" },
  // ORM / DB
  "drizzle-orm": { category: "orm", name: "Drizzle" },
  prisma: { category: "orm", name: "Prisma" },
  typeorm: { category: "orm", name: "TypeORM" },
  sequelize: { category: "orm", name: "Sequelize" },
  mongoose: { category: "orm", name: "Mongoose" },
  "better-sqlite3": { category: "db", name: "better-sqlite3" },
  // Validation
  zod: { category: "validation", name: "Zod" },
  joi: { category: "validation", name: "Joi" },
  yup: { category: "validation", name: "Yup" },
  // CSS
  tailwindcss: { category: "css", name: "Tailwind CSS" },
  "styled-components": { category: "css", name: "styled-components" },
  "@emotion/react": { category: "css", name: "Emotion" },
  // State
  zustand: { category: "state", name: "Zustand" },
  redux: { category: "state", name: "Redux" },
  "@reduxjs/toolkit": { category: "state", name: "Redux Toolkit" },
  jotai: { category: "state", name: "Jotai" },
  recoil: { category: "state", name: "Recoil" },
  // Data fetching
  "@tanstack/react-query": { category: "data", name: "TanStack Query" },
  swr: { category: "data", name: "SWR" },
  axios: { category: "http", name: "Axios" },
  // Auth
  passport: { category: "auth", name: "Passport" },
  lucia: { category: "auth", name: "Lucia" },
  "better-auth": { category: "auth", name: "Better Auth" },
  "next-auth": { category: "auth", name: "NextAuth" },
  // Realtime
  "socket.io": { category: "realtime", name: "Socket.IO" },
  ws: { category: "realtime", name: "ws" },
  // API
  "@trpc/server": { category: "api", name: "tRPC" },
  graphql: { category: "api", name: "GraphQL" },
  // Testing
  vitest: { category: "test", name: "Vitest" },
  jest: { category: "test", name: "Jest" },
  "@playwright/test": { category: "test", name: "Playwright" },
  cypress: { category: "test", name: "Cypress" },
  // Build
  vite: { category: "build", name: "Vite" },
  esbuild: { category: "build", name: "esbuild" },
  webpack: { category: "build", name: "Webpack" },
  turbopack: { category: "build", name: "Turbopack" },
  // AI
  ai: { category: "ai", name: "Vercel AI SDK" },
  "@ai-sdk/anthropic": { category: "ai", name: "AI SDK Anthropic" },
  openai: { category: "ai", name: "OpenAI SDK" },
  "@anthropic-ai/sdk": { category: "ai", name: "Anthropic SDK" },
  langchain: { category: "ai", name: "LangChain" },
};

// ── Tree walking ─────────────────────────────────────────────────────

interface DirEntry {
  relativePath: string;
  fileCount: number;
  subdirs: string[];
  sampleFiles: string[];
}

interface TreeInfo {
  totalFiles: number;
  totalDirs: number;
  languages: Record<string, number>;
  directories: Map<string, DirEntry>;
}

function walkTree(rootDir: string, maxDepth = 4): TreeInfo {
  const info: TreeInfo = {
    totalFiles: 0,
    totalDirs: 0,
    languages: {},
    directories: new Map(),
  };

  function walk(dir: string, relPath: string, depth: number): void {
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const files: string[] = [];
    const subdirs: string[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".claude") continue;
      if (IGNORE_DIRS.has(entry.name)) continue;

      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        subdirs.push(entry.name);
        info.totalDirs++;
        walk(join(dir, entry.name), relPath ? `${relPath}/${entry.name}` : entry.name, depth + 1);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (IGNORE_EXTENSIONS.has(ext)) continue;
        files.push(entry.name);
        info.totalFiles++;
        if (ext) {
          info.languages[ext] = (info.languages[ext] ?? 0) + 1;
        }
      }
    }

    if (relPath) {
      info.directories.set(relPath, {
        relativePath: relPath,
        fileCount: files.length,
        subdirs,
        sampleFiles: files.slice(0, 10),
      });
    }
  }

  walk(rootDir, "", 0);
  return info;
}

// ── Scanner class ────────────────────────────────────────────────────

export class CodebaseScanner {
  private projectDir: string;
  private memory: MemoryStore;
  private cachedResult: CodebaseScanResult | null = null;

  constructor(projectDir: string, memory: MemoryStore) {
    this.projectDir = projectDir;
    this.memory = memory;
  }

  /** Get scan result. Returns cache if valid, otherwise scans fresh. */
  getScanResult(): CodebaseScanResult | null {
    if (this.cachedResult && this.isValid(this.cachedResult)) {
      return this.cachedResult;
    }

    const stored = this.memory.get("codebase_scan", "result");
    if (stored) {
      try {
        const parsed = JSON.parse(stored.value) as CodebaseScanResult;
        if (this.isValid(parsed)) {
          this.cachedResult = parsed;
          return parsed;
        }
      } catch { /* corrupted, re-scan */ }
    }

    try {
      return this.scan();
    } catch {
      return null;
    }
  }

  /** Force a fresh scan. */
  scan(): CodebaseScanResult {
    const gitHead = this.readGitHead();
    const tree = walkTree(this.projectDir);
    const structureHash = this.computeStructureHash(tree);

    const result: CodebaseScanResult = {
      projectName: basename(this.projectDir),
      totalFiles: tree.totalFiles,
      totalDirs: tree.totalDirs,
      languages: tree.languages,
      modules: this.inferModules(tree),
      techStack: this.detectTechStack(),
      entryPoints: this.findEntryPoints(),
      testSetup: this.detectTestSetup(tree),
      buildScripts: this.detectBuildScripts(),
      scannedAt: new Date().toISOString(),
      gitHead,
      structureHash,
    };

    this.memory.set("codebase_scan", "result", JSON.stringify(result), "scanner");
    this.cachedResult = result;
    return result;
  }

  /** Clear all caches. */
  invalidateCache(): void {
    this.cachedResult = null;
    try {
      this.memory.set("codebase_scan", "result", "", "scanner");
    } catch { /* non-fatal */ }
  }

  /** Format scan result for system prompt injection. */
  formatForPrompt(result: CodebaseScanResult, role?: string): string {
    const lines: string[] = [];

    // Header
    const langSummary = this.topLanguages(result.languages);
    const stackSummary = result.techStack.map(t => t.name).slice(0, 5).join(", ");
    lines.push("## Codebase Overview");
    lines.push(`Project: ${result.projectName} | ${result.totalFiles} files | ${langSummary}`);
    if (stackSummary) lines.push(`Stack: ${stackSummary}`);

    // Modules (compact)
    if (result.modules.length > 0) {
      lines.push("");
      lines.push("### Modules");
      const maxModules = result.totalFiles > 500 ? 15 : 25;
      for (const m of result.modules.slice(0, maxModules)) {
        const pad = m.path.length < 20 ? " ".repeat(20 - m.path.length) : " ";
        lines.push(`${m.path}/${pad}\u2014 ${m.purpose} (${m.fileCount} files)`);
      }
      if (result.modules.length > maxModules) {
        lines.push(`... and ${result.modules.length - maxModules} more modules`);
      }
    }

    // Key files
    if (result.entryPoints.length > 0) {
      lines.push("");
      lines.push("### Key Files");
      lines.push(`Entry: ${result.entryPoints.join(", ")}`);
    }

    // Test setup (extra detail for coder/tester)
    if (result.testSetup.testDirs.length > 0) {
      const testLine = `Tests: ${result.testSetup.pattern}`;
      if (role === "coder" || role === "tester" || role === "Software Engineer") {
        lines.push(testLine);
        lines.push(`Test dirs: ${result.testSetup.testDirs.join(", ")}`);
      } else {
        lines.push(testLine);
      }
    }

    // Build scripts (compact)
    const scripts = Object.entries(result.buildScripts);
    if (scripts.length > 0) {
      const important = scripts.filter(([k]) =>
        ["build", "dev", "start", "test", "lint", "typecheck"].includes(k),
      );
      if (important.length > 0) {
        lines.push(`Scripts: ${important.map(([k, v]) => `${k}=\`${v}\``).join(", ")}`);
      }
    }

    return lines.join("\n");
  }

  // ── Private helpers ──────────────────────────────────────────────

  private isValid(result: CodebaseScanResult): boolean {
    const currentHead = this.readGitHead();
    if (currentHead !== result.gitHead) return false;

    try {
      const entries = readdirSync(this.projectDir, { withFileTypes: true });
      const topDirs = entries
        .filter(e => e.isDirectory() && !IGNORE_DIRS.has(e.name) && !e.name.startsWith("."))
        .map(e => e.name)
        .sort()
        .join(",");
      const quickHash = createHash("md5").update(topDirs).digest("hex").slice(0, 12);
      return result.structureHash.startsWith(quickHash);
    } catch {
      return false;
    }
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

  private computeStructureHash(tree: TreeInfo): string {
    const topDirs = [...tree.directories.keys()]
      .filter(p => !p.includes("/"))
      .sort()
      .join(",");
    const topHash = createHash("md5").update(topDirs).digest("hex").slice(0, 12);

    const allParts: string[] = [];
    for (const [path, entry] of tree.directories) {
      allParts.push(`${path}:${entry.fileCount}:${entry.subdirs.length}`);
    }
    const fullHash = createHash("md5").update(allParts.sort().join("|")).digest("hex").slice(0, 12);
    return `${topHash}:${fullHash}`;
  }

  private inferModules(tree: TreeInfo): ModuleInfo[] {
    const modules: ModuleInfo[] = [];

    // Collect meaningful directories (top-level + second-level under src/)
    for (const [path, entry] of tree.directories) {
      const depth = path.split("/").length;

      // Top-level dirs always included
      if (depth === 1) {
        modules.push(this.buildModuleInfo(path, entry));
        continue;
      }

      // Second-level under src/ (e.g., src/agents, src/core)
      if (depth === 2 && path.startsWith("src/")) {
        modules.push(this.buildModuleInfo(path, entry));
        continue;
      }

      // Second-level under lib/ or app/
      if (depth === 2 && (path.startsWith("lib/") || path.startsWith("app/"))) {
        modules.push(this.buildModuleInfo(path, entry));
      }
    }

    // Sort: src/ modules first, then alphabetical
    modules.sort((a, b) => {
      const aIsSrc = a.path.startsWith("src/") ? 0 : 1;
      const bIsSrc = b.path.startsWith("src/") ? 0 : 1;
      if (aIsSrc !== bIsSrc) return aIsSrc - bIsSrc;
      return a.path.localeCompare(b.path);
    });

    return modules;
  }

  private buildModuleInfo(path: string, entry: DirEntry): ModuleInfo {
    const dirName = path.includes("/") ? path.split("/").pop()! : path;
    const purpose = DIR_PURPOSES[dirName] ?? this.guessPurpose(entry);

    // Count total files including subdirectories
    let totalFiles = entry.fileCount;
    // We only have direct file count; subdirs are listed but not recursively counted here.
    // The entry.fileCount is the direct files in this dir. For module-level overview this is fine.

    // Identify key files
    const keyFiles = entry.sampleFiles.filter(f =>
      f === "index.ts" || f === "index.tsx" || f === "index.js" ||
      f === "mod.ts" || f === "lib.rs" || f === "main.go" ||
      f.includes("manager") || f.includes("store") ||
      f.includes("router") || f.includes("schema"),
    ).slice(0, 5);

    return { path, purpose, fileCount: totalFiles, keyFiles };
  }

  private guessPurpose(entry: DirEntry): string {
    // Look at file names for clues
    const files = entry.sampleFiles;
    if (files.some(f => f.includes(".test.") || f.includes(".spec."))) return "Tests";
    if (files.some(f => f.includes("component") || f.endsWith(".tsx"))) return "UI components";
    if (files.some(f => f.includes("route") || f.includes("endpoint"))) return "API routes";
    if (files.some(f => f.includes("migration"))) return "Database migrations";
    if (files.some(f => f.includes("hook"))) return "React hooks";
    return "Module";
  }

  private detectTechStack(): TechStackDetail[] {
    const stack: TechStackDetail[] = [];
    const seen = new Set<string>();

    const pkgPath = join(this.projectDir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

        for (const [dep, info] of Object.entries(TECH_MAP)) {
          if (allDeps[dep] && !seen.has(info.name)) {
            seen.add(info.name);
            stack.push(info);
          }
        }
      } catch { /* malformed package.json */ }
    }

    // Bun runtime detection
    if (existsSync(join(this.projectDir, "bun.lockb")) || existsSync(join(this.projectDir, "bun.lock"))) {
      if (!seen.has("Bun")) { seen.add("Bun"); stack.unshift({ category: "runtime", name: "Bun" }); }
    }

    // SQLite via bun:sqlite (check imports)
    if (existsSync(join(this.projectDir, "src"))) {
      try {
        const dbDir = join(this.projectDir, "src", "db");
        if (existsSync(dbDir)) {
          const dbFiles = readdirSync(dbDir).filter(f => f.endsWith(".ts"));
          for (const f of dbFiles.slice(0, 3)) {
            const content = readFileSync(join(dbDir, f), "utf-8").slice(0, 500);
            if (content.includes("bun:sqlite") && !seen.has("bun:sqlite")) {
              seen.add("bun:sqlite");
              stack.push({ category: "db", name: "bun:sqlite" });
              break;
            }
          }
        }
      } catch { /* non-fatal */ }
    }

    return stack;
  }

  private findEntryPoints(): string[] {
    const entries: string[] = [];

    const pkgPath = join(this.projectDir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.main) entries.push(pkg.main);
        if (pkg.bin) {
          const bins = typeof pkg.bin === "string" ? { [pkg.name ?? "bin"]: pkg.bin } : pkg.bin;
          for (const [, path] of Object.entries(bins as Record<string, string>)) {
            if (!entries.includes(path)) entries.push(path);
          }
        }
      } catch { /* malformed */ }
    }

    // Common entry patterns
    const commonEntries = ["src/index.ts", "src/main.ts", "src/cli.ts", "src/app.ts", "index.ts", "main.ts"];
    for (const e of commonEntries) {
      if (existsSync(join(this.projectDir, e)) && !entries.includes(e)) {
        entries.push(e);
      }
    }

    return entries.slice(0, 5);
  }

  private detectTestSetup(tree: TreeInfo): { testDirs: string[]; pattern: string } {
    const testDirs: string[] = [];
    for (const [path] of tree.directories) {
      const dirName = path.split("/").pop()!;
      if (dirName === "test" || dirName === "tests" || dirName === "__tests__") {
        testDirs.push(path);
      }
    }

    // Detect test file pattern from existing files
    let pattern = "";
    for (const [, entry] of tree.directories) {
      for (const f of entry.sampleFiles) {
        if (f.includes(".test.")) { pattern = "*.test.*"; break; }
        if (f.includes(".spec.")) { pattern = "*.spec.*"; break; }
        if (f.startsWith("test_")) { pattern = "test_*"; break; }
      }
      if (pattern) break;
    }

    // Detect from config
    if (!pattern) {
      if (existsSync(join(this.projectDir, "vitest.config.ts"))) pattern = "*.test.ts (vitest)";
      else if (existsSync(join(this.projectDir, "jest.config.js")) || existsSync(join(this.projectDir, "jest.config.ts"))) pattern = "*.test.* (jest)";
      else if (existsSync(join(this.projectDir, "bun.lockb"))) pattern = "*.test.ts (bun:test)";
    }

    return { testDirs, pattern: pattern || "unknown" };
  }

  private detectBuildScripts(): Record<string, string> {
    const pkgPath = join(this.projectDir, "package.json");
    if (!existsSync(pkgPath)) return {};

    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (!pkg.scripts) return {};

      const result: Record<string, string> = {};
      const important = ["build", "dev", "start", "test", "lint", "typecheck", "format", "preview"];
      for (const key of important) {
        if (pkg.scripts[key]) result[key] = pkg.scripts[key];
      }
      return result;
    } catch {
      return {};
    }
  }

  private topLanguages(languages: Record<string, number>): string {
    const sorted = Object.entries(languages)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);

    const names: Record<string, string> = {
      ".ts": "TypeScript", ".tsx": "TypeScript/React", ".js": "JavaScript",
      ".jsx": "JavaScript/React", ".py": "Python", ".rs": "Rust",
      ".go": "Go", ".java": "Java", ".rb": "Ruby", ".php": "PHP",
      ".swift": "Swift", ".kt": "Kotlin", ".c": "C", ".cpp": "C++",
      ".cs": "C#", ".vue": "Vue", ".svelte": "Svelte",
    };

    return sorted.map(([ext, count]) => {
      const name = names[ext] ?? ext;
      return `${name} (${count})`;
    }).join(", ");
  }
}
