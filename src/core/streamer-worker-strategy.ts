import type { SubTask, OrchestratorConfig } from "../config/types.ts";
import type { AgentRegistry } from "../agents/registry.ts";
import type { Store } from "../db/store.ts";
import type { WorkerExecutionStrategy, WorkerHandle, WorkerResult } from "./worker-strategy.ts";
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

  constructor(
    private config: OrchestratorConfig,
    private registry: AgentRegistry,
    private store: Store,
  ) {}

  async spawn(subtask: SubTask, maxTurns: number, enrichedPrompt: string): Promise<WorkerHandle> {
    const agentName = `worker-${subtask.id.slice(0, 8)}`;
    const providerConfig = this.config.providers[subtask.provider];
    if (!providerConfig) throw new Error(`Unknown provider: ${subtask.provider}`);

    // Use user-defined profile if available, otherwise fall back to dynamic harness
    const userProfile = this.registry.get(subtask.agentRole);
    const projectDir = process.cwd();
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

    // Worker override: role-aware — design agents keep their full workflow
    const isDesignRole = subtask.agentRole === "design" || subtask.agentRole === "architect";
    const workerOverride = isDesignRole
      ? [
          "[WORKER MODE]",
          "You are a multi-agent worker. The project file tree is provided in the user message — use it instead of running find/ls.",
          "Follow your profile instructions completely — reference-based design, screenshots, quality checks.",
          "Your profile rules (below) take HIGHEST PRIORITY. Do not skip any step in your design process.",
        ].join("\n")
      : [
          "[WORKER MODE — HIGHEST PRIORITY]",
          "You are a multi-agent worker. The project structure and file tree are ALREADY provided in the user message.",
          "SKIP all exploration: do NOT run find, ls, ls -la, or tree commands.",
          "SKIP reading files for analysis. Only Read a file immediately before you Edit it.",
          "Go STRAIGHT to creating and editing files. Start implementation within your first 3 tool calls.",
        ].join("\n");
    systemPrompt = workerOverride + "\n\n" + systemPrompt;

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
      const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
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
