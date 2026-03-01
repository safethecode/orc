// ── RefactorEngine: 6-phase intelligent refactoring workflow ─────────
// Phases: analyze -> codemap -> test-assess -> plan -> execute -> verify

import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, extname } from "node:path";

// ── Interfaces ───────────────────────────────────────────────────────

export type RefactorExecutor = (plan: string, files: string[]) => Promise<string[]>;

export interface RefactorConfig {
  maxExploreAgents?: number;
  testCommand?: string;
  abortOnTestFail?: boolean;
  dryRun?: boolean;
}

export interface RefactorResult {
  success: boolean;
  phases: PhaseResult[];
  filesModified: string[];
  testsRan: boolean;
  testsPassed: boolean;
  durationMs: number;
  summary: string;
}

export interface PhaseResult {
  name: string;
  status: "success" | "failed" | "skipped";
  detail: string;
  durationMs: number;
}

export interface CodeMapEntry {
  file: string;
  imports: string[];
  exports: string[];
  dependencies: string[];
  functions: string[];
  classes: string[];
  lineCount: number;
}

export type RefactorPhase = "analyze" | "codemap" | "test-assess" | "plan" | "execute" | "verify";

// ── File extensions to scan ──────────────────────────────────────────

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs", ".cts",
]);

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".cache", "coverage",
  ".next", ".nuxt", ".output", ".turbo",
]);

// ── Engine ───────────────────────────────────────────────────────────

export class RefactorEngine {
  private config: Required<RefactorConfig>;
  private executor: RefactorExecutor | null = null;

  constructor(config?: RefactorConfig) {
    this.config = {
      maxExploreAgents: config?.maxExploreAgents ?? 3,
      testCommand: config?.testCommand ?? "bun test",
      abortOnTestFail: config?.abortOnTestFail ?? true,
      dryRun: config?.dryRun ?? false,
    };
  }

  onExecute(executor: RefactorExecutor): void {
    this.executor = executor;
  }

  /** All 6 phases in execution order */
  getPhases(): RefactorPhase[] {
    return ["analyze", "codemap", "test-assess", "plan", "execute", "verify"];
  }

  /** Main entry point: run the full 6-phase refactoring workflow */
  async execute(scope: string, goal: string): Promise<RefactorResult> {
    const overallStart = performance.now();
    const phases: PhaseResult[] = [];
    let filesModified: string[] = [];
    let testsRan = false;
    let testsPassed = false;

    // ── Phase 1: Analyze ───────────────────────────────────────────
    const analyzeStart = performance.now();
    let analysisResult: { files: string[]; analysis: string };

    try {
      analysisResult = await this.analyzeCodebase(scope);
      phases.push({
        name: "analyze",
        status: "success",
        detail: `Found ${analysisResult.files.length} relevant files`,
        durationMs: Math.round(performance.now() - analyzeStart),
      });
    } catch (err) {
      phases.push({
        name: "analyze",
        status: "failed",
        detail: errorMsg(err),
        durationMs: Math.round(performance.now() - analyzeStart),
      });
      return this.buildResult(false, phases, [], false, false, overallStart, "Analysis phase failed");
    }

    if (analysisResult.files.length === 0) {
      phases.push({
        name: "codemap",
        status: "skipped",
        detail: "No files to map",
        durationMs: 0,
      });
      return this.buildResult(false, phases, [], false, false, overallStart, "No files found matching scope");
    }

    // ── Phase 2: Codemap ───────────────────────────────────────────
    const codemapStart = performance.now();
    let codemap: CodeMapEntry[];

    try {
      codemap = await this.buildCodemap(analysisResult.files);
      phases.push({
        name: "codemap",
        status: "success",
        detail: `Mapped ${codemap.length} files, ${codemap.reduce((s, e) => s + e.lineCount, 0)} total lines`,
        durationMs: Math.round(performance.now() - codemapStart),
      });
    } catch (err) {
      phases.push({
        name: "codemap",
        status: "failed",
        detail: errorMsg(err),
        durationMs: Math.round(performance.now() - codemapStart),
      });
      return this.buildResult(false, phases, [], false, false, overallStart, "Codemap phase failed");
    }

    // ── Phase 3: Test Assessment ───────────────────────────────────
    const testAssessStart = performance.now();
    let testInfo: { hasCoverage: boolean; coveredFiles: string[]; testFiles: string[] };

    try {
      testInfo = await this.assessTests();
      phases.push({
        name: "test-assess",
        status: "success",
        detail: `${testInfo.testFiles.length} test files, coverage: ${testInfo.hasCoverage ? "yes" : "no"}`,
        durationMs: Math.round(performance.now() - testAssessStart),
      });
    } catch (err) {
      // Test assessment failure is non-fatal
      testInfo = { hasCoverage: false, coveredFiles: [], testFiles: [] };
      phases.push({
        name: "test-assess",
        status: "failed",
        detail: errorMsg(err),
        durationMs: Math.round(performance.now() - testAssessStart),
      });
    }

    // ── Phase 4: Plan ──────────────────────────────────────────────
    const planStart = performance.now();
    let plan: { steps: string[]; plan: string };

    try {
      plan = await this.generatePlan(goal, codemap, analysisResult.analysis);
      phases.push({
        name: "plan",
        status: "success",
        detail: `${plan.steps.length} steps generated`,
        durationMs: Math.round(performance.now() - planStart),
      });
    } catch (err) {
      phases.push({
        name: "plan",
        status: "failed",
        detail: errorMsg(err),
        durationMs: Math.round(performance.now() - planStart),
      });
      return this.buildResult(false, phases, [], false, false, overallStart, "Plan generation failed");
    }

    // ── Phase 5: Execute ───────────────────────────────────────────
    const execStart = performance.now();

    if (this.config.dryRun) {
      phases.push({
        name: "execute",
        status: "skipped",
        detail: "Dry run mode — no changes applied",
        durationMs: 0,
      });
    } else {
      try {
        filesModified = await this.executeRefactoring(plan.plan, analysisResult.files);
        phases.push({
          name: "execute",
          status: "success",
          detail: `${filesModified.length} files queued for modification`,
          durationMs: Math.round(performance.now() - execStart),
        });
      } catch (err) {
        phases.push({
          name: "execute",
          status: "failed",
          detail: errorMsg(err),
          durationMs: Math.round(performance.now() - execStart),
        });
        return this.buildResult(false, phases, [], false, false, overallStart, "Execution failed");
      }
    }

    // ── Phase 6: Verify ────────────────────────────────────────────
    const verifyStart = performance.now();

    if (this.config.dryRun) {
      phases.push({
        name: "verify",
        status: "skipped",
        detail: "Dry run mode — verification skipped",
        durationMs: 0,
      });
    } else if (testInfo.testFiles.length === 0) {
      phases.push({
        name: "verify",
        status: "skipped",
        detail: "No test files found — skipping verification",
        durationMs: 0,
      });
    } else {
      try {
        const verification = await this.verifyRegression();
        testsRan = true;
        testsPassed = verification.passed;

        phases.push({
          name: "verify",
          status: verification.passed ? "success" : "failed",
          detail: verification.passed
            ? "All tests passed"
            : `Tests failed: ${verification.output.slice(0, 200)}`,
          durationMs: Math.round(performance.now() - verifyStart),
        });

        if (!verification.passed && this.config.abortOnTestFail) {
          return this.buildResult(
            false,
            phases,
            filesModified,
            true,
            false,
            overallStart,
            "Regression detected — tests failed after refactoring",
          );
        }
      } catch (err) {
        phases.push({
          name: "verify",
          status: "failed",
          detail: errorMsg(err),
          durationMs: Math.round(performance.now() - verifyStart),
        });
      }
    }

    // ── Summary ────────────────────────────────────────────────────
    const failedPhases = phases.filter((p) => p.status === "failed");
    const success = failedPhases.length === 0;
    const summary = success
      ? `Refactoring complete: ${filesModified.length} files modified, ${plan.steps.length} steps executed`
      : `Refactoring had failures in: ${failedPhases.map((p) => p.name).join(", ")}`;

    return this.buildResult(success, phases, filesModified, testsRan, testsPassed, overallStart, summary);
  }

  // ── Phase 1: Parallel Codebase Analysis ──────────────────────────

  private async analyzeCodebase(scope: string): Promise<{ files: string[]; analysis: string }> {
    const cwd = process.cwd();
    const scopePath = scope.startsWith("/") ? scope : join(cwd, scope);

    // Determine the root to scan
    const scanRoot = existsSync(scopePath) ? scopePath : cwd;

    // Check if scope is a single file
    let rootStat: Awaited<ReturnType<typeof stat>>;
    try {
      rootStat = await stat(scanRoot);
    } catch {
      return { files: [], analysis: `Scope path not found: ${scope}` };
    }

    if (rootStat.isFile()) {
      const content = await readFile(scanRoot, "utf-8");
      const lineCount = content.split("\n").length;
      return {
        files: [scanRoot],
        analysis: `Single file: ${scanRoot} (${lineCount} lines)`,
      };
    }

    // Parallel exploration: split subdirectories across agents
    const topEntries = await readdir(scanRoot, { withFileTypes: true });
    const subDirs = topEntries
      .filter((e) => e.isDirectory() && !IGNORE_DIRS.has(e.name) && !e.name.startsWith("."))
      .map((e) => join(scanRoot, e.name));
    const topFiles = topEntries
      .filter((e) => e.isFile() && SOURCE_EXTENSIONS.has(extname(e.name)))
      .map((e) => join(scanRoot, e.name));

    // Split subdirectories into chunks for parallel scanning
    const agentCount = Math.min(this.config.maxExploreAgents, Math.max(1, subDirs.length));
    const chunks = this.chunkArray(subDirs, agentCount);

    // Parallel scan
    const chunkResults = await Promise.all(
      chunks.map((dirs) => this.scanDirectories(dirs)),
    );

    const allFiles = [...topFiles, ...chunkResults.flat()];

    // Filter by scope pattern if scope looks like a glob or keyword
    const filtered = this.filterByScope(allFiles, scope, scanRoot);

    const analysis = [
      `Scope: ${scope}`,
      `Root: ${scanRoot}`,
      `Total source files found: ${filtered.length}`,
      `Subdirectories scanned: ${subDirs.length}`,
      `Explore agents used: ${agentCount}`,
    ].join("\n");

    return { files: filtered, analysis };
  }

  // ── Phase 2: Build Codemap ───────────────────────────────────────

  private async buildCodemap(files: string[]): Promise<CodeMapEntry[]> {
    const entries = await Promise.all(
      files.map(async (file): Promise<CodeMapEntry | null> => {
        try {
          const content = await readFile(file, "utf-8");
          const lines = content.split("\n");

          const imports = this.parseImports(content);
          const exports = this.parseExports(content);
          const functions = this.parseFunctions(content);
          const classes = this.parseClasses(content);

          // Resolve import paths to actual dependencies
          const dependencies = imports
            .filter((i) => i.startsWith(".") || i.startsWith("/"))
            .map((i) => this.resolveImportPath(i, file));

          return {
            file,
            imports,
            exports,
            dependencies,
            functions,
            classes,
            lineCount: lines.length,
          };
        } catch {
          return null;
        }
      }),
    );

    return entries.filter((e): e is CodeMapEntry => e !== null);
  }

  // ── Phase 3: Test Coverage Assessment ────────────────────────────

  private async assessTests(): Promise<{ hasCoverage: boolean; coveredFiles: string[]; testFiles: string[] }> {
    const cwd = process.cwd();

    // Scan for test files
    const testGlob = new Bun.Glob("**/*.{test,spec}.{ts,tsx,js,jsx}");
    const testFiles: string[] = [];

    for await (const entry of testGlob.scan({ cwd, absolute: true })) {
      // Skip node_modules and other ignored directories
      const rel = relative(cwd, entry);
      const parts = rel.split("/");
      if (parts.some((p) => IGNORE_DIRS.has(p))) continue;
      testFiles.push(entry);
    }

    // Also check for __tests__ directories
    const testsGlob = new Bun.Glob("**/__tests__/**/*.{ts,tsx,js,jsx}");
    for await (const entry of testsGlob.scan({ cwd, absolute: true })) {
      const rel = relative(cwd, entry);
      const parts = rel.split("/");
      if (parts.some((p) => IGNORE_DIRS.has(p))) continue;
      if (!testFiles.includes(entry)) testFiles.push(entry);
    }

    // Extract which source files the tests cover by reading imports
    const coveredFiles: string[] = [];
    for (const testFile of testFiles) {
      try {
        const content = await readFile(testFile, "utf-8");
        const imports = this.parseImports(content);
        for (const imp of imports) {
          if (imp.startsWith(".") || imp.startsWith("/")) {
            const resolved = this.resolveImportPath(imp, testFile);
            if (!coveredFiles.includes(resolved)) {
              coveredFiles.push(resolved);
            }
          }
        }
      } catch {
        // Skip unreadable test files
      }
    }

    return {
      hasCoverage: coveredFiles.length > 0,
      coveredFiles,
      testFiles,
    };
  }

  // ── Phase 4: Plan Generation ─────────────────────────────────────

  private async generatePlan(
    goal: string,
    codemap: CodeMapEntry[],
    analysis: string,
  ): Promise<{ steps: string[]; plan: string }> {
    // Build a dependency-aware execution order
    const fileSet = new Set(codemap.map((e) => e.file));

    // Topological sort: files with fewer deps first (leaf nodes first)
    const sorted = [...codemap].sort((a, b) => {
      const aDeps = a.dependencies.filter((d) => fileSet.has(d)).length;
      const bDeps = b.dependencies.filter((d) => fileSet.has(d)).length;
      return aDeps - bDeps;
    });

    const steps: string[] = [];

    // Step 1: Always start with an understanding step
    steps.push(`Understand the refactoring goal: ${goal}`);

    // Step 2: Group files by their role
    const filesByRole = this.categorizeFiles(sorted);

    if (filesByRole.utilities.length > 0) {
      steps.push(`Refactor utility files (${filesByRole.utilities.length}): ${filesByRole.utilities.map((e) => relative(process.cwd(), e.file)).join(", ")}`);
    }

    if (filesByRole.core.length > 0) {
      steps.push(`Refactor core files (${filesByRole.core.length}): ${filesByRole.core.map((e) => relative(process.cwd(), e.file)).join(", ")}`);
    }

    if (filesByRole.entryPoints.length > 0) {
      steps.push(`Update entry points (${filesByRole.entryPoints.length}): ${filesByRole.entryPoints.map((e) => relative(process.cwd(), e.file)).join(", ")}`);
    }

    // Step 3: Update imports across dependent files
    const hasExternalDeps = codemap.some((e) => e.dependencies.some((d) => !fileSet.has(d)));
    if (hasExternalDeps) {
      steps.push("Update import paths in dependent files outside the refactoring scope");
    }

    // Step 4: Verification
    steps.push("Run test suite to verify no regressions");

    const plan = [
      `# Refactoring Plan`,
      ``,
      `## Goal`,
      goal,
      ``,
      `## Analysis`,
      analysis,
      ``,
      `## Codemap Summary`,
      `- Files: ${codemap.length}`,
      `- Total lines: ${codemap.reduce((s, e) => s + e.lineCount, 0)}`,
      `- Functions: ${codemap.reduce((s, e) => s + e.functions.length, 0)}`,
      `- Classes: ${codemap.reduce((s, e) => s + e.classes.length, 0)}`,
      ``,
      `## Steps`,
      ...steps.map((s, i) => `${i + 1}. ${s}`),
      ``,
      `## Dependency Order (leaf-first)`,
      ...sorted.map((e) => {
        const rel = relative(process.cwd(), e.file);
        const deps = e.dependencies.filter((d) => fileSet.has(d)).length;
        return `- ${rel} (${deps} internal deps, ${e.lineCount} lines)`;
      }),
    ].join("\n");

    return { steps, plan };
  }

  // ── Phase 5: Execute Refactoring ─────────────────────────────────

  private async executeRefactoring(plan: string, files: string[]): Promise<string[]> {
    if (this.executor) {
      return this.executor(plan, files);
    }

    // Fallback: use the default CLI agent to apply the refactoring plan
    const prompt = [
      "Apply the following refactoring plan to the codebase.",
      "Only modify the files listed. Do not create new files unless the plan requires it.",
      "",
      plan,
    ].join("\n");

    const proc = Bun.spawn(["claude", "-p", "--no-input", prompt], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: process.cwd(),
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`Refactor agent failed (exit ${exitCode}): ${stderr.slice(0, 500)}`);
    }

    // Determine which files were actually modified via git diff
    const diffProc = Bun.spawn(["git", "diff", "--name-only"], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: process.cwd(),
    });

    const diffOutput = await new Response(diffProc.stdout).text();
    await diffProc.exited;

    const modifiedFiles = diffOutput
      .trim()
      .split("\n")
      .filter((f) => f.length > 0)
      .map((f) => join(process.cwd(), f));

    // Return intersection of planned files and actually modified files
    const fileSet = new Set(files);
    return modifiedFiles.filter((f) => fileSet.has(f));
  }

  // ── Phase 6: Regression Verification ─────────────────────────────

  private async verifyRegression(): Promise<{ passed: boolean; output: string }> {
    const result = await this.runTests();
    return {
      passed: result.exitCode === 0,
      output: result.output,
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private async runTests(): Promise<{ exitCode: number; output: string }> {
    const parts = this.config.testCommand.split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);

    const proc = Bun.spawn([cmd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      cwd: process.cwd(),
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;
    const output = (stdout + "\n" + stderr).trim();

    return { exitCode, output };
  }

  /** Parse import statements from source content */
  parseImports(content: string): string[] {
    const imports: string[] = [];
    const seen = new Set<string>();

    // ES import: import ... from "path"
    const esRegex = /import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;
    let match: RegExpExecArray | null;

    while ((match = esRegex.exec(content)) !== null) {
      const path = match[1];
      if (!seen.has(path)) {
        seen.add(path);
        imports.push(path);
      }
    }

    // Dynamic import: import("path")
    const dynamicRegex = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
    while ((match = dynamicRegex.exec(content)) !== null) {
      const path = match[1];
      if (!seen.has(path)) {
        seen.add(path);
        imports.push(path);
      }
    }

    // require("path")
    const requireRegex = /require\s*\(\s*["']([^"']+)["']\s*\)/g;
    while ((match = requireRegex.exec(content)) !== null) {
      const path = match[1];
      if (!seen.has(path)) {
        seen.add(path);
        imports.push(path);
      }
    }

    return imports;
  }

  /** Parse export declarations from source content */
  parseExports(content: string): string[] {
    const exports: string[] = [];
    const seen = new Set<string>();

    // Named exports: export { name }
    const namedRegex = /export\s*\{([^}]+)\}/g;
    let match: RegExpExecArray | null;

    while ((match = namedRegex.exec(content)) !== null) {
      const names = match[1].split(",").map((n) => {
        // Handle "name as alias"
        const parts = n.trim().split(/\s+as\s+/);
        return parts[0].trim();
      });
      for (const name of names) {
        if (name && !seen.has(name)) {
          seen.add(name);
          exports.push(name);
        }
      }
    }

    // export const/let/var/function/class/type/interface/enum
    const declRegex = /export\s+(?:default\s+)?(?:const|let|var|function\*?|class|type|interface|enum|abstract\s+class)\s+(\w+)/g;
    while ((match = declRegex.exec(content)) !== null) {
      const name = match[1];
      if (!seen.has(name)) {
        seen.add(name);
        exports.push(name);
      }
    }

    // export default (anonymous)
    if (/export\s+default\s+(?!(?:const|let|var|function|class|type|interface|enum|abstract)\s)/.test(content)) {
      if (!seen.has("default")) {
        seen.add("default");
        exports.push("default");
      }
    }

    return exports;
  }

  /** Parse function declarations from source content */
  parseFunctions(content: string): string[] {
    const functions: string[] = [];
    const seen = new Set<string>();

    // function declarations: function name(
    const funcRegex = /(?:export\s+)?(?:async\s+)?function\*?\s+(\w+)\s*\(/g;
    let match: RegExpExecArray | null;

    while ((match = funcRegex.exec(content)) !== null) {
      const name = match[1];
      if (!seen.has(name)) {
        seen.add(name);
        functions.push(name);
      }
    }

    // Arrow/method: const name = (...) =>  or  const name = async (...) =>
    const arrowRegex = /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_]\w*)\s*(?::\s*[^=]+)?\s*=>/g;
    while ((match = arrowRegex.exec(content)) !== null) {
      const name = match[1];
      if (!seen.has(name)) {
        seen.add(name);
        functions.push(name);
      }
    }

    // Class method declarations: async? methodName(
    const methodRegex = /^\s+(?:private\s+|protected\s+|public\s+|static\s+|readonly\s+)*(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/gm;
    while ((match = methodRegex.exec(content)) !== null) {
      const name = match[1];
      // Skip constructors and common non-function keywords
      if (name === "constructor" || name === "if" || name === "for" || name === "while" || name === "switch") continue;
      if (!seen.has(name)) {
        seen.add(name);
        functions.push(name);
      }
    }

    return functions;
  }

  /** Parse class declarations from source content */
  parseClasses(content: string): string[] {
    const classes: string[] = [];
    const seen = new Set<string>();

    const classRegex = /(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/g;
    let match: RegExpExecArray | null;

    while ((match = classRegex.exec(content)) !== null) {
      const name = match[1];
      if (!seen.has(name)) {
        seen.add(name);
        classes.push(name);
      }
    }

    return classes;
  }

  // ── Internal Utilities ─────────────────────────────────────────────

  /** Recursively scan directories for source files */
  private async scanDirectories(dirs: string[]): Promise<string[]> {
    const files: string[] = [];

    for (const dir of dirs) {
      await this.walkDir(dir, files);
    }

    return files;
  }

  /** Walk a directory tree recursively, collecting source files */
  private async walkDir(dirPath: string, result: string[]): Promise<void> {
    let entries: Awaited<ReturnType<typeof readdir>>;

    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);

      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          await this.walkDir(fullPath, result);
        }
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
        result.push(fullPath);
      }
    }
  }

  /** Filter files by scope — supports directory paths, globs, and keyword matching */
  private filterByScope(files: string[], scope: string, scanRoot: string): string[] {
    // If scope is "." or the scanRoot itself, return all files
    if (scope === "." || scope === scanRoot) return files;

    // If scope is a directory path, filter to that subtree
    const scopeFull = scope.startsWith("/") ? scope : join(process.cwd(), scope);
    if (existsSync(scopeFull)) {
      return files.filter((f) => f.startsWith(scopeFull));
    }

    // If scope contains a glob wildcard, use Bun.Glob
    if (scope.includes("*") || scope.includes("?")) {
      const glob = new Bun.Glob(scope);
      return files.filter((f) => {
        const rel = relative(scanRoot, f);
        return glob.match(rel);
      });
    }

    // Keyword-based: match files whose path contains the scope string
    const lower = scope.toLowerCase();
    return files.filter((f) => f.toLowerCase().includes(lower));
  }

  /** Resolve a relative import path to an absolute file path */
  private resolveImportPath(importPath: string, fromFile: string): string {
    const dir = fromFile.replace(/\/[^/]+$/, "");
    let resolved = join(dir, importPath);

    // Strip trailing extension variants for resolution
    // Then add back common extensions
    if (!extname(resolved)) {
      for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
        if (existsSync(resolved + ext)) return resolved + ext;
      }
      // Try index file
      for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
        const indexPath = join(resolved, `index${ext}`);
        if (existsSync(indexPath)) return indexPath;
      }
    }

    return resolved;
  }

  /** Categorize codemap entries by their role in the codebase */
  private categorizeFiles(entries: CodeMapEntry[]): {
    utilities: CodeMapEntry[];
    core: CodeMapEntry[];
    entryPoints: CodeMapEntry[];
  } {
    const fileSet = new Set(entries.map((e) => e.file));

    // Entry points: files that are imported by nothing (or have "index" in name)
    // Utilities: files imported by many other files
    // Core: everything else
    const importedBy = new Map<string, number>();

    for (const entry of entries) {
      for (const dep of entry.dependencies) {
        if (fileSet.has(dep)) {
          importedBy.set(dep, (importedBy.get(dep) ?? 0) + 1);
        }
      }
    }

    const utilities: CodeMapEntry[] = [];
    const core: CodeMapEntry[] = [];
    const entryPoints: CodeMapEntry[] = [];

    for (const entry of entries) {
      const importCount = importedBy.get(entry.file) ?? 0;
      const isIndex = entry.file.includes("index.");

      if (isIndex || importCount === 0) {
        entryPoints.push(entry);
      } else if (importCount >= 3) {
        utilities.push(entry);
      } else {
        core.push(entry);
      }
    }

    return { utilities, core, entryPoints };
  }

  /** Split an array into N roughly equal chunks */
  private chunkArray<T>(arr: T[], chunks: number): T[][] {
    if (chunks <= 0) return [arr];
    if (chunks >= arr.length) return arr.map((item) => [item]);

    const result: T[][] = [];
    const size = Math.ceil(arr.length / chunks);

    for (let i = 0; i < arr.length; i += size) {
      result.push(arr.slice(i, i + size));
    }

    return result;
  }

  /** Build the final RefactorResult */
  private buildResult(
    success: boolean,
    phases: PhaseResult[],
    filesModified: string[],
    testsRan: boolean,
    testsPassed: boolean,
    startTime: number,
    summary: string,
  ): RefactorResult {
    return {
      success,
      phases,
      filesModified,
      testsRan,
      testsPassed,
      durationMs: Math.round(performance.now() - startTime),
      summary,
    };
  }
}

/** Extract error message from unknown error */
function errorMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
