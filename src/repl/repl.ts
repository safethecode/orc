import * as readline from "node:readline/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Orchestrator } from "../core/orchestrator.ts";
import type { OrchestratorConfig, AgentProfile, ModelTier, SubTask, ProviderName, DecompositionResult } from "../config/types.ts";
import { routeTask, suggestAgent, classifyWithSam, type RouteResult, type Classification } from "../core/router.ts";
import { buildCommand } from "../agents/provider.ts";
import { AgentRegistry } from "../agents/registry.ts";
import { buildHarness } from "../agents/harness.ts";
import { StallWatchdog } from "./stall-watchdog.ts";
import { buildDynamicHarnessAsync } from "../agents/dynamic-harness.ts";
import { AgentStreamer, type ToolUseEvent, type StreamResult } from "./streamer.ts";
import { Conversation } from "./conversation.ts";
import { isCommand, handleCommand, COMMANDS, LANGUAGES } from "./commands.ts";
import { TIER_BUDGETS } from "../memory/token-optimizer.ts";
import { CancellationToken } from "../utils/cancellation.ts";
import { notify } from "../utils/notifications.ts";
import { RolloutRecorder } from "../session/rollout.ts";
import { eventBus } from "../core/events.ts";
import { diffFromGhost } from "../utils/ghost-commit.ts";
import { decompose, decomposeWithSam } from "../core/decomposer.ts";
import { ResultCollector } from "../core/result-collector.ts";
import { ContextPropagator } from "../core/context-propagator.ts";
import { scoutSkills, type ScoutResult } from "./skill-scout.ts";
import { scoutMcp, type McpScoutResult } from "../mcp/mcp-scout.ts";
import { ScoutCache } from "./scout-cache.ts";
import { runQualityGate } from "./quality-gate.ts";
import { HashlineEditor } from "../core/hashline.ts";
import { ContextCompactor } from "../core/compaction.ts";
import { RuntimeFallbackManager } from "../core/runtime-fallback.ts";
import { PlanMode } from "./plan-mode.ts";
import { FileRefResolver } from "./file-ref.ts";
import { FilePicker } from "./file-picker.ts";
import { SessionForkManager } from "../core/session-fork.ts";
import { SessionSharer } from "../core/session-share.ts";
import { InputHandler, type InputResult } from "./input-handler.ts";
import { getPhaseModel } from "../core/phase-config.ts";
import { detectRecurringIssues, DEFAULT_QA_CONFIG } from "../core/qa-loop.ts";
import type { QAIssue, ExecutionPhase } from "../config/types.ts";
import * as renderer from "./renderer.ts";
import { LayoutManager } from "./layout-manager.ts";
import { shouldBrainstorm, brainstorm } from "../core/brainstorm.ts";
import { runOptimization, type OptimizationConfig, type OptimizationCallbacks } from "../core/optimization-harness.ts";

async function pollTeamInbox(): Promise<string | null> {
  const teamsDir = join(homedir(), ".claude", "teams");
  try {
    const { readdir } = await import("node:fs/promises");
    const teams = await readdir(teamsDir);
    for (const team of teams) {
      const configPath = join(teamsDir, team, "config.json");
      const configFile = Bun.file(configPath);
      if (!(await configFile.exists())) continue;
      const config = (await configFile.json()) as { members?: Array<{ name: string }> };
      const leadName = config.members?.[0]?.name;
      if (!leadName) continue;
      const inboxPath = join(teamsDir, team, "inboxes", `${leadName}.json`);
      const inboxFile = Bun.file(inboxPath);
      if (!(await inboxFile.exists())) continue;
      const messages = (await inboxFile.json()) as Array<{ from: string; text: string; read: boolean }>;
      const unread = messages.filter(
        (m) => !m.read && !m.text?.startsWith('{"type":"idle'),
      );
      if (unread.length === 0) continue;
      // Mark as read
      for (const msg of messages) msg.read = true;
      await Bun.write(inboxPath, JSON.stringify(messages, null, 2));
      // Show messages in terminal
      renderer.separator();
      renderer.info(`\x1b[1m\x1b[36m📨 ${unread.length} message(s) from team [${team}]\x1b[0m`);
      for (const m of unread) {
        const preview = m.text.length > 150 ? m.text.slice(0, 150) + "..." : m.text;
        renderer.info(`\x1b[36m  [${m.from}]\x1b[0m ${preview}`);
      }
      renderer.separator();
      // Format as prompt
      const formatted = unread
        .map((m) => `[${m.from}]: ${m.text}`)
        .join("\n\n---\n\n");
      return `Your team agents sent the following messages. Review them, then decide and execute the next steps:\n\n${formatted}`;
    }
  } catch {
    /* no teams or read error */
  }
  return null;
}

/**
 * Extract an @agent mention from input, disambiguating from @file references.
 * Agent names are simple words (no dots/slashes), file refs have path characters.
 */
function extractAgentMention(
  input: string,
  registry: AgentRegistry,
): { agent: string; cleanedInput: string } | null {
  const match = input.match(/(?:^|\s)@([a-zA-Z][\w-]*)\b/);
  if (!match) return null;
  const name = match[1].toLowerCase();
  // Check both lowercase and capitalized forms (e.g. "sam" → "Sam")
  const capitalized = name.charAt(0).toUpperCase() + name.slice(1);
  if (!registry.has(name) && !registry.has(capitalized)) return null;
  const resolved = registry.has(name) ? name : capitalized;
  const cleanedInput = input.replace(match[0], "").trim();
  return { agent: resolved, cleanedInput };
}

export async function startRepl(
  orchestrator: Orchestrator,
  config: OrchestratorConfig,
): Promise<void> {
  const conversation = new Conversation();
  const planMode = new PlanMode();
  const fileRef = new FileRefResolver(process.cwd());
  fileRef.warmCache().catch(() => {});
  const forkManager = new SessionForkManager();
  const inputHandler = orchestrator.getInputHandler();
  let currentStreamer: AgentStreamer | null = null;
  let currentCancellation: CancellationToken | null = null;
  let hasInteraction = false;
  let pinnedAgent: string | null = null;

  // Split-pane layout manager
  const layout = new LayoutManager();
  renderer.setLayoutManager(layout);

  // File watcher consumer: track recent external file changes
  const recentFileChanges: string[] = [];
  eventBus.on("file:change", (e: any) => {
    const file = (e as { file: string }).file;
    recentFileChanges.push(file);
    if (recentFileChanges.length > 20) recentFileChanges.shift();
    // Show notification only when idle (not during generation or prompt input)
    if (!currentStreamer?.isRunning && !promptActive) {
      renderer.info(`\x1b[2mfile changed externally: ${file.split("/").pop()}\x1b[0m`);
    }
  });

  // Deferred rollout: only create file when user actually sends a message
  const rollout = new RolloutRecorder(
    `${config.orchestrator.dataDir}/sessions`,
  );

  // Session-level caches to avoid redundant Haiku scout calls
  const mcpScoutCache = new ScoutCache();
  const skillScoutCache = new ScoutCache();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    completer: (line: string): [string[], string] => {
      // When file picker is active, return empty to prevent readline Tab behavior
      if (filePicker?.isActive()) return [[], line];
      if (line.startsWith("/lang ")) {
        const partial = line.slice(6).toLowerCase();
        const hits = LANGUAGES.filter((l) => l.startsWith(partial));
        return [hits.map((l) => `/lang ${l}`), line];
      }
      if (line.startsWith("/")) {
        const hits = COMMANDS.filter((c) => c.startsWith(line));
        return [hits.length ? hits : COMMANDS, line];
      }
      return [[], line];
    },
  });

  const filePicker = new FilePicker(fileRef, () => refreshLine());

  // ── Inline ghost hint for / commands ─────────────────────────────
  // Writes dim text AFTER the cursor on the SAME line. No \n ever.
  // Truncated to terminal width so it never wraps.
  let promptActive = false;
  const PROMPT_VIS = 2; // visible width of "❯ "

  // Force readline to redraw its line. Bun lacks _refreshLine, so
  // we clear and rewrite the prompt + line content manually.
  let currentPrompt = renderer.PROMPT;
  function refreshLine(): void {
    if ((rl as any)._refreshLine) {
      (rl as any)._refreshLine();
      return;
    }
    const line = (rl as any).line ?? "";
    const cursor = (rl as any).cursor ?? line.length;
    const cursorCol = PROMPT_VIS + cursor + 1;
    process.stdout.write(`\r\x1b[2K${currentPrompt}${line}\x1b[${cursorCol}G`);
  }

  process.stdin.on("keypress", (_str: string | undefined, key: { name?: string }) => {
    if (!promptActive) return;

    // On enter: clean up picker if active
    if (key?.name === "return" || key?.name === "enter") {
      if (filePicker.isActive()) {
        filePicker.clearRender();
        filePicker.deactivate();
      }
      return;
    }

    setImmediate(() => {
      const line = rl.line;
      const cursor = rl.cursor;

      // ── File picker logic ──────────────────────────────────────
      if (filePicker.isActive()) {
        const action = _pickerAction;
        _pickerAction = null;

        // Tab → accept selected file
        if (action === "tab") {
          // Restore line (readline's completer returned empty, but undo any side-effects)
          (rl as any).line = _pickerSavedLine;
          (rl as any).cursor = _pickerSavedCursor;

          const selected = filePicker.getSelected();
          if (selected) {
            const atIdx = filePicker.getAtIndex();
            const before = _pickerSavedLine.slice(0, atIdx);
            const after = _pickerSavedLine.slice(_pickerSavedCursor);
            (rl as any).line = before + "@" + selected.path + " " + after;
            (rl as any).cursor = atIdx + 1 + selected.path.length + 1;
          }
          refreshLine();
          filePicker.clearRender();
          filePicker.deactivate();
          return;
        }

        // Up/Down → move selection (undo readline history navigation)
        if (action === "up" || action === "down") {
          (rl as any).line = _pickerSavedLine;
          (rl as any).cursor = _pickerSavedCursor;
          refreshLine();
          filePicker.moveSelection(action === "up" ? 1 : -1);
          filePicker.render();
          return;
        }

        // Escape → cancel picker
        if (action === "escape") {
          filePicker.clearRender();
          filePicker.deactivate();
          return;
        }

        // Normal key (typing) → update query
        const atIdx = filePicker.getAtIndex();
        if (cursor <= atIdx || line[atIdx] !== "@") {
          filePicker.clearRender();
          filePicker.deactivate();
        } else {
          const query = line.slice(atIdx + 1, cursor);
          filePicker.updateQuery(query);
          filePicker.render();
        }
        return; // Skip ghost hint when picker active
      }

      // Detect @ trigger: last @ before cursor with whitespace/start prefix
      const beforeCursor = line.slice(0, cursor);
      const lastAt = beforeCursor.lastIndexOf("@");
      if (lastAt >= 0 && (lastAt === 0 || /\s/.test(line[lastAt - 1]))) {
        const query = line.slice(lastAt + 1, cursor);
        if (!/\s/.test(query)) {
          filePicker.activate(lastAt);
          filePicker.updateQuery(query);
          filePicker.render();
          return; // Skip ghost hint
        }
      }

      // ── Ghost hint for / commands (unchanged) ──────────────────
      if (!line.startsWith("/")) return;

      const endCol = PROMPT_VIS + line.length + 1; // 1-indexed
      const cursorCol = PROMPT_VIS + rl.cursor + 1;

      // Clear previous hint (everything past user input)
      process.stdout.write(`\x1b[${endCol}G\x1b[K`);

      let display: string;
      if (line.startsWith("/lang ")) {
        const partial = line.slice(6).toLowerCase();
        const hits = LANGUAGES.filter((l) => l.startsWith(partial));
        display = (hits.length ? hits : LANGUAGES).join(" · ");
      } else {
        const hits = COMMANDS.filter((c) => c.startsWith(line));
        display = (hits.length ? hits : COMMANDS).join("  ");
      }

      // Truncate to fit terminal width
      const termW = process.stdout.columns || 80;
      const available = termW - endCol - 2;
      if (available > 3) {
        const hint = display.length > available
          ? display.slice(0, available - 1) + "\u2026"
          : display;
        process.stdout.write(`  \x1b[2m${hint}\x1b[0m`);
      }

      // Restore cursor to where the user is typing
      process.stdout.write(`\x1b[${cursorCol}G`);
    });
  });

  // ── Picker key interception via prependListener ────────────────────
  // Bun's readline lacks _ttyWrite, so we save state BEFORE readline
  // processes the key (prependListener), then undo + apply in setImmediate.
  let _pickerSavedLine = "";
  let _pickerSavedCursor = 0;
  let _pickerAction: "tab" | "up" | "down" | "escape" | null = null;

  process.stdin.prependListener("keypress", (_str: string | undefined, key: { name?: string }) => {
    if (!promptActive || !filePicker.isActive()) return;

    // Snapshot readline state before it processes this key
    _pickerSavedLine = rl.line;
    _pickerSavedCursor = rl.cursor;

    if (key?.name === "tab") _pickerAction = "tab";
    else if (key?.name === "up") _pickerAction = "up";
    else if (key?.name === "down") _pickerAction = "down";
    else if (key?.name === "escape") _pickerAction = "escape";
    else _pickerAction = null;
  });

  // Ctrl+C handling: always exit terminal
  process.on("SIGINT", () => {
    if (currentCancellation && !currentCancellation.cancelled) {
      currentCancellation.cancel();
    }
    if (currentStreamer?.isRunning) {
      currentStreamer.abort();
    }
    rl.close();
  });

  // Clear screen and move cursor to top
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");

  // Welcome with profile names
  const profiles = orchestrator.getRegistry().list().map((p) => p.name);
  renderer.welcome(profiles);

  // Show connected MCP servers
  const mcpManager = orchestrator.getMcpManager();
  const mcpServers = mcpManager.getConnectedServers();
  if (mcpServers.length > 0) {
    renderer.mcpStatus(mcpServers, mcpManager.getToolCount());
  }

  // Show detected formatters
  const detectedFormatters = orchestrator.getFormatter().listDetected();
  if (detectedFormatters.length > 0) {
    renderer.info(`\x1b[2mFormatters: ${detectedFormatters.join(", ")}\x1b[0m`);
  }

  // Show active theme
  const theme = orchestrator.getThemeManager().get();
  if (theme.name !== "default") {
    renderer.info(`\x1b[2mTheme: ${theme.name}\x1b[0m`);
  }

  // Show loaded plugins
  const plugins = orchestrator.getPluginManager().list();
  if (plugins.length > 0) {
    renderer.info(`\x1b[2mPlugins: ${plugins.map(p => p.name).join(", ")}\x1b[0m`);
  }

  // Show ast-grep availability
  const astGrepAvailable = await orchestrator.getAstGrep().isAvailable();
  if (astGrepAvailable) {
    renderer.info(`\x1b[2mAST-Grep: available\x1b[0m`);
  }

  // Show active boulder (resume context)
  const activeBoulder = await orchestrator.getBoulderManager().loadLatest();
  if (activeBoulder) {
    const pct = activeBoulder.totalSteps > 0
      ? Math.round((activeBoulder.completedSteps.length / activeBoulder.totalSteps) * 100)
      : 0;
    renderer.info(`\x1b[2mBoulder: "${activeBoulder.task}" ${pct}% (${activeBoulder.status})\x1b[0m`);
  }

  // Show notepad count
  const notepadNames = orchestrator.getNotepadManager().listNotepads();
  if (notepadNames.length > 0) {
    renderer.info(`\x1b[2mNotepads: ${notepadNames.join(", ")}\x1b[0m`);
  }

  // Show last session hint if available, then consume it from DB
  const lastSnapshot = orchestrator.getStore().getLatestSnapshot();
  let pendingSnapshot: typeof lastSnapshot = lastSnapshot;
  if (lastSnapshot) {
    const summary = lastSnapshot.summary || "no summary";
    renderer.info(
      `\x1b[2mPrevious session: ${lastSnapshot.turnCount} turns, ${lastSnapshot.createdAt} \u2014 "${summary}"\x1b[0m`,
    );
    renderer.info("\x1b[2mType /resume to continue or start fresh\x1b[0m");
    orchestrator.getStore().deleteSnapshot(lastSnapshot.id);
  }

  // Wire crash recovery signal handlers
  orchestrator.getCrashRecovery().bindSignalHandlers(async () => {
    await orchestrator.shutdown();
  });

  // Capture initial git snapshot for undo/redo
  const gitSnapshots = orchestrator.getGitSnapshots();
  gitSnapshots.capture(0, "session-start").catch(() => {});

  // Emit session:start plugin hook
  orchestrator.getPluginManager().emit("session:start", {
    data: { projectDir: process.cwd() },
    projectDir: process.cwd(),
  }).catch(() => {});

  // Prewarm DNS cache while user reads welcome screen
  orchestrator.getPrewarmer().prewarm().catch(() => {});

  // Activate split-pane layout (scroll region + status bar + input area)
  layout.activate();
  process.stdout.on("resize", () => layout.handleResize());

  // Delegate keypress events to layout manager when not at readline prompt
  process.stdin.on("keypress", (str: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string }) => {
    if (!promptActive && layout.isInAgentMode()) {
      // ESC → abort running agent immediately
      if (key?.name === "escape") {
        if (currentCancellation && !currentCancellation.cancelled) {
          currentCancellation.cancel();
        }
        if (currentStreamer?.isRunning) {
          currentStreamer.abort();
        }
        renderer.stopSpinner();
        renderer.notifyIdle();
        process.stdout.write("\n");
        renderer.info("Generation aborted.");
        return;
      }
      layout.handleKeypress(str, key);
    }
  });

  let pendingMessages: string[] = [];

  try {
    while (true) {
      let input: string;

      // Check for queued messages from split-pane input
      if (pendingMessages.length > 0) {
        input = pendingMessages.shift()!;
        renderer.info(`\x1b[2m→ queued: ${input.length > 60 ? input.slice(0, 60) + "..." : input}\x1b[0m`);
      } else {
        try {
          promptActive = true;
          renderer.setPromptActive(true);
          currentPrompt = planMode.isActive()
            ? `\x1b[1m\x1b[33m[plan]\x1b[35m ❯\x1b[0m `
            : renderer.PROMPT;
          input = await rl.question(currentPrompt);
          promptActive = false;
          renderer.setPromptActive(false);
          if (filePicker.isActive()) {
            filePicker.clearRender();
            filePicker.deactivate();
          }
        } catch {
          promptActive = false;
          renderer.setPromptActive(false);
          if (filePicker.isActive()) {
            filePicker.clearRender();
            filePicker.deactivate();
          }
          break;
        }
      }

      // Multi-line input: backslash continuation (\ at end of line)
      while (input.trimEnd().endsWith("\\")) {
        input = input.trimEnd().slice(0, -1) + "\n";
        try {
          const nextLine = await rl.question("\x1b[2m...\x1b[0m ");
          input += nextLine;
        } catch { break; }
      }

      const trimmed = input.trim();
      if (!trimmed) continue;

      // Process through InputHandler: inline bash (!cmd), editor (/editor), multiline
      if (inputHandler.isInlineBash(trimmed)) {
        const bashResult = await inputHandler.process(trimmed);
        if (bashResult.text) {
          renderer.info(bashResult.text);
        }
        continue;
      }
      if (inputHandler.isEditorCommand(trimmed)) {
        const editorResult = await inputHandler.process(trimmed);
        if (editorResult.metadata?.cancelled) {
          renderer.info("editor cancelled");
          continue;
        }
        if (editorResult.text) {
          // Feed editor content as regular input
          input = editorResult.text;
        } else {
          continue;
        }
      }

      // /optimize — special handler (runs optimization harness, not regular command)
      if (trimmed.startsWith("/optimize ")) {
        await handleOptimizeCommand(trimmed, orchestrator, config, layout);
        continue;
      }

      if (isCommand(trimmed)) {
        const result = await handleCommand(trimmed, {
          orchestrator,
          conversation,
          planMode,
          forkManager,
          getPinnedAgent: () => pinnedAgent,
          setPinnedAgent: (name) => { pinnedAgent = name; },
          consumePendingSnapshot: () => {
            const snap = pendingSnapshot;
            pendingSnapshot = null;
            return snap;
          },
        });
        if (result === "quit") break;
        continue;
      }

      // Plugin hook: message:before
      await orchestrator.getPluginManager().emit("message:before", {
        data: { input: trimmed },
        projectDir: process.cwd(),
      });

      // Reset doom loop detector for new message
      orchestrator.getDoomLoop().reset();

      // Extract @agent mention before file-ref resolution
      let mentionedAgent: string | null = null;
      let resolvedInput = trimmed;
      if (trimmed.includes("@")) {
        const mention = extractAgentMention(trimmed, orchestrator.getRegistry());
        if (mention) {
          mentionedAgent = mention.agent;
          resolvedInput = mention.cleanedInput;
          renderer.info(`\x1b[36m→ @${mention.agent}\x1b[0m`);
        }
        // File refs on remaining input
        if (resolvedInput.includes("@")) {
          const refResult = await fileRef.resolve(resolvedInput);
          if (refResult.filesIncluded.length > 0) {
            // Annotate resolved file content with hashline anchors
            let annotated = refResult.resolvedInput;
            for (const filePath of refResult.filesIncluded) {
              try {
                const fileObj = Bun.file(filePath);
                if (await fileObj.exists()) {
                  const content = await fileObj.text();
                  const hashAnnotated = HashlineEditor.formatAnnotated(HashlineEditor.annotate(content));
                  // Replace plain content block with hashline-annotated version
                  const plainBlock = "```\n" + content + "\n```";
                  const hashBlock = "```\n" + hashAnnotated + "\n```";
                  if (annotated.includes(plainBlock)) {
                    annotated = annotated.replace(plainBlock, hashBlock);
                  }
                }
              } catch { /* skip annotation on error */ }
            }
            resolvedInput = annotated;
            renderer.info(`\x1b[2m@files: ${refResult.filesIncluded.join(", ")} (hashline annotated)\x1b[0m`);
          }
        }
      }

      // Acquire sleep inhibitor during agent work
      orchestrator.getSleepInhibitor().acquire();

      const cancellation = new CancellationToken();
      currentCancellation = cancellation;

      // Enter agent mode: enable split-pane input queuing
      // Resume stdin so keypress events fire (readline pauses it after question() resolves)
      process.stdin.resume();
      layout.enterAgentMode("agent");

      try {
        await handleNaturalInput(
          resolvedInput,
          orchestrator,
          config,
          conversation,
          rollout,
          cancellation,
          (streamer) => { currentStreamer = streamer; },
          pinnedAgent,
          mentionedAgent,
          mcpScoutCache,
          skillScoutCache,
          planMode,
          forkManager,
          recentFileChanges,
          rl,
          layout,
        );
      } finally {
        // Exit agent mode: collect queued messages
        const queued = layout.exitAgentMode();
        pendingMessages.push(...queued);
        renderer.notifyIdle();
      }
      // Poll team inbox for unread messages from teammates
      const inboxPrompt = await pollTeamInbox();
      if (inboxPrompt) {
        pendingMessages.push(inboxPrompt);
      }

      hasInteraction = true;
      currentStreamer = null;
      currentCancellation = null;

      // Plugin hook: message:after
      orchestrator.getPluginManager().emit("message:after", {
        data: { input: resolvedInput ?? trimmed },
        projectDir: process.cwd(),
      }).catch(() => {});

      // Release sleep inhibitor after agent work
      orchestrator.getSleepInhibitor().release();

      // Desktop notification when terminal is likely unfocused
      notify(`orc: response ready`);

      // Prewarm for next request
      orchestrator.getPrewarmer().prewarm().catch(() => {});

      process.stdout.write("\n");
    }
  } finally {
    layout.deactivate();
    // Auto-save snapshot on exit (only if user actually interacted)
    if (hasInteraction && conversation.length > 0) {
      const snapshot = conversation.toSnapshot();
      orchestrator.getStore().saveSnapshot({
        id: crypto.randomUUID(),
        turnsJson: JSON.stringify(snapshot.turns),
        language: snapshot.language,
        summary: conversation.generateSummary(),
        turnCount: conversation.length,
      });
      eventBus.publish({ type: "session:save", turnCount: conversation.length });

      // Persist rollout (deferred: only written if there was interaction)
      rollout.persist();
    }

    // Emit session:end plugin hook
    await orchestrator.getPluginManager().emit("session:end", {
      data: { turnCount: conversation.length, projectDir: process.cwd() },
      projectDir: process.cwd(),
    }).catch(() => {});

    // Show ghost commit diff summary on exit
    const ghostSha = orchestrator.getGhostSha();
    if (ghostSha) {
      const diff = await diffFromGhost(ghostSha);
      if (diff) {
        renderer.info(`\x1b[2mSession changes:\x1b[0m`);
        const lines = diff.split("\n").slice(0, 5);
        for (const line of lines) renderer.info(`  \x1b[2m${line}\x1b[0m`);
        if (diff.split("\n").length > 5) renderer.info(`  \x1b[2m...\x1b[0m`);
      }
    }

    orchestrator.getSleepInhibitor().release();
    rl.close();
    renderer.info("Goodbye.");
  }
}

async function handleNaturalInput(
  input: string,
  orchestrator: Orchestrator,
  config: OrchestratorConfig,
  conversation: Conversation,
  rollout: RolloutRecorder,
  cancellation: CancellationToken,
  onStreamer: (s: AgentStreamer) => void,
  pinned: string | null,
  mentioned: string | null,
  mcpScoutCache: ScoutCache,
  skillScoutCache: ScoutCache,
  planMode?: PlanMode,
  forkManager?: SessionForkManager,
  recentFileChanges?: string[],
  rl?: readline.Interface,
  layout?: LayoutManager,
): Promise<void> {
  let route: RouteResult;
  let agentName: string;

  if (pinned) {
    const pinnedProfile = orchestrator.getRegistry().get(pinned);
    if (!pinnedProfile) {
      renderer.error(`Pinned profile "${pinned}" not found. Use /agents auto to reset.`);
      return;
    }
    const model = pinnedProfile.model as import("../config/types.ts").ModelTier;
    route = { tier: "medium", model, multiAgent: false, reason: `pinned to ${pinned}` };
    agentName = pinned;
  } else if (mentioned) {
    const mentionedProfile = orchestrator.getRegistry().get(mentioned);
    if (!mentionedProfile) {
      renderer.error(`Agent "${mentioned}" not found.`);
      return;
    }
    const model = mentionedProfile.model as import("../config/types.ts").ModelTier;
    route = { tier: "medium", model, multiAgent: false, reason: `mentioned @${mentioned}` };
    agentName = mentioned;
  } else {
    // Cost-aware routing: estimate cost and pass to router
    const costEstimator = orchestrator.getCostEstimator();
    const costEst = costEstimator.estimate(input);
    route = routeTask(input, config.routing, { costEstimate: costEst });

    // Category-based tier refinement: if category router suggests a different tier, apply it
    const categoryRouter = orchestrator.getCategoryRouter();
    const category = categoryRouter.classify(input);
    const categoryConfig = categoryRouter.getCategory(category);
    if (categoryConfig && categoryConfig.tier !== route.model) {
      route.model = categoryConfig.tier;
      route.reason += ` [category: ${category}]`;
    }

    // Budget enforcement (only when user explicitly enables)
    if (config.orchestrator.budgetEnabled && route.multiAgent
        && costEst.multiAgent.estimatedCostUsd > config.budget.defaultMaxPerTask) {
      renderer.info("Budget exceeded — downgrading to single agent");
      route.multiAgent = false;
    }

    // Show estimate for multi-agent decisions
    if (route.multiAgent) {
      renderer.costEstimate(
        costEst.singleAgent.estimatedCostUsd,
        costEst.multiAgent.estimatedCostUsd,
        costEst.recommendation,
      );
    }

    // Sam (haiku) classifies: development vs conversation
    renderer.info(`\x1b[2m🏷 Sam is classifying...\x1b[0m`);
    const classification = await classifyWithSam(input);
    agentName = classification.agent;
    renderer.info(`\x1b[36m🏷 ${classification.reason}\x1b[0m`);

    // If Sam classified as conversation, override route to skip multi-agent
    if (classification.type === "conversation") {
      route.multiAgent = false;
    }
  }

  if (route.multiAgent) {
    await handleMultiAgent(input, orchestrator, config, conversation, rollout, cancellation, onStreamer, mcpScoutCache, skillScoutCache, forkManager);
    return;
  }

  const profile = orchestrator.getRegistry().get(agentName);
  if (!profile) {
    renderer.error(`No profile found for agent "${agentName}".`);
    return;
  }

  const providerConfig = config.providers[profile.provider];
  if (!providerConfig) {
    renderer.error(`No provider config for "${profile.provider}".`);
    return;
  }

  // Use the actual profile model for display, not the router tier
  const displayModel = (profile.model as ModelTier) ?? route.model;

  // Publish event
  eventBus.publish({ type: "agent:start", agent: agentName, tier: displayModel, reason: route.reason });

  // Show agent header + spinner immediately
  renderer.agentHeader(agentName, displayModel, route.reason);
  renderer.startSpinner(agentName, displayModel);

  // Parallel Haiku scout: skill + MCP discovery (with cache)
  const skillIndex = orchestrator.getSkillIndex();
  const pseudoSubtask = { agentRole: profile.role ?? "coder", prompt: input } as SubTask;
  const cachedSkill = skillScoutCache.get<ScoutResult>(input);
  const cachedMcp = mcpScoutCache.get<McpScoutResult>(input);

  const emptySkill: ScoutResult = { needed: false, skills: [], durationMs: 0 };
  const emptyMcp: McpScoutResult = { needed: false, servers: [], durationMs: 0 };
  const [skillSettled, mcpSettled] = await Promise.allSettled([
    cachedSkill ? Promise.resolve(cachedSkill) : scoutSkills(pseudoSubtask, skillIndex, cancellation.signal).then(r => { skillScoutCache.set(input, r); return r; }),
    cachedMcp ? Promise.resolve(cachedMcp) : scoutMcp(input, cancellation.signal).then(r => { mcpScoutCache.set(input, r); return r; }),
  ]);
  const skillScoutResult = skillSettled.status === "fulfilled" ? skillSettled.value : emptySkill;
  const mcpScoutResult = mcpSettled.status === "fulfilled" ? mcpSettled.value : emptyMcp;

  // Merge Haiku-scouted skills with profile baseline skills
  const baselineEntries = (profile.skills ?? [])
    .map(name => skillIndex.getByName(name))
    .filter((e): e is NonNullable<typeof e> => e != null);

  const seen = new Set<string>();
  const allMatched: typeof baselineEntries = [];
  for (const entry of [...baselineEntries, ...(skillScoutResult.needed ? skillScoutResult.skills : [])]) {
    if (!seen.has(entry.name)) {
      seen.add(entry.name);
      allMatched.push(entry);
    }
  }

  const skillBodies = allMatched.length > 0 ? await skillIndex.resolve(allMatched) : [];

  // Render scout results (pause spinner for clean output)
  const hasScoutOutput = (allMatched.length > 0 && skillBodies.length > 0) || (mcpScoutResult.needed && mcpScoutResult.servers.length > 0);
  if (hasScoutOutput) renderer.stopSpinner();

  if (skillScoutResult.needed && skillScoutResult.skills.length > 0) {
    renderer.skillScout(skillScoutResult.skills.map(s => s.name), skillScoutResult.durationMs);
  }

  const mcpMgr = orchestrator.getMcpManager();
  if (mcpScoutResult.needed && mcpScoutResult.servers.length > 0) {
    const connected = await mcpMgr.connectOnDemand(mcpScoutResult.servers);
    if (connected.length > 0) {
      renderer.mcpScout(connected, mcpScoutResult.durationMs);
    }
  }

  // Restart spinner for prompt building + agent execution
  if (hasScoutOutput) renderer.startSpinner(agentName, route.model);

  // Auto-compact if context is getting too large
  const compactor = new ContextCompactor();
  if (compactor.needsCompaction(conversation.getTurns())) {
    const { turns: compactedTurns, result: compactionResult } = compactor.compact(conversation.getTurns());
    conversation.clear();
    for (const turn of compactedTurns) conversation.add(turn);
    renderer.info(`\x1b[2mauto-compacted: ${compactionResult.originalTurns} → ${compactionResult.compactedTurns} turns (~${compactionResult.compactedTokens.toLocaleString()} tokens)\x1b[0m`);
    eventBus.publish({ type: "context:compact", before: compactionResult.originalTokens, after: compactionResult.compactedTokens });
  }

  // Set tier-specific token budget before building prompt
  conversation.setTokenBudget(TIER_BUDGETS[route.model] ?? TIER_BUDGETS.sonnet);
  const fullPrompt = conversation.buildPrompt(input);

  // Record user turn
  const userTurn = {
    role: "user" as const,
    content: input,
    timestamp: new Date().toISOString(),
  };
  conversation.add(userTurn);
  forkManager?.addTurn(userTurn);
  rollout.append({ type: "turn", timestamp: userTurn.timestamp, data: userTurn });

  const harness = buildHarness({
    agentName,
    role: (profile.role ?? "coder") as import("../config/types.ts").AgentRole,
    provider: profile.provider as import("../config/types.ts").ProviderName,
    parentTaskId: "repl",
    isWorker: false,
  });
  let systemPrompt = harness.systemPrompt;
  systemPrompt += `\n\nYou are working in the project at: ${process.cwd()}`;
  if (profile.systemPrompt) systemPrompt += "\n\n" + profile.systemPrompt;

  // Append pre-resolved skill bodies
  if (skillBodies.length > 0) {
    systemPrompt += "\n\n" + skillBodies.join("\n\n");
  }

  const lang = conversation.getLanguage();
  if (lang) {
    systemPrompt = systemPrompt
      ? `${systemPrompt}\n\nAlways respond in ${lang}.`
      : `Always respond in ${lang}.`;
  }

  // Inject relevant memories into system prompt
  const memories = orchestrator.getMemory().getRelevantMemories(input, agentName, 5);
  const memoryCtx = orchestrator.getMemory().formatForPrompt(memories);
  if (memoryCtx) {
    systemPrompt = systemPrompt ? `${systemPrompt}\n${memoryCtx}` : memoryCtx;
    eventBus.publish({ type: "memory:inject", count: memories.length });
  }

  // Inject relevant architectural decisions
  const decisions = orchestrator.getDecisions().getRelevantDecisions(input);
  if (decisions.length > 0) {
    systemPrompt += "\n\n" + orchestrator.getDecisions().formatForPrompt(decisions);
  }

  // Inject plan mode restrictions
  if (planMode?.isActive()) {
    systemPrompt += "\n\n" + planMode.getSystemPromptAddition();
  }

  // Inject hashline editing instructions for code-editing agents
  const editRoles = ["coder", "tester", "fixer", "reviewer"];
  if (editRoles.includes(profile.role ?? "coder")) {
    systemPrompt += "\n\nHashline editing is available. When reading files, lines are annotated as LINE#HASH (e.g. 15#VK). Use hash anchors for precise edits to avoid stale-line issues.";
  }

  // Inject permission rules context
  const permMgr = orchestrator.getPermissions();
  const bashRules = permMgr.getRulesForTool("bash");
  const editRules = permMgr.getRulesForTool("edit");
  const denyRules = [...bashRules, ...editRules].filter(r => r.action === "deny");
  if (denyRules.length > 0) {
    systemPrompt += "\n\nPermission rules (DENY): " + denyRules.map(r => `${r.tool}: ${r.pattern}`).join(", ");
  }

  // Inject LSP capabilities + diagnostics for mentioned files
  const lspMgr = orchestrator.getLspManager();
  const lspActive = lspMgr.listActive();
  if (lspActive.length > 0) {
    systemPrompt += `\n\nLSP servers active: ${lspActive.join(", ")}. Use /lsp diagnostics <file> or /lsp symbols <file> for structural code navigation.`;
    // Auto-inject diagnostics for files mentioned in the input
    const filePatterns = input.match(/[\w\-./]+\.\w{1,6}/g) ?? [];
    const diagLines: string[] = [];
    for (const pattern of filePatterns.slice(0, 5)) {
      try {
        const diags = await lspMgr.getDiagnostics(pattern);
        for (const d of diags.slice(0, 5)) {
          diagLines.push(`${d.severity} ${d.file}:${d.line + 1}:${d.column + 1} ${d.message}`);
        }
      } catch { /* LSP not started for this language */ }
    }
    if (diagLines.length > 0) {
      systemPrompt += `\n\nCurrent LSP diagnostics:\n${diagLines.join("\n")}`;
    }
  }

  // Inject recent file changes from external editor/IDE
  if (recentFileChanges && recentFileChanges.length > 0) {
    const uniqueChanges = [...new Set(recentFileChanges)].slice(-10);
    systemPrompt += `\n\nRecently changed files (external): ${uniqueChanges.map(f => f.split("/").pop()).join(", ")}. These files may have been modified outside the agent.`;
    recentFileChanges.length = 0; // Clear after injecting
  }

  // Inject custom tools context
  const customToolsCtx = orchestrator.getCustomTools().formatForPrompt();
  if (customToolsCtx) {
    systemPrompt += "\n\n" + customToolsCtx;
  }

  // Inject plugin tools context
  const pluginTools = orchestrator.getPluginManager().getPluginTools();
  if (pluginTools.length > 0) {
    systemPrompt += "\n\nPlugin tools available: " + pluginTools.map(t => `${t.name} (${t.pluginName}): ${t.description}`).join("; ");
  }

  // Inject AST-grep availability
  if (await orchestrator.getAstGrep().isAvailable()) {
    systemPrompt += "\n\nAST-Grep (sg) is available for structural code search and replace. Use patterns like `$FUNC($$$ARGS)` for AST-aware matching.";
  }

  // Inject IntentGate classification context
  const intentGate = orchestrator.getIntentGate();
  const intentResult = intentGate.classify(input);
  if (intentResult.confidence >= 0.7) {
    systemPrompt += "\n\n" + intentGate.formatForPrompt(intentResult);
  }

  // Inject boulder resume context (if active work exists)
  const boulder = await orchestrator.getBoulderManager().loadLatest();
  if (boulder && boulder.status !== "completed") {
    systemPrompt += "\n\n" + orchestrator.getBoulderManager().formatResumeContext(boulder);
  }

  // Inject notepad wisdom
  const notepadWisdom = orchestrator.getNotepadManager().getWisdom("session");
  if (notepadWisdom) {
    systemPrompt += "\n\n" + notepadWisdom;
  }

  // Inject think mode: auto-upgrade model for deep thinking requests
  const thinkMode = orchestrator.getThinkMode();
  const thinkDetect = thinkMode.detect(input);
  if (thinkDetect.shouldUpgrade) {
    const thinkingModel = thinkMode.getThinkingModel(route.model);
    if (thinkingModel !== route.model) {
      systemPrompt += `\n\nDEEP THINKING MODE activated (keyword: "${thinkDetect.keyword}"). Take extra care with reasoning, consider edge cases, and provide thorough analysis.`;
    }
  }

  // Inject fastwork mode: maximum performance mode
  const fastwork = orchestrator.getFastwork();
  if (fastwork.detect(input)) {
    const overrides = fastwork.getOverrides();
    systemPrompt += "\n\n" + fastwork.buildSystemPromptAddition();
  }

  // Inject ultrathink mode: deep reasoning mode
  const ultrathink = orchestrator.getUltrathink();
  const ultrathinkResult = ultrathink.detect(input);
  if (ultrathinkResult.detected) {
    const uthOverrides = ultrathink.getOverrides();
    route.model = uthOverrides.model as import("../config/types.ts").ModelTier;
    systemPrompt += "\n\n" + ultrathink.buildSystemPromptAddition();
    eventBus.publish({ type: "ultrathink:activate", model: uthOverrides.model, overrides: JSON.stringify(uthOverrides) });
  }

  // Inject context from AGENTS.md / CLAUDE.md files
  const ctxInjector = orchestrator.getContextInjector();
  const ctxFiles = ctxInjector.collect(process.cwd());
  if (ctxFiles.length > 0) {
    const ctxContent = ctxInjector.formatForPrompt(ctxFiles);
    if (ctxContent) {
      systemPrompt += "\n\n" + ctxContent;
    }
  }

  // Inject frecency context: recently accessed files
  const frecency = orchestrator.getFrecency();
  const frequentFiles = frecency.getTopFiles(10);
  if (frequentFiles.length > 0) {
    systemPrompt += `\n\nFrequently accessed files: ${frequentFiles.join(", ")}`;
  }

  // Tier-specific response length hint
  if (route.model === "haiku") {
    systemPrompt = systemPrompt
      ? `${systemPrompt}\nKeep responses concise and under 200 words.`
      : "Keep responses concise and under 200 words.";
  }

  // MCP integration: CLI passthrough for Claude, prompt injection for others
  const mcpServerNames = profile.mcpServers ?? (mcpMgr.getConnectedServers().length > 0 ? undefined : []);
  let mcpConfigPath: string | undefined;

  if (mcpMgr.getToolCount() > 0 && !(mcpServerNames && mcpServerNames.length === 0)) {
    if (profile.provider === "claude") {
      mcpConfigPath = mcpMgr.generateMcpConfigJson(mcpServerNames) ?? undefined;
    } else {
      const toolCtx = mcpMgr.formatToolsForPrompt(mcpServerNames);
      if (toolCtx) systemPrompt += "\n\n" + toolCtx;
    }
  }

  // Deliberation protocol: Sonnet ×3 → Opus review → Sonnet rebuttal
  if (shouldBrainstorm(input, route.tier) && !cancellation.cancelled) {
    renderer.updateSpinner("deliberation round 1: sonnet ×3 analyzing...");
    try {
      const bsResult = await brainstorm(input, providerConfig, profile, cancellation.signal, (round, label) => {
        renderer.updateSpinner(`deliberation round ${round}: ${label}...`);
      });
      if (bsResult.synthesized) {
        systemPrompt += "\n\n" + bsResult.synthesized;
        renderer.stopSpinner();
        renderer.info(`\x1b[2mdeliberation: 3 rounds (sonnet→opus→sonnet) in ${(bsResult.durationMs / 1000).toFixed(1)}s\x1b[0m`);
        renderer.startSpinner(agentName, route.model);
      }
    } catch {
      // Deliberation failure is non-fatal — continue without insights
    }
  }

  const cmd = buildCommand(providerConfig, profile, {
    prompt: fullPrompt,
    model: profile.model,
    systemPrompt,
    maxTurns: profile.maxTurns,
    mcpConfig: mcpConfigPath,
  });

  // Retry loop with provider fallback
  const maxRetries = config.supervisor?.maxRetries ?? 2;
  const maxAttempts = maxRetries + 1;
  const selector = orchestrator.getSupervisor().getProviderSelector();
  let currentProfile = profile;
  let currentProviderConfig = providerConfig;
  let currentCmd = cmd;
  let lastError: string | null = null;
  let lastSuccessText: string | null = null;
  let handlerStartTime = Date.now();
  let midTurnDrains = 0;
  const MAX_MID_TURN_DRAINS = 5; // Prevent infinite queue drain loops

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (cancellation.cancelled) break;

    if (attempt > 0) {
      // Fallback to different provider
      const fallback = selector.select(
        { agentRole: currentProfile.role ?? "coder", prompt: input } as SubTask,
        { excluded: [currentProfile.provider as ProviderName] },
      );
      if (fallback.score > 0) {
        const fb = orchestrator.getRegistry().get(fallback.provider);
        if (fb) {
          currentProfile = fb;
          currentProviderConfig = config.providers[fb.provider] ?? currentProviderConfig;
          currentCmd = buildCommand(currentProviderConfig, currentProfile, {
            prompt: fullPrompt,
            model: currentProfile.model,
            systemPrompt,
            maxTurns: currentProfile.maxTurns,
            mcpConfig: mcpConfigPath,
          });
        }
      }
      renderer.retryAttempt(attempt, maxRetries, lastError ?? "unknown");
      renderer.startSpinner(agentName, route.model);
    }

    const streamer = new AgentStreamer();
    onStreamer(streamer);
    let hasContent = false;
    let boxOpen = false;
    // eslint-disable-next-line prefer-const -- mutated inside event handler
    let pendingApproval: { command: string; ruleId: string; message: string } | null = null as any;
    let queueDrainAbort = false;
    const WRITE_TOOLS = new Set(["write", "edit", "create", "patch", "apply_patch"]);

    // ── Monitoring: stall watchdog + spinner stats ──
    let toolCount = 0;
    const spinnerStart = Date.now();
    const watchdog = new StallWatchdog({
      onWarn: (ms, phase) => {
        const sec = Math.round(ms / 1000);
        if (phase === "streaming") {
          renderer.info(`\x1b[33m⚠ stream stalled for ${sec}s. Press ESC to abort.\x1b[0m`);
        } else {
          renderer.info(`\x1b[2m⏳ waiting for response... ${sec}s\x1b[0m`);
        }
      },
      onAutoAbort: (ms, phase) => {
        renderer.error(`Auto-aborting: no activity for ${Math.round(ms / 1000)}s (${phase})`);
        streamer.abort();
      },
    });
    watchdog.start();
    const spinnerTicker = setInterval(() => {
      const elapsed = Math.round((Date.now() - spinnerStart) / 1000);
      const stats = toolCount > 0 ? ` ${elapsed}s \x1b[2m·\x1b[0m ${toolCount} tools` : ` ${elapsed}s`;
      renderer.updateSpinner(`${agentName} is thinking...${stats}`);
    }, 1_000);

    // Real-time streaming: open box on first content, stream into it
    streamer.on("text_delta", (delta: string) => {
      watchdog.touch("streaming");
      if (!boxOpen) {
        renderer.stopSpinner();
        renderer.startBox(route.model);
        boxOpen = true;
      }
      hasContent = true;
      renderer.text(delta);
    });

    // Restart spinner between streaming blocks (fills the visual gap)
    streamer.on("text_complete", () => {
      watchdog.touch("streaming");
      if (boxOpen) {
        renderer.endBox();
        boxOpen = false;
      }
      renderer.startSpinner(agentName, route.model);
    });

    // Live cost updates for status bar
    streamer.on("usage", (usage: { costUsd: number }) => {
      watchdog.touch();
      renderer.updateCostLive(usage.costUsd);
    });

    streamer.on("tool_use", (tool: ToolUseEvent) => {
      watchdog.touch("post_tool");
      toolCount++;
      const inp = tool.input ?? {};
      const detail = (inp.file_path as string) ?? (inp.command as string) ?? (inp.pattern as string) ?? undefined;

      // ── Harness Enforcer: pre-execution validation ──
      const enforcer = orchestrator.getHarnessEnforcer();
      const enforcement = enforcer.check(tool.name, inp as Record<string, unknown>);

      // Suppress display of noop tool calls (bare pwd, echo, etc.)
      const isNoop = enforcement.violations.some(v => v.ruleId === "noop-tool-call");
      if (!isNoop) {
        // Show tool activity to the user (stop spinner → render → restart)
        renderer.stopSpinner();
        if (boxOpen) {
          renderer.toolUse(tool.name, detail, true);
        } else {
          renderer.toolUse(tool.name, detail, false);
        }
        renderer.startSpinner(agentName, route.model);
      }

      // Permission enforcement on tool use
      const permAction = orchestrator.getPermissions().check(tool.name, detail ?? "", agentName);
      if (permAction === "deny") {
        renderer.error(`\x1b[1m⛔ DENIED:\x1b[0m ${tool.name} ${detail ?? ""} — violates permission rules`);
      } else if (permAction === "ask") {
        renderer.info(`\x1b[33m⚠ UNCONFIRMED:\x1b[0m ${tool.name} ${detail ?? ""} — requires approval`);
      }

      if (enforcement.askRequired) {
        // Dangerous command needs user approval — abort immediately to prevent execution
        const cmd = (inp.command as string) ?? tool.name;
        const v = enforcement.violations.find(v => v.severity === "ask");
        pendingApproval = { command: cmd, ruleId: v?.ruleId ?? "command-safety", message: v?.message ?? cmd };
        renderer.stopSpinner();
        if (boxOpen) { renderer.endBox(); boxOpen = false; }
        streamer.abort();
        return;
      }

      // Mid-turn queue drain: if user typed a message while agent is working, abort immediately
      if (layout && layout.getQueuedCount() > 0) {
        queueDrainAbort = true;
        renderer.stopSpinner();
        if (boxOpen) { renderer.endBox(); boxOpen = false; }
        streamer.abort();
        return;
      }

      if (!enforcement.allowed) {
        // Blocked violations — show each
        for (const v of enforcement.violations.filter(v => v.severity === "block")) {
          renderer.error(`\x1b[1m⛔ ENFORCER [${v.ruleId}]:\x1b[0m ${v.message}`);
          if (v.suggestion) renderer.info(`  → ${v.suggestion}`);
        }
      }

      // Warn-level violations (noop suppressed — already handled above)
      for (const v of enforcement.violations.filter(v => v.severity === "warn" && v.ruleId !== "noop-tool-call")) {
        renderer.info(`\x1b[33m⚠ ${v.ruleId}:\x1b[0m ${v.message}`);
      }

      // Inject-level violations (correction prompts queued)
      if (enforcement.injection) {
        renderer.info(`\x1b[2m↩ enforcer correction queued (${enforcement.violations.filter(v => v.severity === "inject").length} rules)\x1b[0m`);
      }

      // Post-execution: record tool call for state tracking
      enforcer.record(tool.name, inp as Record<string, unknown>);

      // Legacy write guard (kept for backward compat — enforcer also checks)
      if ((tool.name === "write" || tool.name === "edit") && inp.file_path) {
        orchestrator.getWriteGuard().checkWrite(inp.file_path as string);
      }
      if (tool.name === "read" && inp.file_path) {
        orchestrator.getWriteGuard().markRead(inp.file_path as string);
      }

      // Track file access for frecency
      if (inp.file_path) {
        orchestrator.getFrecency().record(inp.file_path as string);
      }

      // Non-interactive env guard for bash commands
      if (tool.name === "bash" && inp.command) {
        const niGuard = orchestrator.getNonInteractiveGuard();
        if (niGuard.isInteractive(inp.command as string)) {
          renderer.info(`\x1b[33m⚠ non-interactive:\x1b[0m command "${(inp.command as string).slice(0, 40)}" may be interactive — sanitized`);
        }
      }

      // Plan mode enforcement
      if (planMode?.isActive()) {
        const allowed = planMode.isToolAllowed(tool.name, tool.input ?? {});
        if (!allowed) {
          renderer.error(`\x1b[1m⛔ PLAN MODE:\x1b[0m ${tool.name} blocked — read-only mode active`);
        }
      }

      // Doom loop detection (legacy — enforcer also checks)
      const doomResult = orchestrator.getDoomLoop().record(tool.name, detail ?? "");
      if (doomResult.triggered) {
        renderer.error(`doom loop detected: ${tool.name} called ${doomResult.count}x — agent may be stuck`);
      }

      // Auto-format after file write tool use
      const filePath = (inp.file_path ?? inp.path) as string | undefined;
      if (WRITE_TOOLS.has(tool.name) && filePath) {
        orchestrator.getFormatter().format(filePath).then((formatted) => {
          if (formatted) renderer.info(`\x1b[2mformatted ${filePath.split("/").pop()}\x1b[0m`);
        }).catch(() => {});
        // Comment checker: warn about AI-generated comment patterns (fire-and-forget)
        (async () => {
          try {
            const file = Bun.file(filePath);
            if (await file.exists()) {
              const content = await file.text();
              const checkResult = orchestrator.getCommentChecker().check(filePath, content);
              if (checkResult.issues.length > 0) {
                renderer.info(`\x1b[2mcomment check: ${checkResult.issues.length} AI-pattern issues in ${filePath.split("/").pop()}\x1b[0m`);
              }
            }
          } catch { /* ignore comment check errors */ }
        })();
      }

      // Custom tool execution: if tool name matches a loaded custom tool, execute it
      const customTool = orchestrator.getCustomTools().get(tool.name);
      if (customTool) {
        orchestrator.getCustomTools().execute(tool.name, inp as Record<string, unknown>, {
          projectDir: process.cwd(),
          agentName,
          sessionId: "repl",
        }).then(result => {
          renderer.info(`\x1b[2mcustom tool ${tool.name}: ${result.slice(0, 200)}\x1b[0m`);
        }).catch(() => {});
      }

      // Team/agent visibility: detect Claude Code team operations
      if (tool.name === "TeamCreate") {
        const teamName = (inp.team_name as string) ?? "unknown";
        renderer.info(`\x1b[1m\x1b[36m⚡ Team created: ${teamName}\x1b[0m`);
        const tmuxViz = orchestrator.getTmuxViz();
        tmuxViz.isAvailable().then(async (avail) => {
          if (avail) {
            await tmuxViz.createSession(`orc-${teamName}`);
            renderer.info(`\x1b[2mtmux: session orc-${teamName} created\x1b[0m`);
          }
        }).catch(() => {});
      }
      if (tool.name === "Task") {
        const desc = (inp.description as string) ?? "";
        const agentType = (inp.subagent_type as string) ?? "";
        const tName = (inp.name as string) ?? agentType;
        const bg = inp.run_in_background ? " [bg]" : "";
        renderer.info(`\x1b[1m\x1b[33m→ Agent: ${tName}\x1b[0m \x1b[2m(${agentType}) ${desc}${bg}\x1b[0m`);
        if (inp.name) {
          const tmuxViz = orchestrator.getTmuxViz();
          tmuxViz.isAvailable().then(async (avail) => {
            if (avail) {
              const pane = await tmuxViz.createPane(tName);
              if (pane) {
                await tmuxViz.sendToPane(pane.paneId, `# ${tName}: ${desc}`);
                await tmuxViz.applyLayout();
              }
            }
          }).catch(() => {});
        }
      }
      if (tool.name === "SendMessage") {
        const recipient = (inp.recipient as string) ?? (inp.type as string) ?? "";
        const summary = (inp.summary as string) ?? "";
        const msgType = (inp.type as string) ?? "message";
        renderer.info(`\x1b[35m✉ [${msgType}] → ${recipient}: ${summary}\x1b[0m`);
      }
      if (tool.name === "TaskCreate") {
        const subject = (inp.subject as string) ?? "";
        renderer.info(`\x1b[2m+ Task: ${subject}\x1b[0m`);
      }
      if (tool.name === "TaskUpdate") {
        const tId = (inp.taskId as string) ?? "";
        const st = (inp.status as string) ?? "";
        if (st) {
          const icon = st === "completed" ? "✓" : st === "in_progress" ? "◉" : "○";
          renderer.info(`\x1b[2m${icon} Task ${tId}: ${st}\x1b[0m`);
        }
      }

      if (boxOpen) {
        renderer.toolUse(tool.name, detail, true);
      } else {
        renderer.updateSpinner(`${tool.name} ${detail ? detail.split("/").pop() : ""}`.trim());
      }
      eventBus.publish({ type: "agent:tool", agent: agentName, tool: tool.name, detail });
    });

    streamer.on("error", (msg: string) => {
      renderer.stopSpinner();
      if (boxOpen) renderer.endBox();
      renderer.error(msg);
      eventBus.publish({ type: "agent:error", agent: agentName, message: msg });
    });

    const startTime = Date.now();

    try {
      const result = await streamer.run(currentCmd, cancellation.signal);
      watchdog.stop();
      clearInterval(spinnerTicker);
      renderer.stopSpinner();
      const durationMs = Date.now() - startTime;

      if (boxOpen) {
        renderer.endBox();
      }

      // Handle mid-turn queue drain: user sent a message while agent was working
      if (queueDrainAbort && layout && midTurnDrains < MAX_MID_TURN_DRAINS) {
        midTurnDrains++;
        const drained = layout.drainQueue();
        const userMsg = drained.join("\n");
        renderer.info(`\x1b[2m⚡ mid-turn interjection (${midTurnDrains}/${MAX_MID_TURN_DRAINS}): ${userMsg.length > 60 ? userMsg.slice(0, 60) + "..." : userMsg}\x1b[0m`);

        // Save partial agent response
        if (result.text) {
          conversation.add({ role: "assistant", content: result.text, agentName, tier: route.model, timestamp: new Date().toISOString() });
        }

        // Add user's interjected message
        const interjectedTurn = { role: "user" as const, content: userMsg, timestamp: new Date().toISOString() };
        conversation.add(interjectedTurn);
        forkManager?.addTurn(interjectedTurn);

        // Rebuild prompt with new context and re-run
        conversation.setTokenBudget(TIER_BUDGETS[(currentProfile.model as ModelTier) ?? route.model] ?? TIER_BUDGETS.sonnet);
        const newPrompt = conversation.buildPrompt(userMsg);
        currentCmd = buildCommand(currentProviderConfig, currentProfile, {
          prompt: newPrompt,
          model: currentProfile.model,
          systemPrompt,
          maxTurns: currentProfile.maxTurns,
          mcpConfig: mcpConfigPath,
        });
        renderer.startSpinner(agentName, displayModel);
        queueDrainAbort = false;
        attempt = -1; // Will increment to 0 at loop top
        continue;
      }

      // Handle enforcer approval flow (abort-ask-retry)
      if (pendingApproval) {
        const { command, message } = pendingApproval;
        renderer.error(`\x1b[1m⚠ ENFORCER [command-safety]:\x1b[0m ${message}`);
        renderer.info(`  \x1b[2m${command.slice(0, 200)}\x1b[0m`);

        if (!rl) {
          // No readline available — deny by default
          renderer.info("  \x1b[31mDenied.\x1b[0m (no interactive prompt available)");
          pendingApproval = null;
          return;
        }

        // Ask user for approval via readline
        const answer = await rl.question("  Allow this command? [y/N] ");
        if (answer.trim().toLowerCase() === "y") {
          // Approve and retry
          orchestrator.getHarnessEnforcer().approve(command);
          renderer.info("  \x1b[32mApproved.\x1b[0m Retrying...");
          pendingApproval = null;
          // Re-run with same prompt (recursive call via the retry loop)
          const retryStreamer = new AgentStreamer();
          onStreamer(retryStreamer);
          let retryBox = false;
          retryStreamer.on("text_delta", (d: string) => {
            if (!retryBox) { renderer.stopSpinner(); renderer.startBox(route.model); retryBox = true; }
            renderer.text(d);
          });
          retryStreamer.on("text_complete", () => {
            if (retryBox) { renderer.endBox(); retryBox = false; }
            renderer.startSpinner(agentName, route.model);
          });
          retryStreamer.on("usage", (u: { costUsd: number }) => renderer.updateCostLive(u.costUsd));
          retryStreamer.on("tool_use", (t: ToolUseEvent) => {
            const d = (t.input?.file_path as string) ?? (t.input?.command as string) ?? undefined;
            if (retryBox) renderer.toolUse(t.name, d, true);
            else renderer.updateSpinner(`${t.name} ${d ? d.split("/").pop() : ""}`.trim());
          });
          retryStreamer.on("error", (m: string) => { renderer.stopSpinner(); if (retryBox) renderer.endBox(); renderer.error(m); });
          renderer.startSpinner(agentName, route.model);
          const retryResult = await retryStreamer.run(currentCmd, cancellation.signal);
          renderer.stopSpinner();
          if (retryBox) renderer.endBox();
          // Use retry result instead
          if (retryResult.text) {
            conversation.add({ role: "assistant", content: retryResult.text, agentName, tier: route.model, timestamp: new Date().toISOString() });
          }
          if (retryResult.inputTokens > 0 || retryResult.outputTokens > 0) {
            renderer.cost(retryResult.costUsd, retryResult.inputTokens, retryResult.outputTokens, Date.now() - startTime);
          }
          return;
        } else {
          renderer.info("  \x1b[31mDenied.\x1b[0m Command was not executed.");
          pendingApproval = null;
          conversation.add({ role: "assistant", content: "(user denied the command — execution aborted)", agentName, tier: route.model, timestamp: new Date().toISOString() });
          return;
        }
      }

      // Quality gate
      if (result.text) {
        const critique = runQualityGate({ agentRole: currentProfile.role ?? "coder", prompt: input }, result.text);
        renderer.qualityGate(critique.passes, critique.issues);
      }

      // Record statistics for this turn
      orchestrator.getStatistics().recordTurn({
        tokens: result.inputTokens + result.outputTokens,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cost: result.costUsd,
        model: route.model,
        provider: currentProfile.provider,
        toolsUsed: [],
        durationMs,
      });

      if (result.inputTokens > 0 || result.outputTokens > 0) {
        renderer.cost(result.costUsd, result.inputTokens, result.outputTokens, durationMs);
        eventBus.publish({
          type: "agent:done", agent: agentName,
          cost: result.costUsd, inputTokens: result.inputTokens,
          outputTokens: result.outputTokens, durationMs,
        });
      }

      const assistantTurn = {
        role: "assistant" as const,
        content: result.text,
        agentName,
        tier: route.model,
        timestamp: new Date().toISOString(),
      };
      conversation.add(assistantTurn);
      forkManager?.addTurn(assistantTurn);
      rollout.append({ type: "turn", timestamp: assistantTurn.timestamp, data: assistantTurn });

      // Auto-capture git snapshot after each turn
      orchestrator.getGitSnapshots().capture(conversation.length, `turn-${conversation.length}`).catch(() => {});

      // Reset runtime fallback attempts on success
      orchestrator.getRuntimeFallback().resetAttempts(agentName);

      lastSuccessText = result.text;
      break; // Success — exit retry loop
    } catch (e) {
      lastError = (e as Error).message;
      watchdog.stop();
      clearInterval(spinnerTicker);
      renderer.stopSpinner();
      if (boxOpen) renderer.endBox();

      // Runtime fallback: parse HTTP status and decide action
      const httpStatus = RuntimeFallbackManager.parseHttpStatus(lastError);
      if (httpStatus) {
        const fallbackAction = orchestrator.getRuntimeFallback().handleError(
          agentName, httpStatus, currentProfile.provider, currentProfile.model as string,
        );
        if (fallbackAction) {
          if (fallbackAction.action === "wait_retry" && fallbackAction.waitMs) {
            renderer.info(`\x1b[2mHTTP ${httpStatus}: waiting ${fallbackAction.waitMs}ms before retry\x1b[0m`);
            await new Promise(r => setTimeout(r, fallbackAction.waitMs));
          } else if (fallbackAction.action === "switch_provider" || fallbackAction.action === "switch_model") {
            renderer.info(`\x1b[2mHTTP ${httpStatus}: switching to ${fallbackAction.provider}/${fallbackAction.model}\x1b[0m`);
          }
        }
      }

      if (attempt === maxAttempts - 1) {
        renderer.error(`All ${maxAttempts} attempts failed: ${lastError}`);
      }
    }
  }

  // Ralph Loop: autonomous continuation when task appears incomplete
  if (lastSuccessText && !cancellation.cancelled) {
    const ralph = orchestrator.getRalphLoop();
    const ralphResult = await ralph.run(input, async (iteration, previousOutput) => {
      if (iteration === 0) return lastSuccessText!;

      // Build continuation prompt and re-run agent
      const contPrompt = previousOutput ?? `Continue working on: ${input}`;
      const contTurn = { role: "user" as const, content: contPrompt, timestamp: new Date().toISOString() };
      conversation.add(contTurn);
      forkManager?.addTurn(contTurn);

      renderer.info(`\x1b[2mauto-loop iteration ${iteration + 1}: continuing...\x1b[0m`);
      renderer.startSpinner(agentName, displayModel);

      const contCmd = buildCommand(currentProviderConfig, currentProfile, {
        prompt: contPrompt,
        model: currentProfile.model,
        systemPrompt,
        maxTurns: currentProfile.maxTurns,
        mcpConfig: mcpConfigPath,
      });

      const contStreamer = new AgentStreamer();
      onStreamer(contStreamer);
      let contBoxOpen = false;

      contStreamer.on("text_delta", (delta: string) => {
        if (!contBoxOpen) {
          renderer.stopSpinner();
          renderer.startBox(route.model);
          contBoxOpen = true;
        }
        renderer.text(delta);
      });
      contStreamer.on("tool_use", (tool: ToolUseEvent) => {
        const inp = tool.input ?? {};
        const detail = (inp.file_path as string) ?? (inp.command as string) ?? undefined;
        if (contBoxOpen) renderer.toolUse(tool.name, detail, true);
        else renderer.updateSpinner(`${tool.name} ${detail ? (detail as string).split("/").pop() : ""}`.trim());
      });

      const contResult = await contStreamer.run(contCmd, cancellation.signal);
      renderer.stopSpinner();
      if (contBoxOpen) renderer.endBox();

      if (contResult.inputTokens > 0 || contResult.outputTokens > 0) {
        renderer.cost(contResult.costUsd, contResult.inputTokens, contResult.outputTokens, 0);
      }

      const assistantTurn = {
        role: "assistant" as const,
        content: contResult.text,
        agentName,
        tier: route.model,
        timestamp: new Date().toISOString(),
      };
      conversation.add(assistantTurn);
      forkManager?.addTurn(assistantTurn);

      return contResult.text;
    });

    if (ralphResult.totalIterations > 1) {
      renderer.info(`\x1b[2mauto-loop: ${ralphResult.totalIterations} iterations, ${ralphResult.reason}\x1b[0m`);
    }
  }

  // Todo continuation: check for unchecked todos in final output
  if (lastSuccessText) {
    const todoCont = orchestrator.getTodoContinuation();
    if (todoCont.shouldContinue(lastSuccessText, 0)) {
      renderer.info(`\x1b[2mtodo-continuation: unchecked items detected in output\x1b[0m`);
    }
  }

  // Session notification: notify on completion if agent took >30s
  if (lastSuccessText && (Date.now() - handlerStartTime) > 30_000) {
    orchestrator.getNotifier().notify("Task Complete", `Agent ${agentName} finished`);
  }
}

async function handleMultiAgent(
  input: string,
  orchestrator: Orchestrator,
  config: OrchestratorConfig,
  conversation: Conversation,
  rollout: RolloutRecorder,
  cancellation: CancellationToken,
  onStreamer: (s: AgentStreamer) => void,
  mcpScoutCache: ScoutCache,
  skillScoutCache: ScoutCache,
  forkManager?: SessionForkManager,
): Promise<void> {
  const taskId = `repl-${Date.now().toString(36)}`;

  // 1. Decompose via Sam (haiku) — falls back to regex-based decomposition
  renderer.info(`\x1b[2m🏷 Sam is decomposing task...\x1b[0m`);
  const decomposition = await decomposeWithSam(input, taskId);

  // Single subtask fallback → run as normal single agent
  if (decomposition.subtasks.length <= 1) {
    const st = decomposition.subtasks[0];
    const agentName = suggestAgent(st.agentRole === "architect" ? "complex" : "medium");
    const profile = orchestrator.getRegistry().get(agentName);
    if (!profile) {
      renderer.error(`No profile found for agent "${agentName}".`);
      return;
    }
    const providerConfig = config.providers[profile.provider];
    if (!providerConfig) {
      renderer.error(`No provider config for "${profile.provider}".`);
      return;
    }
    const route: RouteResult = {
      tier: "medium",
      model: (profile.model as ModelTier) ?? "sonnet",
      multiAgent: false,
      reason: "single subtask fallback",
    };
    renderer.agentHeader(agentName, route.model, route.reason);
    renderer.startSpinner(agentName, route.model);

    const harness = buildHarness({
      agentName,
      role: (profile.role ?? "coder") as import("../config/types.ts").AgentRole,
      provider: profile.provider as import("../config/types.ts").ProviderName,
      parentTaskId: "repl",
      isWorker: false,
    });
    const cmd = buildCommand(providerConfig, profile, {
      prompt: conversation.buildPrompt(input),
      model: profile.model,
      systemPrompt: harness.systemPrompt + `\n\nYou are working in the project at: ${process.cwd()}`,
      maxTurns: profile.maxTurns,
    });

    const streamer = new AgentStreamer();
    onStreamer(streamer);
    let boxOpen = false;

    streamer.on("text_delta", (delta: string) => {
      if (!boxOpen) {
        renderer.stopSpinner();
        renderer.startBox(route.model);
        boxOpen = true;
      }
      renderer.text(delta);
    });
    streamer.on("text_complete", () => {
      if (boxOpen) { renderer.endBox(); boxOpen = false; }
      renderer.startSpinner(agentName, route.model);
    });
    streamer.on("usage", (usage: { costUsd: number }) => {
      renderer.updateCostLive(usage.costUsd);
    });
    streamer.on("tool_use", (tool: ToolUseEvent) => {
      const inp = tool.input ?? {};
      const detail = (inp.file_path as string) ?? (inp.command as string) ?? (inp.pattern as string) ?? undefined;
      if (boxOpen) {
        renderer.toolUse(tool.name, detail, true);
      } else {
        renderer.updateSpinner(`${tool.name} ${detail ? detail.split("/").pop() : ""}`.trim());
      }
    });
    streamer.on("error", (msg: string) => {
      renderer.stopSpinner();
      if (boxOpen) renderer.endBox();
      renderer.error(msg);
    });

    const startTime = Date.now();
    try {
      const result = await streamer.run(cmd, cancellation.signal);
      renderer.stopSpinner();
      const durationMs = Date.now() - startTime;
      if (boxOpen) renderer.endBox();
      renderer.cost(result.costUsd, result.inputTokens, result.outputTokens, durationMs);
      conversation.add({ role: "assistant", content: result.text, agentName, tier: route.model, timestamp: new Date().toISOString() });
      rollout.append({ type: "turn", timestamp: new Date().toISOString(), data: { role: "assistant", content: result.text } });
    } catch (e) {
      renderer.stopSpinner();
      if (boxOpen) renderer.endBox();
      renderer.error(`Agent execution failed: ${(e as Error).message}`);
    }
    return;
  }

  // 2. Assign provider/model per subtask using phase-aware model selection
  const selector = orchestrator.getSupervisor().getProviderSelector();
  for (const subtask of decomposition.subtasks) {
    // Map agent role to execution phase for model selection
    const roleToPhase: Record<string, ExecutionPhase> = {
      architect: "planning", planner: "planning", designer: "spec",
      coder: "coding", tester: "qa", reviewer: "review", fixer: "fix",
    };
    const phase = roleToPhase[subtask.agentRole] ?? "coding";
    const phaseModel = getPhaseModel(phase);

    const selection = selector.selectWithFallback(subtask, {
      requireToolUse: subtask.agentRole === "coder" || subtask.agentRole === "tester",
    });
    subtask.provider = selection.provider;
    // Prefer phase-config model tier, fall back to selector's pick
    subtask.model = phaseModel.model ?? selection.model;
  }

  // 3. Risk prediction
  const prediction = await orchestrator.getPredictor().predict(input);
  if (prediction.risks.length > 0) {
    renderer.riskAssessment(prediction.risks.map(r => `${r.likelihood}: ${r.description}`));
  }

  // 4. Show plan + init HUD tracking
  renderer.planSummary(decomposition.subtasks, decomposition.executionPlan);
  renderer.getLayoutManager()?.setSubtaskCount(decomposition.subtasks.length);
  eventBus.publish({
    type: "supervisor:plan",
    taskId,
    phases: decomposition.executionPlan.phases.length,
    estimatedCost: 0,
  });

  // Record user turn
  const userTurn = { role: "user" as const, content: input, timestamp: new Date().toISOString() };
  conversation.add(userTurn);
  forkManager?.addTurn(userTurn);
  rollout.append({ type: "turn", timestamp: userTurn.timestamp, data: userTurn });

  // Tmux visualization: create panes for parallel agents
  const tmuxViz = orchestrator.getTmuxViz();
  const tmuxAvailable = await tmuxViz.isAvailable();
  if (tmuxAvailable) {
    await tmuxViz.createSession(`orc-${taskId.slice(-6)}`);
    for (const st of decomposition.subtasks) {
      const pane = await tmuxViz.createPane(`${st.agentRole}-${st.id.slice(-4)}`);
      if (pane) {
        await tmuxViz.sendToPane(pane.paneId, `# ${st.agentRole}: ${st.prompt.slice(0, 60)}...`);
      }
    }
    await tmuxViz.applyLayout();
    renderer.info(`\x1b[2mtmux: ${decomposition.subtasks.length} panes created\x1b[0m`);
  }

  // 5. Create ResultCollector + ContextPropagator + QA tracking
  const collector = new ResultCollector(taskId);
  const propagator = new ContextPropagator(
    orchestrator.getContextBuilder(),
    orchestrator.getWorkerBus(),
    orchestrator.getCompressor(),
  );
  const watcher = orchestrator.getConflictWatcher();
  watcher.clearDiffs();
  const qaHistory: QAIssue[][] = [];

  // 6. Execute phases
  for (const phase of decomposition.executionPlan.phases) {
    if (cancellation.cancelled) break;

    const phaseSubtasks = decomposition.subtasks.filter(
      st => phase.subtaskIds.includes(st.id),
    );
    renderer.phaseHeader(phase.name, phaseSubtasks.length, phaseSubtasks.length > 1);

    if (phaseSubtasks.length > 1) {
      const promises = phaseSubtasks.map(st =>
        executeSubtask(st, orchestrator, config, cancellation, onStreamer, mcpScoutCache, skillScoutCache, decomposition, collector, qaHistory, propagator),
      );
      await Promise.all(promises);
    } else {
      for (const st of phaseSubtasks) {
        if (cancellation.cancelled) break;
        await executeSubtask(st, orchestrator, config, cancellation, onStreamer, mcpScoutCache, skillScoutCache, decomposition, collector, qaHistory, propagator);
      }
    }
  }

  // 7. QA Agent — final verification phase
  if (decomposition.subtasks.length > 1 && !cancellation.cancelled) {
    const allResults = collector.getAllResults();
    const resultSections = allResults.map(r =>
      `### ${r.agentName} (${r.role})\n${r.result}`
    ).join("\n\n---\n\n");

    const qaPrompt = [
      `## Original User Request`,
      input,
      ``,
      `## Completed Phase Results`,
      resultSections,
      ``,
      `Verify the original request was fully achieved. Read actual files, run commands/tests. End with [QA:PASS] or [QA:FAIL reason="..."].`,
    ].join("\n");

    const qaSubtask: SubTask = {
      id: `st-qa-${Date.now().toString(36)}`,
      prompt: qaPrompt,
      parentTaskId: decomposition.subtasks[0].parentTaskId,
      dependencies: decomposition.subtasks.map(st => st.id),
      provider: "claude",
      model: "sonnet",
      agentRole: "qa",
      priority: 999,
      status: "queued",
      result: null,
      estimatedTokens: 20000,
      actualTokens: 0,
      startedAt: null,
      completedAt: null,
    };

    renderer.phaseHeader("qa", 1, false);
    await executeSubtask(qaSubtask, orchestrator, config, cancellation, onStreamer, mcpScoutCache, skillScoutCache, decomposition, collector, qaHistory, propagator);

    // Check QA verdict
    const qaResult = collector.getAllResults().find(r => r.role === "qa");
    if (qaResult) {
      const passed = /\[QA:PASS\]/.test(qaResult.result);
      const failMatch = qaResult.result.match(/\[QA:FAIL\s+reason="([^"]+)"\]/);
      if (passed) {
        renderer.info("\x1b[32m[QA:PASS]\x1b[0m All requirements verified.");
      } else {
        const reason = failMatch?.[1] ?? "Requirements not met";
        renderer.info(`\x1b[31m[QA:FAIL]\x1b[0m ${reason}`);
      }
    }
  }

  // 7b. QA recurring issue detection
  const recurring = detectRecurringIssues(qaHistory, DEFAULT_QA_CONFIG.recurringIssueThreshold);
  if (recurring.length > 0) {
    renderer.riskAssessment(recurring.map(r => `recurring: [${r.severity}] ${r.description}`));
  }

  // 8. Conflict detection
  const conflicts = watcher.analyze();
  if (conflicts.length > 0) {
    renderer.conflictWarning(conflicts.map(c => `${c.severity}: ${c.description}`));
  }

  // 8. Aggregate results
  const aggregated = collector.aggregate();

  if (aggregated.subtaskResults.length > 1) {
    renderer.separator();
    renderer.info("Multi-agent total:");
    renderer.cost(aggregated.totalCost, aggregated.totalTokens, 0, aggregated.totalDurationMs);
    if (aggregated.conflicts.length > 0) {
      renderer.conflictWarning(aggregated.conflicts);
    }
  }

  // 9. Record in conversation — use the dominant tier from subtask results
  const tierCounts = new Map<string, number>();
  for (const sr of aggregated.subtaskResults) {
    const t = decomposition.subtasks.find(s => s.id === sr.subtaskId)?.model ?? "sonnet";
    tierCounts.set(t, (tierCounts.get(t) ?? 0) + 1);
  }
  const dominantTier = ([...tierCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "sonnet") as ModelTier;
  const multiTurn = {
    role: "assistant" as const,
    content: aggregated.mergedOutput,
    agentName: "multi-agent",
    tier: dominantTier,
    timestamp: new Date().toISOString(),
  };
  conversation.add(multiTurn);
  forkManager?.addTurn(multiTurn);
  rollout.append({
    type: "turn",
    timestamp: new Date().toISOString(),
    data: { role: "assistant", content: aggregated.mergedOutput },
  });

  // Auto-capture git snapshot after multi-agent completion
  orchestrator.getGitSnapshots().capture(conversation.length, `multi-turn-${conversation.length}`).catch(() => {});

  // Tmux cleanup after multi-agent completion
  if (tmuxAvailable) {
    await tmuxViz.cleanup().catch(() => {});
  }
}

async function executeSubtask(
  subtask: SubTask,
  orchestrator: Orchestrator,
  config: OrchestratorConfig,
  cancellation: CancellationToken,
  onStreamer: (s: AgentStreamer) => void,
  mcpScoutCache: ScoutCache,
  skillScoutCache: ScoutCache,
  decomposition: DecompositionResult,
  collector: ResultCollector,
  qaHistory: QAIssue[][],
  propagator: ContextPropagator,
): Promise<void> {
  const agentName = `${subtask.agentRole}-${subtask.id.slice(-4)}`;
  // Use profile model if available, otherwise fall back to subtask.model
  const profileForSubtask = orchestrator.getRegistry().get(subtask.agentRole);
  const modelTier = (profileForSubtask?.model as ModelTier) ?? (subtask.model as ModelTier);
  const workerBus = orchestrator.getWorkerBus();
  const watcher = orchestrator.getConflictWatcher();

  renderer.agentHeader(agentName, modelTier, subtask.agentRole);
  renderer.startSpinner(agentName, modelTier);

  // Track in HUD
  const lm = renderer.getLayoutManager();
  lm?.workerStarted(agentName, modelTier);

  // Register with WorkerBus for inter-agent communication
  workerBus.registerWorker({
    agentName,
    subtaskId: subtask.id,
    role: subtask.agentRole,
    domain: subtask.agentRole,
    prompt: subtask.prompt.slice(0, 200),
  });

  // Parallel Haiku scout: skill + MCP discovery at the same time (with cache)
  const cacheKey = subtask.prompt;
  const cachedSkill = skillScoutCache.get<ScoutResult>(cacheKey);
  const cachedMcp = mcpScoutCache.get<McpScoutResult>(cacheKey);
  const emptySkillResult: ScoutResult = { needed: false, skills: [], durationMs: 0 };
  const emptyMcpResult: McpScoutResult = { needed: false, servers: [], durationMs: 0 };
  const [skillSettled, mcpSettled] = await Promise.allSettled([
    cachedSkill ? Promise.resolve(cachedSkill) : scoutSkills(subtask, orchestrator.getSkillIndex(), cancellation.signal).then(r => { skillScoutCache.set(cacheKey, r); return r; }),
    cachedMcp ? Promise.resolve(cachedMcp) : scoutMcp(subtask.prompt, cancellation.signal).then(r => { mcpScoutCache.set(cacheKey, r); return r; }),
  ]);
  const skillScoutResult = skillSettled.status === "fulfilled" ? skillSettled.value : emptySkillResult;
  const mcpScoutResult = mcpSettled.status === "fulfilled" ? mcpSettled.value : emptyMcpResult;

  // Render scout results (pause spinner for clean output)
  let skillBodies: string[] = [];
  const hasSubScoutOutput = (skillScoutResult.needed && skillScoutResult.skills.length > 0) || (mcpScoutResult.needed && mcpScoutResult.servers.length > 0);
  if (hasSubScoutOutput) renderer.stopSpinner();

  if (skillScoutResult.needed && skillScoutResult.skills.length > 0) {
    skillBodies = await orchestrator.getSkillIndex().resolve(skillScoutResult.skills);
    renderer.skillScout(skillScoutResult.skills.map(s => s.name), skillScoutResult.durationMs);
  }

  const mcpMgr = orchestrator.getMcpManager();
  if (mcpScoutResult.needed && mcpScoutResult.servers.length > 0) {
    const connected = await mcpMgr.connectOnDemand(mcpScoutResult.servers);
    if (connected.length > 0) {
      renderer.mcpScout(connected, mcpScoutResult.durationMs);
    }
  }

  if (hasSubScoutOutput) renderer.startSpinner(agentName, modelTier);

  // Build enriched prompt via shared ContextPropagator (replaces manual .slice(0, 2000))
  let enrichedPrompt: string;
  try {
    enrichedPrompt = await propagator.buildWorkerPrompt(subtask, decomposition, collector);
  } catch (e) {
    renderer.info(`context propagation failed: ${(e as Error).message} — using raw prompt`);
    eventBus.publish({ type: "agent:error", agent: agentName, message: `context propagation: ${(e as Error).message}` });
    enrichedPrompt = subtask.prompt;
  }

  // System prompt from dynamic harness (role-aware task type + project context)
  const harness = await buildDynamicHarnessAsync({
    agentName,
    role: subtask.agentRole as import("../config/types.ts").AgentRole,
    provider: subtask.provider as import("../config/types.ts").ProviderName,
    parentTaskId: subtask.parentTaskId,
    isWorker: true,
    projectDir: process.cwd(),
    prompt: enrichedPrompt,
  });
  let systemPrompt = harness.systemPrompt;
  systemPrompt += `\n\nYou are working in the project at: ${process.cwd()}`;

  // Inject skill bodies
  if (skillBodies.length > 0) {
    systemPrompt += "\n\n" + skillBodies.join("\n\n");
  }

  // Inject hashline editing instructions for code-editing workers
  const workerEditRoles = ["coder", "tester", "fixer", "reviewer"];
  if (workerEditRoles.includes(subtask.agentRole)) {
    systemPrompt += "\n\nHashline editing is available. When reading files, lines are annotated as LINE#HASH (e.g. 15#VK). Use hash anchors for precise edits to avoid stale-line issues.";
  }

  // Inject relevant memories into worker prompt
  const memories = orchestrator.getMemory().getRelevantMemories(subtask.prompt, agentName, 3);
  const memoryCtx = orchestrator.getMemory().formatForPrompt(memories);
  if (memoryCtx) systemPrompt += "\n" + memoryCtx;

  // Inject architectural decisions into worker prompt
  const decisions = orchestrator.getDecisions().getRelevantDecisions(subtask.prompt);
  if (decisions.length > 0) {
    systemPrompt += "\n\n" + orchestrator.getDecisions().formatForPrompt(decisions);
  }

  // MCP integration: CLI passthrough for Claude, prompt injection for others
  let mcpConfigPath: string | undefined;
  if (mcpMgr.getToolCount() > 0) {
    if (subtask.provider === "claude") {
      mcpConfigPath = mcpMgr.generateMcpConfigJson() ?? undefined;
    } else {
      const toolCtx = mcpMgr.formatToolsForPrompt();
      if (toolCtx) systemPrompt += "\n\n" + toolCtx;
    }
  }

  const adHocProfile: AgentProfile = {
    name: agentName,
    provider: subtask.provider,
    model: subtask.model,
    role: subtask.agentRole,
    maxBudgetUsd: 0,
    requires: [],
    worktree: false,
    systemPrompt,
  };

  // Retry loop with provider fallback
  const maxRetries = config.supervisor?.maxRetries ?? 2;
  const maxAttempts = maxRetries + 1;
  const providerSelector = orchestrator.getSupervisor().getProviderSelector();
  let currentProvider = subtask.provider;
  let currentModel = profileForSubtask?.model ?? subtask.model;
  let lastError: string | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (cancellation.cancelled) break;

    if (attempt > 0) {
      const fallback = providerSelector.select(subtask, {
        excluded: [currentProvider as ProviderName],
      });
      if (fallback.score > 0) {
        currentProvider = fallback.provider;
        currentModel = fallback.model;
      }
      renderer.retryAttempt(attempt, maxRetries, lastError ?? "unknown");
    }

    const providerConfig = config.providers[currentProvider];
    if (!providerConfig) {
      renderer.error(`No provider config for "${currentProvider}"`);
      workerBus.unregisterWorker(agentName);
      return;
    }

    const cmd = buildCommand(providerConfig, { ...adHocProfile, provider: currentProvider, model: currentModel }, {
      prompt: enrichedPrompt,
      model: currentModel,
      systemPrompt,
      mcpConfig: mcpConfigPath,
      workdir: process.cwd(),
    });

    const streamer = new AgentStreamer();
    onStreamer(streamer);
    let boxOpen = false;

    // Real-time streaming
    streamer.on("text_delta", (delta: string) => {
      if (!boxOpen) {
        renderer.stopSpinner();
        renderer.startBox(modelTier);
        boxOpen = true;
      }
      renderer.text(delta);
    });
    streamer.on("text_complete", () => {
      if (boxOpen) { renderer.endBox(); boxOpen = false; }
      renderer.startSpinner(agentName, modelTier);
      lm?.workerUpdate(agentName, "thinking");
    });
    streamer.on("usage", (usage: { costUsd: number }) => {
      renderer.updateCostLive(usage.costUsd);
    });

    streamer.on("tool_use", (tool: ToolUseEvent) => {
      const detail = (tool.input?.file_path as string)
        ?? (tool.input?.command as string)
        ?? (tool.input?.pattern as string)
        ?? undefined;
      // Stop spinner so tool activity lines aren't overwritten
      renderer.stopSpinner();
      // Always show agent-prefixed activity line for multi-agent visibility
      renderer.workerToolUse(agentName, tool.name, detail);
      // Highlight file modifications
      if ((tool.name === "Edit" || tool.name === "Write") && tool.input?.file_path) {
        renderer.workerFileChange(agentName, tool.name, tool.input.file_path as string);
      }
      if (boxOpen) {
        renderer.toolUse(tool.name, detail, true);
      }
      // Restart spinner after rendering
      renderer.startSpinner(agentName, modelTier);
      lm?.workerUpdate(agentName, "tool_use", tool.name);
    });

    streamer.on("error", (msg: string) => {
      renderer.stopSpinner();
      if (boxOpen) renderer.endBox();
      renderer.error(msg);
    });

    renderer.startSpinner(agentName, modelTier);
    const startTime = Date.now();

    try {
      const result = await streamer.run(cmd, cancellation.signal);
      renderer.stopSpinner();
      const durationMs = Date.now() - startTime;

      if (boxOpen) renderer.endBox();

      // Quality gate + QA history tracking
      if (result.text) {
        const critique = runQualityGate({ agentRole: subtask.agentRole, prompt: subtask.prompt }, result.text);
        renderer.qualityGate(critique.passes, critique.issues);
        // Track issues for recurring issue detection
        if (critique.issues.length > 0) {
          qaHistory.push(critique.issues.map(desc => ({
            description: desc, severity: "major" as const, file: undefined, suggestion: undefined,
          })));
        }
      }

      renderer.cost(result.costUsd, result.inputTokens, result.outputTokens, durationMs);
      eventBus.publish({
        type: "agent:done", agent: agentName,
        cost: result.costUsd, inputTokens: result.inputTokens,
        outputTokens: result.outputTokens, durationMs,
      });

      // Collect result for aggregation (full WorkerState shape)
      const workerState: import("../config/types.ts").WorkerState = {
        id: agentName,
        subtaskId: subtask.id,
        agentName,
        provider: currentProvider as ProviderName,
        model: currentModel,
        status: "completed",
        progress: 100,
        startedAt: new Date(startTime).toISOString(),
        lastActivityAt: new Date().toISOString(),
        result: result.text,
        error: null,
        tokenUsage: result.inputTokens + result.outputTokens,
        costUsd: result.costUsd,
        currentTurn: 1,
        maxTurns: 1,
        turnHistory: [],
        corrections: [],
        intermediateResults: [],
      };
      collector.collect(workerState, subtask.agentRole as import("../config/types.ts").AgentRole, subtask.agentRole);

      // Record conflict diff
      const collected = collector.getResult(subtask.id);
      if (collected) {
        watcher.recordDiff({
          agentName,
          taskId: subtask.parentTaskId,
          files: collected.files,
          summary: result.text.slice(0, 200),
        });

        // Broadcast artifacts via WorkerBus
        workerBus.broadcastArtifact(agentName, subtask.parentTaskId, {
          files: collected.files,
          apis: collector.extractApis(result.text),
          schemas: collector.extractSchemas(result.text),
        });
      }

      workerBus.unregisterWorker(agentName);
      lm?.workerDone(agentName);
      orchestrator.getRuntimeFallback().resetAttempts(agentName);
      return; // Success — exit retry loop
    } catch (e) {
      lastError = (e as Error).message;
      renderer.stopSpinner();
      if (boxOpen) renderer.endBox();

      // Runtime fallback: parse HTTP status and decide action
      const httpStatus = RuntimeFallbackManager.parseHttpStatus(lastError);
      if (httpStatus) {
        const fallbackAction = orchestrator.getRuntimeFallback().handleError(
          agentName, httpStatus, currentProvider, currentModel,
        );
        if (fallbackAction?.action === "wait_retry" && fallbackAction.waitMs) {
          renderer.info(`\x1b[2mHTTP ${httpStatus}: waiting ${fallbackAction.waitMs}ms before retry\x1b[0m`);
          await new Promise(r => setTimeout(r, fallbackAction.waitMs));
        } else if (fallbackAction && (fallbackAction.action === "switch_provider" || fallbackAction.action === "switch_model")) {
          currentProvider = fallbackAction.provider as ProviderName;
          currentModel = fallbackAction.model;
          renderer.info(`\x1b[2mHTTP ${httpStatus}: switching to ${fallbackAction.provider}/${fallbackAction.model}\x1b[0m`);
        }
      }

      if (attempt === maxAttempts - 1) {
        renderer.error(`All ${maxAttempts} attempts failed: ${lastError}`);
      }
    }
  }

  workerBus.unregisterWorker(agentName);
  lm?.workerDone(agentName);
}

// ── /optimize Command Handler ──────────────────────────────────────

async function handleOptimizeCommand(
  input: string,
  orchestrator: Orchestrator,
  config: OrchestratorConfig,
  layout: LayoutManager,
): Promise<void> {
  // Parse: /optimize "test cmd" "metric regex" target file [--rounds N] [--paths N] [--iters N] [--model tier]
  const parts = input.slice("/optimize ".length);

  // Extract quoted strings and bare args
  const tokens: string[] = [];
  let remaining = parts;
  while (remaining.length > 0) {
    remaining = remaining.trimStart();
    if (remaining.startsWith('"')) {
      const end = remaining.indexOf('"', 1);
      if (end === -1) { tokens.push(remaining.slice(1)); break; }
      tokens.push(remaining.slice(1, end));
      remaining = remaining.slice(end + 1);
    } else {
      const space = remaining.indexOf(" ");
      if (space === -1) { tokens.push(remaining); break; }
      tokens.push(remaining.slice(0, space));
      remaining = remaining.slice(space);
    }
  }

  if (tokens.length < 4) {
    renderer.info("\x1b[1mUsage:\x1b[0m /optimize \"<test-cmd>\" \"<metric-regex>\" <target> <file> [--rounds N] [--paths N] [--iters N] [--model tier] [--unit label] [--context file]");
    renderer.info("\x1b[2mExample:\x1b[0m /optimize \"python tests/test.py\" \"time:\\s+([\\d.]+)\" 50 main.py --unit ms --context config.py");
    return;
  }

  const testCommand = tokens[0];
  const metricPatternStr = tokens[1];
  const target = parseFloat(tokens[2]);
  const targetFile = tokens[3];

  if (isNaN(target)) {
    renderer.error("Target must be a number");
    return;
  }

  let metricPattern: RegExp;
  try {
    metricPattern = new RegExp(metricPatternStr);
  } catch {
    renderer.error(`Invalid regex: ${metricPatternStr}`);
    return;
  }

  // Parse optional flags
  let maxRounds = 5;
  let parallelPaths = 3;
  let maxIterations = 15;
  let explorerModel: ModelTier = "sonnet";
  let metricUnit = "units";
  const contextFiles: string[] = [];

  for (let i = 4; i < tokens.length - 1; i++) {
    if (tokens[i] === "--rounds") maxRounds = parseInt(tokens[++i]) || maxRounds;
    else if (tokens[i] === "--paths") parallelPaths = parseInt(tokens[++i]) || parallelPaths;
    else if (tokens[i] === "--iters") maxIterations = parseInt(tokens[++i]) || maxIterations;
    else if (tokens[i] === "--model") explorerModel = (tokens[++i] as ModelTier) || explorerModel;
    else if (tokens[i] === "--unit") metricUnit = tokens[++i] || metricUnit;
    else if (tokens[i] === "--context") contextFiles.push(tokens[++i]);
  }

  const workdir = process.cwd();

  const optimConfig: OptimizationConfig = {
    testCommand,
    metricPattern,
    target,
    lowerIsBetter: true,
    maxIterations,
    parallelPaths,
    maxRounds,
    workdir,
    targetFile,
    explorerModel,
    metricUnit,
    contextFiles: contextFiles.length > 0 ? contextFiles : undefined,
    goldenDir: `${workdir}/.orc-golden`,
  };

  // Get provider config
  const profile = orchestrator.getRegistry().get("coder");
  if (!profile) {
    renderer.error("No 'coder' profile found");
    return;
  }
  const providerConfig = config.providers[profile.provider];
  if (!providerConfig) {
    renderer.error(`No provider config for "${profile.provider}"`);
    return;
  }

  renderer.separator();
  renderer.info(`\x1b[1mOptimization Harness\x1b[0m`);
  renderer.info(`  test:   ${testCommand}`);
  renderer.info(`  metric: ${metricPatternStr}`);
  renderer.info(`  target: ${target} ${metricUnit}`);
  renderer.info(`  file:   ${targetFile}`);
  renderer.info(`  rounds: ${maxRounds} × ${parallelPaths} paths × ${maxIterations} iters`);
  renderer.info(`  model:  ${explorerModel}`);
  renderer.info(`  unit:   ${metricUnit}`);
  if (contextFiles.length > 0) {
    renderer.info(`  study:  ${contextFiles.join(", ")}`);
  }
  renderer.info(`  golden: ${workdir}/.orc-golden`);
  renderer.separator();

  layout.enterAgentMode("optimize");

  const callbacks: OptimizationCallbacks = {
    onPhaseStart: (phase, name, target) => {
      renderer.phaseStart(phase, name, target);
    },
    onStudyComplete: (durationMs) => {
      renderer.studyComplete(durationMs);
    },
    onRoundStart: (round, paths) => {
      renderer.info(`\n\x1b[1m\x1b[33m▶ Round ${round + 1}\x1b[0m  \x1b[2m${paths} exploration paths\x1b[0m`);
    },
    onIterationComplete: (path, step) => {
      const marker = step.improved ? "\x1b[32m✓\x1b[0m" : step.correct ? "\x1b[33m○\x1b[0m" : "\x1b[31m✗\x1b[0m";
      const metric = step.metric !== null ? `${step.metric}` : "N/A";
      renderer.info(`  ${marker} path ${path} iter ${step.iteration}: ${metric} ${metricUnit} → ${step.action}`);
    },
    onTournamentResult: (round, bestMetric, bestPath) => {
      renderer.info(`\x1b[1m\x1b[32m★ Round ${round + 1} winner:\x1b[0m path ${bestPath} → ${bestMetric} ${metricUnit}`);
    },
    onTestRun: (_path, output) => {
      // Extract metric for live display
      const m = output.match(metricPattern);
      if (m) renderer.updateCostLive(parseFloat(m[1]) || 0);
    },
    onResearchStart: (round) => {
      renderer.researchStart(round);
    },
    onResearchProgress: (phase, detail) => {
      renderer.researchProgress(phase, detail);
    },
    onResearchComplete: (_round, durationMs) => {
      renderer.researchComplete(durationMs);
    },
    onVerification: (path, valid, issue) => {
      renderer.verificationResult(path, valid, issue);
    },
    onGoldenLoaded: (count) => {
      renderer.goldenLoaded(count);
    },
    onGoldenSaved: (metric) => {
      renderer.goldenSaved(metric);
    },
  };

  const cancellation = new CancellationToken();
  const abortController = new AbortController();

  // Allow Ctrl+C to cancel
  const sigHandler = () => {
    cancellation.cancel();
    abortController.abort();
    renderer.info("\n\x1b[33mOptimization cancelled.\x1b[0m");
  };
  process.on("SIGINT", sigHandler);

  try {
    const result = await runOptimization(
      `Optimize ${targetFile} to achieve < ${target} cycles. Test with: ${testCommand}`,
      optimConfig,
      providerConfig,
      profile,
      callbacks,
      abortController.signal,
    );

    renderer.separator();
    renderer.info(`\x1b[1mOptimization Complete\x1b[0m`);
    renderer.info(`  initial:  ${result.initialMetric} cycles`);
    renderer.info(`  best:     ${result.bestMetric} cycles`);
    renderer.info(`  speedup:  ${(result.initialMetric / result.bestMetric).toFixed(1)}x`);
    renderer.info(`  rounds:   ${result.totalRounds}`);
    renderer.info(`  iters:    ${result.totalIterations}`);
    renderer.info(`  duration: ${(result.durationMs / 1000 / 60).toFixed(1)} min`);
    renderer.info(`  reason:   ${result.reason}`);
    renderer.separator();
  } catch (e) {
    renderer.error(`Optimization failed: ${(e as Error).message}`);
  } finally {
    process.removeListener("SIGINT", sigHandler);
    layout.exitAgentMode();
    renderer.notifyIdle();
  }
}
