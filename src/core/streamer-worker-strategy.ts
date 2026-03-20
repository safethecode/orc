import type { SubTask, OrchestratorConfig } from "../config/types.ts";
import type { AgentRegistry } from "../agents/registry.ts";
import type { Store } from "../db/store.ts";
import type { WorkerExecutionStrategy, WorkerHandle, WorkerResult, SpawnOptions } from "./worker-strategy.ts";
import type { CodebaseScanResult } from "../memory/codebase-scanner.ts";
import { AgentStreamer, type ToolUseEvent } from "../repl/streamer.ts";
import { buildCommand } from "../agents/provider.ts";
import { buildDynamicHarnessAsync } from "../agents/dynamic-harness.ts";
import { ContextInjector } from "./context-injector.ts";
import { eventBus } from "./events.ts";

interface ActiveWorker {
  streamer: AgentStreamer;
  abort: AbortController;
  textBuffer: string;
  promise: Promise<WorkerResult | null>;
  lastError: string | null;
}

export class StreamerWorkerStrategy implements WorkerExecutionStrategy {
  private workers = new Map<string, ActiveWorker>();
  private scanResult: CodebaseScanResult | null = null;
  private skillBodies: string | null = null;
  private mcpConfigPath: string | null = null;

  constructor(
    private config: OrchestratorConfig,
    private registry: AgentRegistry,
    private store: Store,
  ) {}

  setScanResult(result: CodebaseScanResult | null): void {
    this.scanResult = result;
  }

  setSkillBodies(bodies: string): void {
    this.skillBodies = bodies;
  }

  setMcpConfigPath(path: string): void {
    this.mcpConfigPath = path;
  }

  async spawn(subtask: SubTask, maxTurns: number, enrichedPrompt: string, options?: SpawnOptions): Promise<WorkerHandle> {
    const agentName = `worker-${subtask.id.slice(0, 8)}`;
    const providerConfig = this.config.providers[subtask.provider];
    if (!providerConfig) throw new Error(`Unknown provider: ${subtask.provider}`);

    // Use user-defined profile if available, otherwise fall back to dynamic harness
    const userProfile = this.registry.get(subtask.agentRole);
    const projectDir = options?.workdir ?? process.cwd();
    let systemPrompt: string;
    if (userProfile?.systemPrompt) {
      systemPrompt = userProfile.systemPrompt;
    } else {
      const harnessResult = await buildDynamicHarnessAsync({
        agentName,
        role: subtask.agentRole as any,
        provider: subtask.provider as any,
        parentTaskId: subtask.parentTaskId,
        isWorker: true,
        projectDir,
        prompt: enrichedPrompt,
        turnBudget: maxTurns,
      });
      systemPrompt = harnessResult.systemPrompt;
    }

    // Inject CLAUDE.md / AGENTS.md / CONVENTIONS.md
    const contextInjector = new ContextInjector(projectDir);
    const contextFiles = contextInjector.collect();
    const contextBlock = contextInjector.formatForPrompt(contextFiles);
    if (contextBlock) {
      systemPrompt = contextBlock + "\n\n" + systemPrompt;
    }

    // Inject project context from codebase scan result
    if (this.scanResult) {
      const projectContext = this.formatProjectContext(this.scanResult);
      if (projectContext) {
        systemPrompt = systemPrompt + "\n\n" + projectContext;
      }
    }

    // Worker override: role-aware — design agents keep their full workflow
    const NON_INTERACTIVE_GUARD = "Do NOT run interactive commands (vim, nano, less, more, ssh, mysql, psql, mongo, python REPL, irb, node REPL, etc.). Use non-interactive alternatives only.";
    const isDesignRole = subtask.agentRole === "design" || subtask.agentRole === "architect";
    const workerOverride = isDesignRole
      ? [
          "[WORKER MODE]",
          "You are a multi-agent worker. The project file tree is provided in the user message — use it instead of running find/ls.",
          "Follow your profile instructions completely — reference-based design, screenshots, quality checks.",
          "Your profile rules (below) take HIGHEST PRIORITY. Do not skip any step in your design process.",
          "IMPORTANT: Do NOT use AskUserQuestion or ask for user approval. You cannot receive user input.",
          "Output your design plan as text, then implement it immediately. Auto-approve your own designs.",
          NON_INTERACTIVE_GUARD,
        ].join("\n")
      : [
          "[WORKER MODE — HIGHEST PRIORITY]",
          "You are a multi-agent worker. The project structure and file tree are ALREADY provided in the user message.",
          "SKIP all exploration: do NOT run find, ls, ls -la, or tree commands.",
          "SKIP reading files for analysis. Only Read a file immediately before you Edit it.",
          "Go STRAIGHT to creating and editing files. Start implementation within your first 3 tool calls.",
          "Do NOT use AskUserQuestion — you cannot receive user input. Make decisions autonomously.",
          NON_INTERACTIVE_GUARD,
        ].join("\n");
    systemPrompt = workerOverride + "\n\n" + systemPrompt;

    // Inject skill bodies from scouting
    if (this.skillBodies) {
      systemPrompt += "\n\n" + this.skillBodies;
    }

    const profile = {
      name: agentName,
      provider: userProfile?.provider ?? subtask.provider,
      model: userProfile?.model ?? subtask.model,
      role: subtask.agentRole,
      maxBudgetUsd: userProfile?.maxBudgetUsd ?? this.config.budget.defaultMaxPerTask,
      requires: userProfile?.requires ?? [] as string[],
      worktree: false,
      systemPrompt,
      maxTurns,
    };

    this.registry.register(profile);
    this.store.registerAgent(agentName, profile.provider, profile.model);

    const cmd = buildCommand(providerConfig, profile, {
      prompt: enrichedPrompt,
      model: profile.model,
      systemPrompt,
      workdir: options?.workdir,
      mcpConfig: (subtask.provider === "claude" && this.mcpConfigPath) ? this.mcpConfigPath : undefined,
    });

    const isClaude = subtask.provider === "claude";
    const streamer = new AgentStreamer();
    const abort = new AbortController();
    const worker: ActiveWorker = {
      streamer,
      abort,
      textBuffer: "",
      promise: null as any,
      lastError: null,
    };

    if (isClaude) {
      // Claude: use AgentStreamer with stream-json parsing
      let turnCount = 0;
      streamer.on("tool_use", (tool: ToolUseEvent) => {
        turnCount++;
        eventBus.publish({
          type: "worker:turn",
          workerId: agentName,
          turn: turnCount,
          maxTurns,
          toolUsed: tool.name,
          toolInput: tool.input,
        });
      });

      streamer.on("text_complete", (text: string) => {
        worker.textBuffer += text;
        const trimmed = text.trim();
        if (trimmed && trimmed.length > 5) {
          eventBus.publish({ type: "worker:text", agentName, text: trimmed.length > 200 ? trimmed.slice(0, 200) + "…" : trimmed });
        }
      });

      streamer.on("usage", (usage: { inputTokens: number; outputTokens: number; costUsd: number }) => {
        eventBus.publish({ type: "worker:cost", agentName, costUsd: usage.costUsd, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
      });

      streamer.on("error", (errText: string) => {
        worker.lastError = errText;
        eventBus.publish({ type: "worker:stderr", agentName, error: errText.slice(0, 300) });
      });

      worker.promise = streamer.run(cmd, abort.signal).then(
        (result) => ({
          result: result.text || worker.textBuffer || "",
          tokenUsage: result.inputTokens + result.outputTokens,
          costUsd: result.costUsd,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        }),
        (err) => { worker.lastError = err instanceof Error ? err.message : String(err); return null; },
      );
    } else {
      // Non-claude (codex, gemini, kiro): plain process, capture stdout/stderr
      const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore", cwd: options?.workdir });
      worker.promise = (async () => {
        try {
          const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout as ReadableStream).text(),
            new Response(proc.stderr as ReadableStream).text(),
          ]);
          const exitCode = await proc.exited;

          // Stream progress to REPL
          const lines = stdout.split("\n").filter(l => l.trim());
          for (const line of lines.slice(-10)) {
            const trimmed = line.trim();
            if (trimmed.length > 5) {
              worker.textBuffer += trimmed + "\n";
              eventBus.publish({ type: "worker:text", agentName, text: trimmed.length > 200 ? trimmed.slice(0, 200) + "…" : trimmed });
            }
          }

          if (exitCode !== 0 && stderr) {
            worker.lastError = stderr.slice(0, 500);
            eventBus.publish({ type: "worker:stderr", agentName, error: stderr.slice(0, 300) });
          }

          const result = stdout.trim() || worker.textBuffer;
          if (!result) {
            worker.lastError = stderr.trim() || `Process exited with code ${exitCode}`;
            return null;
          }
          return { result, tokenUsage: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
        } catch (err) {
          worker.lastError = err instanceof Error ? err.message : String(err);
          return null;
        }
      })();

      // Support abort
      abort.signal.addEventListener("abort", () => { try { proc.kill(); } catch {} }, { once: true });
    }

    this.workers.set(agentName, worker);

    return { agentName, sessionId: `streamer-${agentName}` };
  }

  private formatProjectContext(scan: CodebaseScanResult): string {
    const lines: string[] = ["## Project Context"];

    // Runtime detection
    const runtime = scan.techStack.find(t => t.category === "runtime");
    if (runtime) lines.push(`- Runtime: ${runtime.name}`);

    // Framework
    const framework = scan.techStack.find(t => t.category === "framework");
    if (framework) lines.push(`- Framework: ${framework.name}`);

    // Package manager (infer from scan data)
    if (scan.buildScripts && Object.keys(scan.buildScripts).length > 0) {
      const scripts = Object.values(scan.buildScripts).join(" ");
      if (scripts.includes("pnpm")) lines.push("- Package manager: pnpm");
      else if (scripts.includes("yarn")) lines.push("- Package manager: yarn");
      else if (scripts.includes("bun")) lines.push("- Package manager: bun");
      else lines.push("- Package manager: npm");
    }

    // CSS/styling
    const css = scan.techStack.filter(t => t.category === "css");
    if (css.length > 0) lines.push(`- Styling: ${css.map(c => c.name).join(" + ")}`);

    // UI library
    const ui = scan.techStack.filter(t => t.category === "ui");
    if (ui.length > 0) lines.push(`- UI: ${ui.map(u => u.name).join(", ")}`);

    // ORM/DB
    const db = scan.techStack.filter(t => t.category === "orm" || t.category === "db");
    if (db.length > 0) lines.push(`- Database: ${db.map(d => d.name).join(", ")}`);

    // Test runner
    const test = scan.techStack.find(t => t.category === "test");
    if (test) lines.push(`- Test runner: ${test.name}`);
    else if (scan.testSetup.pattern) lines.push(`- Tests: ${scan.testSetup.pattern}`);

    // Languages
    const langEntries = Object.entries(scan.languages).sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (langEntries.length > 0) {
      const langNames: Record<string, string> = {
        ".ts": "TypeScript", ".tsx": "TypeScript/React", ".js": "JavaScript",
        ".py": "Python", ".rs": "Rust", ".go": "Go",
      };
      const langs = langEntries.map(([ext]) => langNames[ext] ?? ext).join(", ");
      lines.push(`- Languages: ${langs}`);
    }

    // Build scripts (compact)
    const importantScripts = Object.entries(scan.buildScripts)
      .filter(([k]) => ["build", "dev", "test", "lint"].includes(k));
    if (importantScripts.length > 0) {
      lines.push(`- Scripts: ${importantScripts.map(([k, v]) => `${k}=\`${v}\``).join(", ")}`);
    }

    // Only return if we have meaningful content beyond the header
    return lines.length > 1 ? lines.join("\n") : "";
  }

  async waitForResult(handle: WorkerHandle, timeoutMs: number): Promise<WorkerResult | null> {
    const worker = this.workers.get(handle.agentName);
    if (!worker) return null;

    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), timeoutMs),
    );

    return Promise.race([worker.promise, timeout]);
  }

  async stop(handle: WorkerHandle): Promise<void> {
    const worker = this.workers.get(handle.agentName);
    if (worker) {
      worker.abort.abort();
      this.workers.delete(handle.agentName);
    }
  }

  async isAlive(handle: WorkerHandle): Promise<boolean> {
    return this.workers.has(handle.agentName);
  }

  async captureOutput(handle: WorkerHandle): Promise<string> {
    const worker = this.workers.get(handle.agentName);
    return worker?.textBuffer ?? "";
  }

  getLastError(handle: WorkerHandle): string | null {
    return this.workers.get(handle.agentName)?.lastError ?? null;
  }

  async sendInput(_handle: WorkerHandle, _message: string): Promise<void> {
    // AgentStreamer uses stdin: "ignore" — mid-run corrections are not supported.
    // Corrections are handled post-completion via quality gate and retry.
  }
}
