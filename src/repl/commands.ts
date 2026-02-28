import type { Orchestrator } from "../core/orchestrator.ts";
import type { Conversation } from "./conversation.ts";
import { diffFromGhost } from "../utils/ghost-commit.ts";
import { loadExecPolicy, trustProject, isProjectTrusted } from "../sandbox/rules.ts";
import { getCatalogEntry } from "../mcp/catalog.ts";
import { selectPhases, buildPhasePrompt, parseSpecResult } from "../core/spec-pipeline.ts";
import { buildIdeationPrompt, parseIdeationResponse, prioritizeIdeas, DIMENSION_PROMPTS } from "../core/ideation.ts";
import type { SpecPhase, IdeationDimension } from "../config/types.ts";
import type { PlanMode } from "./plan-mode.ts";
import { SessionForkManager } from "../core/session-fork.ts";
import { ContextCompactor } from "../core/compaction.ts";
import type { SessionSharer } from "../core/session-share.ts";
import * as renderer from "./renderer.ts";

export const COMMANDS = [
  "/status", "/stop", "/clear", "/lang",
  "/budget", "/trace", "/agents", "/messages",
  "/ownership", "/spawn", "/task", "/mcp",
  "/plan", "/fork", "/lsp", "/pause", "/resume", "/sessions", "/memory",
  "/permissions", "/undo", "/redo",
  "/theme", "/models", "/plugins", "/share", "/ast",
  "/pipeline", "/boulder", "/notepad",
  "/oauth", "/category",
  "/doctor", "/stats", "/worktree", "/background", "/stash",
  "/question", "/search", "/tasks", "/handoff", "/refactor",
  "/variants", "/ultrawork", "/github",
  "/diff", "/compact", "/trust", "/consolidate",
  "/checkpoint", "/spec", "/ideate", "/help", "/quit",
];

export const LANGUAGES = [
  "korean", "english", "japanese", "chinese",
  "spanish", "french", "german", "portuguese",
  "russian", "arabic", "italian", "dutch",
];

export interface CommandContext {
  orchestrator: Orchestrator;
  conversation: Conversation;
  planMode?: PlanMode;
  forkManager?: SessionForkManager;
  getPinnedAgent: () => string | null;
  setPinnedAgent: (name: string | null) => void;
}

export function isCommand(input: string): boolean {
  return input.startsWith("/");
}

export async function handleCommand(
  input: string,
  ctx: CommandContext,
): Promise<"continue" | "quit"> {
  const [cmd, ...args] = input.slice(1).split(/\s+/);

  switch (cmd) {
    case "status": {
      const agents = await ctx.orchestrator.listAgents();
      if (agents.length === 0) {
        renderer.info("no agents running");
      } else {
        process.stdout.write("\n");
        renderer.separator();
        for (const agent of agents) {
          const taskInfo = agent.currentTask ? `  \x1b[90mtask: ${agent.currentTask}\x1b[0m` : "";
          const statusColor = agent.status === "running" ? "\x1b[32m" : "\x1b[90m";
          renderer.info(`${statusColor}●\x1b[0m ${agent.name} \x1b[90m${agent.status}\x1b[0m${taskInfo}`);
        }
        renderer.separator();
      }
      return "continue";
    }

    case "stop": {
      const agentName = args[0];
      if (!agentName) {
        renderer.error("usage: /stop <agent-name>");
        return "continue";
      }
      try {
        await ctx.orchestrator.stopAgent(agentName);
        renderer.info(`✓ stopped ${agentName}`);
      } catch (e) {
        renderer.error((e as Error).message);
      }
      return "continue";
    }

    case "clear": {
      ctx.conversation.clear();
      renderer.info("✓ conversation cleared");
      return "continue";
    }

    case "lang": {
      const lang = args[0];
      if (!lang) {
        const current = ctx.conversation.getLanguage();
        process.stdout.write("\n");
        renderer.info(current ? `current: \x1b[1m${current}\x1b[0m` : "no language set (default)");
        renderer.info(`\x1b[2m${LANGUAGES.join(" · ")}\x1b[0m`);
        renderer.info("\x1b[2musage: /lang <language>\x1b[0m");
        process.stdout.write("\n");
      } else {
        ctx.conversation.setLanguage(lang);
        renderer.info(`✓ language set to ${lang}`);
      }
      return "continue";
    }

    case "budget": {
      const store = ctx.orchestrator.getStore();
      const config = ctx.orchestrator.getConfig();
      const tasks = store.listTasks();

      const totalCost = tasks.reduce((sum, t) => sum + (t.costUsd ?? 0), 0);
      const totalTokens = tasks.reduce((sum, t) => sum + (t.tokenUsage ?? 0), 0);
      const taskCount = tasks.filter((t) => t.costUsd && t.costUsd > 0).length;

      const budgetLimit = config.budget?.defaultMaxPerTask ?? 0;
      const budgetEnabled = config.orchestrator?.budgetEnabled ?? false;

      process.stdout.write("\n");
      renderer.info(`\x1b[1mSession Budget\x1b[0m`);
      renderer.info(`  spent: \x1b[1m$${totalCost < 0.01 ? totalCost.toFixed(4) : totalCost.toFixed(2)}\x1b[0m  (${totalTokens.toLocaleString()} tokens, ${taskCount} tasks)`);
      if (budgetEnabled && budgetLimit > 0) {
        const pct = Math.round((totalCost / budgetLimit) * 100);
        const color = pct > 90 ? "\x1b[31m" : pct > 70 ? "\x1b[33m" : "\x1b[32m";
        renderer.info(`  limit: $${budgetLimit.toFixed(2)}  ${color}${pct}% used\x1b[0m`);
      } else {
        renderer.info(`  \x1b[2mbudget enforcement: off\x1b[0m`);
      }

      // Show per-prompt estimate if user provided an argument
      const prompt = args.join(" ");
      if (prompt) {
        const estimator = ctx.orchestrator.getCostEstimator();
        const est = estimator.estimate(prompt);
        process.stdout.write("\n");
        renderer.info(estimator.formatEstimate(est));
      }

      process.stdout.write("\n");
      return "continue";
    }

    case "trace": {
      const tracer = ctx.orchestrator.getTracer();
      const active = tracer.getActiveSpans();
      if (active.length === 0) {
        renderer.info("no active traces");
      } else {
        const seen = new Set<string>();
        for (const span of active) {
          if (seen.has(span.traceId)) continue;
          seen.add(span.traceId);
          const timeline = tracer.toTimeline(span.traceId);
          process.stdout.write(timeline + "\n");
        }
      }
      return "continue";
    }

    case "agents": {
      const sub = args[0];

      if (sub === "select") {
        const name = args[1];
        if (!name) { renderer.error("usage: /agents select <name>"); return "continue"; }
        const profile = ctx.orchestrator.getRegistry().get(name);
        if (!profile) { renderer.error(`unknown profile: "${name}"`); return "continue"; }
        ctx.setPinnedAgent(name);
        renderer.info(`✓ pinned to ${name} (${profile.provider}/${profile.model})`);
        return "continue";
      }

      if (sub === "auto") {
        ctx.setPinnedAgent(null);
        renderer.info("✓ auto routing restored");
        return "continue";
      }

      const profiles = ctx.orchestrator.getRegistry().list();
      const pinned = ctx.getPinnedAgent();
      if (profiles.length === 0) {
        renderer.info("no agent profiles loaded");
      } else {
        process.stdout.write("\n");
        for (const p of profiles) {
          const health = ctx.orchestrator.getHealth().getStatus(p.name);
          const wt = p.worktree ? "worktree" : "shared";
          const statusIcon = health?.sessionAlive ? "\x1b[32m●\x1b[0m" : "\x1b[90m○\x1b[0m";
          const pinMark = pinned === p.name ? " \x1b[33m← pinned\x1b[0m" : "";
          renderer.info(`${statusIcon} ${p.name} \x1b[2m(${p.provider}/${p.model}) ${wt} $${p.maxBudgetUsd}\x1b[0m${pinMark}`);
        }
        process.stdout.write("\n");
      }
      return "continue";
    }

    case "messages": {
      const agentName = args[0];
      if (!agentName) {
        renderer.error("usage: /messages <agent-name>");
        return "continue";
      }
      const inbox = ctx.orchestrator.getInbox();
      const messages = inbox.getHistory(agentName, 10);
      if (messages.length === 0) {
        renderer.info("no messages");
      } else {
        process.stdout.write("\n");
        for (const msg of messages) {
          const dir = msg.from === agentName ? "\x1b[33m→\x1b[0m" : "\x1b[36m←\x1b[0m";
          const other = msg.from === agentName ? msg.to : msg.from;
          renderer.info(`${dir} ${other}: ${msg.content.slice(0, 80)}`);
        }
        process.stdout.write("\n");
      }
      return "continue";
    }

    case "ownership": {
      const report = ctx.orchestrator.getOwnership().formatReport();
      process.stdout.write(report + "\n");
      return "continue";
    }

    case "spawn": {
      const agentName = args[0];
      if (!agentName) {
        renderer.error("usage: /spawn <agent-name>");
        return "continue";
      }
      try {
        const session = await ctx.orchestrator.spawnAgent(agentName);
        renderer.info(`spawned ${agentName} in ${session.name}`);
      } catch (e) {
        renderer.error((e as Error).message);
      }
      return "continue";
    }

    case "task": {
      const agentName = args[0];
      const prompt = args.slice(1).join(" ");
      if (!agentName || !prompt) {
        renderer.error("usage: /task <agent> <prompt>");
        return "continue";
      }
      try {
        const taskId = await ctx.orchestrator.assign(agentName, prompt);
        renderer.info(`task ${taskId.slice(0, 8)} assigned to ${agentName}`);
      } catch (e) {
        renderer.error((e as Error).message);
      }
      return "continue";
    }

    case "pause": {
      if (ctx.conversation.length === 0) {
        renderer.info("nothing to save");
        return "continue";
      }
      const snapshot = ctx.conversation.toSnapshot();
      ctx.orchestrator.getStore().saveSnapshot({
        id: crypto.randomUUID(),
        turnsJson: JSON.stringify(snapshot.turns),
        language: snapshot.language,
        summary: ctx.conversation.generateSummary(),
        turnCount: ctx.conversation.length,
      });
      renderer.info(`\u2713 session saved (${ctx.conversation.length} turns)`);
      return "continue";
    }

    case "resume": {
      const snap = ctx.orchestrator.getStore().getLatestSnapshot();
      if (!snap) {
        renderer.info("no saved session found");
        return "continue";
      }
      const turns = JSON.parse(snap.turnsJson);
      ctx.conversation.restore({ turns, language: snap.language ?? undefined });
      renderer.info(`\u2713 restored ${snap.turnCount} turns from ${snap.createdAt}`);
      return "continue";
    }

    case "sessions": {
      const snapshots = ctx.orchestrator.getStore().listSnapshots(undefined, 10);
      if (snapshots.length === 0) {
        renderer.info("no saved sessions");
        return "continue";
      }
      process.stdout.write("\n");
      for (const s of snapshots) {
        const summary = s.summary || "no summary";
        renderer.info(`\x1b[2m${s.createdAt}\x1b[0m  ${s.turnCount} turns  \x1b[2m${summary}\x1b[0m`);
      }
      process.stdout.write("\n");
      return "continue";
    }

    case "memory": {
      const mem = ctx.orchestrator.getMemory();
      const sub = args[0];

      if (!sub) {
        const entries = mem.list("global", 20);
        if (entries.length === 0) {
          renderer.info("no memories stored");
        } else {
          process.stdout.write("\n");
          for (const e of entries) {
            renderer.info(`\x1b[1m${e.key}\x1b[0m\x1b[2m = ${e.value}\x1b[0m`);
          }
          process.stdout.write("\n");
        }
        return "continue";
      }

      if (sub === "set") {
        const key = args[1];
        const value = args.slice(2).join(" ");
        if (!key || !value) {
          renderer.error("usage: /memory set <key> <value>");
          return "continue";
        }
        mem.set("global", key, value, "user");
        renderer.info(`\u2713 ${key} = ${value}`);
        return "continue";
      }

      if (sub === "get") {
        const key = args[1];
        if (!key) {
          renderer.error("usage: /memory get <key>");
          return "continue";
        }
        const entry = mem.get("global", key);
        if (!entry) {
          renderer.info(`no memory for "${key}"`);
        } else {
          renderer.info(`\x1b[1m${entry.key}\x1b[0m = ${entry.value}`);
        }
        return "continue";
      }

      if (sub === "search") {
        const query = args.slice(1).join(" ");
        if (!query) {
          renderer.error("usage: /memory search <query>");
          return "continue";
        }
        const results = mem.search(query, undefined, 10);
        if (results.length === 0) {
          renderer.info("no matches");
        } else {
          process.stdout.write("\n");
          for (const e of results) {
            renderer.info(`\x1b[1m${e.key}\x1b[0m\x1b[2m = ${e.value}\x1b[0m`);
          }
          process.stdout.write("\n");
        }
        return "continue";
      }

      if (sub === "delete") {
        const key = args[1];
        if (!key) {
          renderer.error("usage: /memory delete <key>");
          return "continue";
        }
        const deleted = mem.delete("global", key);
        renderer.info(deleted ? `\u2713 deleted "${key}"` : `no memory for "${key}"`);
        return "continue";
      }

      renderer.error("usage: /memory [set|get|search|delete] ...");
      return "continue";
    }

    case "permissions": {
      const permMgr = ctx.orchestrator.getPermissions();
      const permConfig = permMgr.getConfig();
      process.stdout.write("\n");
      renderer.info("\x1b[1mDefaults:\x1b[0m");
      for (const [tool, action] of Object.entries(permConfig.defaults)) {
        const color = action === "allow" ? "\x1b[32m" : action === "deny" ? "\x1b[31m" : "\x1b[33m";
        renderer.info(`  ${color}${action}\x1b[0m  ${tool}`);
      }
      if (permConfig.rules.length > 0) {
        renderer.info("\x1b[1mRules:\x1b[0m");
        for (const rule of permConfig.rules) {
          const color = rule.action === "allow" ? "\x1b[32m" : rule.action === "deny" ? "\x1b[31m" : "\x1b[33m";
          renderer.info(`  ${color}${rule.action}\x1b[0m  ${rule.tool}: ${rule.pattern}`);
        }
      }
      const overrides = Object.keys(permConfig.agentOverrides);
      if (overrides.length > 0) {
        renderer.info("\x1b[1mAgent overrides:\x1b[0m " + overrides.join(", "));
      }
      process.stdout.write("\n");
      return "continue";
    }

    case "undo": {
      const snapMgr = ctx.orchestrator.getGitSnapshots();
      if (!snapMgr.canUndo()) {
        renderer.info("nothing to undo");
        return "continue";
      }
      const undoResult = await snapMgr.undo();
      if (undoResult.success) {
        renderer.info(`\u2713 undone (${undoResult.filesReverted.length} files reverted)`);
        for (const f of undoResult.filesReverted.slice(0, 5)) {
          renderer.info(`  \x1b[2m${f}\x1b[0m`);
        }
        if (undoResult.filesReverted.length > 5) {
          renderer.info(`  \x1b[2m... and ${undoResult.filesReverted.length - 5} more\x1b[0m`);
        }
      } else {
        renderer.error(undoResult.error ?? "undo failed");
      }
      return "continue";
    }

    case "redo": {
      const snapMgr = ctx.orchestrator.getGitSnapshots();
      if (!snapMgr.canRedo()) {
        renderer.info("nothing to redo");
        return "continue";
      }
      const redoResult = await snapMgr.redo();
      if (redoResult.success) {
        renderer.info(`\u2713 redone (${redoResult.filesReverted.length} files restored)`);
        for (const f of redoResult.filesReverted.slice(0, 5)) {
          renderer.info(`  \x1b[2m${f}\x1b[0m`);
        }
        if (redoResult.filesReverted.length > 5) {
          renderer.info(`  \x1b[2m... and ${redoResult.filesReverted.length - 5} more\x1b[0m`);
        }
      } else {
        renderer.error(redoResult.error ?? "redo failed");
      }
      return "continue";
    }

    case "theme": {
      const themeMgr = ctx.orchestrator.getThemeManager();
      const sub = args[0];

      if (sub === "list") {
        const themes = themeMgr.list();
        const current = themeMgr.get().name;
        process.stdout.write("\n");
        for (const name of themes) {
          const mark = name === current ? " \x1b[33m← active\x1b[0m" : "";
          renderer.info(`  ${name}${mark}`);
        }
        process.stdout.write("\n");
        return "continue";
      }

      if (sub === "preview") {
        process.stdout.write("\n" + themeMgr.formatPreview() + "\n\n");
        return "continue";
      }

      if (sub) {
        const ok = themeMgr.switch(sub);
        renderer.info(ok ? `\u2713 theme switched to ${sub}` : `unknown theme: ${sub}`);
      } else {
        renderer.info(`current theme: \x1b[1m${themeMgr.get().name}\x1b[0m`);
        renderer.info("\x1b[2musage: /theme <name> | /theme list | /theme preview\x1b[0m");
      }
      return "continue";
    }

    case "models": {
      const registry = ctx.orchestrator.getModelRegistry();
      const sub = args[0];

      if (sub) {
        const model = registry.get(sub);
        if (model) {
          process.stdout.write("\n");
          renderer.info(registry.formatModelLine(model));
          if (model.cost.cacheReadPerMillion !== undefined) {
            renderer.info(`  \x1b[2mcache read: $${model.cost.cacheReadPerMillion}/M\x1b[0m`);
          }
          process.stdout.write("\n");
        } else {
          renderer.error(`model not found: ${sub}`);
        }
        return "continue";
      }

      const models = registry.list();
      process.stdout.write("\n");
      let lastProvider = "";
      for (const m of models) {
        if (m.provider !== lastProvider) {
          lastProvider = m.provider;
          renderer.info(`\x1b[1m${m.provider}\x1b[0m`);
        }
        renderer.info(`  \x1b[2m${registry.formatModelLine(m)}\x1b[0m`);
      }
      process.stdout.write("\n");
      return "continue";
    }

    case "plugins": {
      const pluginMgr = ctx.orchestrator.getPluginManager();
      const sub = args[0];

      if (sub === "reload") {
        const count = await pluginMgr.reload();
        renderer.info(`\u2713 reloaded ${count} plugins`);
        return "continue";
      }

      if (sub === "enable" || sub === "disable") {
        const name = args[1];
        if (!name) { renderer.error(`usage: /plugins ${sub} <name>`); return "continue"; }
        const ok = pluginMgr.setEnabled(name, sub === "enable");
        renderer.info(ok ? `\u2713 ${name} ${sub}d` : `plugin not found: ${name}`);
        return "continue";
      }

      const list = pluginMgr.list();
      if (list.length === 0) {
        renderer.info("no plugins loaded");
        renderer.info("\x1b[2mPlace plugins in .orchestrator/plugins/ or ~/.orchestrator/plugins/\x1b[0m");
      } else {
        process.stdout.write("\n");
        for (const p of list) {
          const status = p.enabled ? "\x1b[32m●\x1b[0m" : "\x1b[90m○\x1b[0m";
          renderer.info(`${status} ${p.name} \x1b[2mv${p.version} (${p.hookCount} hooks)\x1b[0m`);
          renderer.info(`  \x1b[2m${p.description}\x1b[0m`);
        }
        process.stdout.write("\n");
      }
      return "continue";
    }

    case "share": {
      const sharer = ctx.orchestrator.getSessionSharer();
      const sub = args[0];

      if (sub === "list") {
        const shared = await sharer.list();
        if (shared.length === 0) {
          renderer.info("no shared sessions");
        } else {
          process.stdout.write("\n");
          for (const s of shared) {
            renderer.info(`\x1b[2m${s.createdAt}\x1b[0m  \x1b[1m${s.title}\x1b[0m  \x1b[2m${s.filePath}\x1b[0m`);
          }
          process.stdout.write("\n");
        }
        return "continue";
      }

      if (sub === "import") {
        const filePath = args[1];
        if (!filePath) { renderer.error("usage: /share import <file>"); return "continue"; }
        const session = await sharer.import(filePath);
        if (session) {
          for (const turn of session.turns) {
            ctx.conversation.add(turn);
          }
          renderer.info(`\u2713 imported ${session.turns.length} turns from "${session.title}"`);
        } else {
          renderer.error("failed to import session");
        }
        return "continue";
      }

      // Default: export current session
      if (ctx.conversation.length === 0) {
        renderer.info("nothing to share");
        return "continue";
      }
      const title = args.join(" ") || `Session ${new Date().toISOString().slice(0, 10)}`;
      const turns = ctx.conversation.getTurns();
      const models = [...new Set(turns.filter(t => t.tier).map(t => t.tier!))];
      const result = await sharer.share({
        id: crypto.randomUUID(),
        title,
        turns,
        metadata: {
          createdAt: new Date().toISOString(),
          turnCount: turns.length,
          models,
          totalCost: 0,
        },
      });
      renderer.info(`\u2713 shared: ${result.filePath}`);
      return "continue";
    }

    case "ast": {
      const astGrep = ctx.orchestrator.getAstGrep();
      const available = await astGrep.isAvailable();
      if (!available) {
        renderer.error("ast-grep (sg) is not installed. Install: npm i -g @ast-grep/cli");
        return "continue";
      }

      const sub = args[0];
      if (!sub) {
        renderer.info("usage: /ast search <pattern> [--lang <lang>] [--path <path>]");
        renderer.info("       /ast replace <pattern> <replacement> [--lang <lang>]");
        return "continue";
      }

      if (sub === "search") {
        const pattern = args[1];
        if (!pattern) { renderer.error("usage: /ast search <pattern>"); return "continue"; }
        const langIdx = args.indexOf("--lang");
        const pathIdx = args.indexOf("--path");
        const language = langIdx >= 0 ? args[langIdx + 1] : undefined;
        const path = pathIdx >= 0 ? args[pathIdx + 1] : undefined;
        const matches = await astGrep.search(pattern, { language, path, maxResults: 20 });
        process.stdout.write("\n" + astGrep.formatResults(matches) + "\n\n");
        return "continue";
      }

      if (sub === "replace") {
        const pattern = args[1];
        const replacement = args[2];
        if (!pattern || !replacement) { renderer.error("usage: /ast replace <pattern> <replacement>"); return "continue"; }
        const langIdx = args.indexOf("--lang");
        const language = langIdx >= 0 ? args[langIdx + 1] : undefined;
        const results = await astGrep.replace(pattern, replacement, { language, dryRun: args.includes("--dry-run") });
        for (const r of results) {
          if (r.success) {
            renderer.info(`\u2713 ${r.file}: ${r.replacements} replacements`);
          } else {
            renderer.error(`${r.file}: ${r.error}`);
          }
        }
        return "continue";
      }

      renderer.error(`unknown ast subcommand: ${sub}`);
      return "continue";
    }

    case "pipeline": {
      const task = args.join(" ");
      if (!task) {
        renderer.error("usage: /pipeline <task description>");
        return "continue";
      }
      const pipeline = ctx.orchestrator.getPlanningPipeline();
      const result = await pipeline.runPipeline(task);
      process.stdout.write("\n");
      for (const stage of result.stages) {
        const icon = stage.completed ? "\x1b[32m\u2713\x1b[0m" : "\x1b[31m\u2717\x1b[0m";
        renderer.info(`${icon} ${stage.stage} \x1b[2m(${stage.durationMs}ms)\x1b[0m ${stage.output}`);
      }
      process.stdout.write("\n" + pipeline.formatPlan(result.plan) + "\n\n");
      return "continue";
    }

    case "boulder": {
      const boulderMgr = ctx.orchestrator.getBoulderManager();
      const sub = args[0];

      if (sub === "list") {
        const boulders = await boulderMgr.list();
        if (boulders.length === 0) {
          renderer.info("no boulders");
        } else {
          process.stdout.write("\n");
          for (const b of boulders) {
            const pct = b.totalSteps > 0 ? Math.round((b.completedSteps.length / b.totalSteps) * 100) : 0;
            const color = b.status === "in_progress" ? "\x1b[33m" : b.status === "completed" ? "\x1b[32m" : "\x1b[31m";
            renderer.info(`${color}${b.status}\x1b[0m  ${b.task.slice(0, 60)}  \x1b[2m${pct}% (${b.completedSteps.length}/${b.totalSteps})\x1b[0m`);
          }
          process.stdout.write("\n");
        }
        return "continue";
      }

      if (sub === "resume") {
        const latest = await boulderMgr.loadLatest();
        if (!latest) {
          renderer.info("no active boulder to resume");
        } else {
          process.stdout.write("\n" + boulderMgr.formatResumeContext(latest) + "\n\n");
        }
        return "continue";
      }

      if (sub === "pause") {
        const latest = await boulderMgr.loadLatest();
        if (!latest) { renderer.info("no active boulder"); return "continue"; }
        const hint = args.slice(1).join(" ") || "manually paused";
        await boulderMgr.pause(latest.id, hint);
        renderer.info(`\u2713 boulder paused: ${hint}`);
        return "continue";
      }

      if (sub === "cleanup") {
        const removed = await boulderMgr.cleanup();
        renderer.info(`\u2713 cleaned up ${removed} completed boulders`);
        return "continue";
      }

      // Default: show latest
      const latest = await boulderMgr.loadLatest();
      if (latest) {
        process.stdout.write("\n" + boulderMgr.formatResumeContext(latest) + "\n\n");
      } else {
        renderer.info("no active boulder");
        renderer.info("\x1b[2musage: /boulder list | /boulder resume | /boulder pause <hint>\x1b[0m");
      }
      return "continue";
    }

    case "notepad": {
      const npMgr = ctx.orchestrator.getNotepadManager();
      const sub = args[0];

      if (sub === "list") {
        const names = npMgr.listNotepads();
        if (names.length === 0) {
          renderer.info("no notepads");
        } else {
          process.stdout.write("\n");
          for (const name of names) {
            renderer.info(`  ${name}`);
          }
          process.stdout.write("\n");
        }
        return "continue";
      }

      if (sub === "add") {
        const notepadName = args[1] || "session";
        const category = (args[2] || "learning") as import("../core/notepad.ts").NoteCategory;
        const content = args.slice(3).join(" ");
        if (!content) { renderer.error("usage: /notepad add <pad> <category> <content>"); return "continue"; }
        npMgr.addNote(notepadName, category, content, "user");
        await npMgr.save(notepadName);
        renderer.info(`\u2713 note added to ${notepadName} [${category}]`);
        return "continue";
      }

      if (sub === "search") {
        const query = args.slice(1).join(" ");
        if (!query) { renderer.error("usage: /notepad search <query>"); return "continue"; }
        const results = npMgr.search(query);
        if (results.length === 0) {
          renderer.info("no matches");
        } else {
          process.stdout.write("\n");
          for (const note of results.slice(0, 10)) {
            renderer.info(`\x1b[1m[${note.category}]\x1b[0m ${note.content.slice(0, 80)} \x1b[2m(${note.source})\x1b[0m`);
          }
          process.stdout.write("\n");
        }
        return "continue";
      }

      if (sub === "show") {
        const name = args[1] || "session";
        const wisdom = npMgr.getWisdom(name);
        if (wisdom) {
          process.stdout.write("\n" + wisdom + "\n\n");
        } else {
          renderer.info(`notepad "${name}" is empty`);
        }
        return "continue";
      }

      renderer.info("usage: /notepad [list|add|search|show] ...");
      return "continue";
    }

    case "oauth": {
      const oauth = ctx.orchestrator.getOAuthMcp();
      const sub = args[0];

      if (!sub) {
        renderer.info("usage: /oauth authorize <server-name> --auth-url <url> --token-url <url>");
        renderer.info("       /oauth status <server-name>");
        return "continue";
      }

      if (sub === "authorize") {
        const serverName = args[1];
        if (!serverName) { renderer.error("usage: /oauth authorize <server-name> --auth-url <url> --token-url <url>"); return "continue"; }
        const authUrlIdx = args.indexOf("--auth-url");
        const tokenUrlIdx = args.indexOf("--token-url");
        if (authUrlIdx < 0 || tokenUrlIdx < 0) { renderer.error("must provide --auth-url and --token-url"); return "continue"; }
        const authUrl = args[authUrlIdx + 1];
        const tokenUrl = args[tokenUrlIdx + 1];
        if (!authUrl || !tokenUrl) { renderer.error("invalid urls"); return "continue"; }

        try {
          const { url, token } = await oauth.authorize(serverName, { authorizationUrl: authUrl, tokenUrl });
          renderer.info(`\x1b[2mOpen this URL to authorize:\x1b[0m`);
          renderer.info(`\x1b[1m${url}\x1b[0m`);
          renderer.info("\x1b[2mwaiting for callback...\x1b[0m");
          const result = await token;
          renderer.info(`\u2713 authorized ${serverName} (expires ${new Date(result.expiresAt).toISOString()})`);
        } catch (e) {
          renderer.error((e as Error).message);
        }
        return "continue";
      }

      if (sub === "status") {
        const serverName = args[1];
        if (!serverName) { renderer.error("usage: /oauth status <server-name>"); return "continue"; }
        const token = await oauth.getToken(serverName);
        if (token) {
          const expired = Date.now() > token.expiresAt;
          const status = expired ? "\x1b[31mexpired\x1b[0m" : "\x1b[32mactive\x1b[0m";
          renderer.info(`${serverName}: ${status} (expires ${new Date(token.expiresAt).toISOString()})`);
        } else {
          renderer.info(`${serverName}: not authorized`);
        }
        return "continue";
      }

      renderer.error(`unknown oauth subcommand: ${sub}`);
      return "continue";
    }

    case "category": {
      const categoryRouter = ctx.orchestrator.getCategoryRouter();
      const sub = args[0];

      if (sub === "list") {
        const categories = categoryRouter.listCategories();
        process.stdout.write("\n");
        for (const cat of categories) {
          renderer.info(`\x1b[1m${cat.name}\x1b[0m \x1b[2m→ ${cat.tier} (${cat.description})\x1b[0m`);
        }
        process.stdout.write("\n");
        return "continue";
      }

      if (sub === "classify") {
        const prompt = args.slice(1).join(" ");
        if (!prompt) { renderer.error("usage: /category classify <prompt>"); return "continue"; }
        const result = categoryRouter.classify(prompt);
        const config = categoryRouter.getCategory(result);
        renderer.info(`category: \x1b[1m${result}\x1b[0m → ${config?.tier ?? "unknown"} (${config?.description ?? ""})`);
        return "continue";
      }

      // Default: show current categories
      const categories = categoryRouter.listCategories();
      process.stdout.write("\n");
      for (const cat of categories) {
        renderer.info(`\x1b[1m${cat.name}\x1b[0m \x1b[2m→ ${cat.tier} (${cat.description})\x1b[0m`);
      }
      renderer.info("\n\x1b[2musage: /category list | /category classify <prompt>\x1b[0m");
      process.stdout.write("\n");
      return "continue";
    }

    case "diff": {
      const ghostSha = ctx.orchestrator.getGhostSha();
      if (!ghostSha) {
        renderer.info("no session snapshot available (not in a git repo?)");
        return "continue";
      }
      const diff = await diffFromGhost(ghostSha);
      if (!diff) {
        renderer.info("no changes since session start");
      } else {
        process.stdout.write("\n");
        for (const line of diff.split("\n").slice(0, 30)) {
          const color = line.startsWith("+") ? "\x1b[32m" : line.startsWith("-") ? "\x1b[31m" : "\x1b[2m";
          renderer.info(`${color}${line}\x1b[0m`);
        }
        if (diff.split("\n").length > 30) renderer.info("\x1b[2m... truncated\x1b[0m");
        process.stdout.write("\n");
      }
      return "continue";
    }

    case "compact": {
      const compactor = new ContextCompactor();
      const turns = ctx.conversation.getTurns();
      if (turns.length === 0) {
        renderer.info("nothing to compact");
        return "continue";
      }
      const { turns: compactedTurns, result: compactionResult } = compactor.compact(turns);
      ctx.conversation.clear();
      for (const turn of compactedTurns) {
        ctx.conversation.add(turn);
      }
      renderer.info(
        `\u2713 compacted ${compactionResult.originalTurns} → ${compactionResult.compactedTurns} turns ` +
        `(~${compactionResult.originalTokens.toLocaleString()} → ~${compactionResult.compactedTokens.toLocaleString()} tokens, ` +
        `${compactionResult.prunedToolOutputs} tool outputs pruned)`,
      );
      return "continue";
    }

    case "trust": {
      const dir = args[0] || process.cwd();
      const trusted = await isProjectTrusted(dir);
      if (trusted) {
        renderer.info(`${dir} is already trusted`);
      } else {
        await trustProject(dir);
        renderer.info(`\u2713 trusted ${dir}`);
      }
      return "continue";
    }

    case "consolidate": {
      const consolidator = ctx.orchestrator.getConsolidator();
      renderer.info("consolidating memories from past sessions...");
      const result = await consolidator.consolidate();
      renderer.info(`\u2713 extracted ${result.extracted}, consolidated ${result.consolidated}`);
      return "continue";
    }

    case "checkpoint": {
      const cpMgr = ctx.orchestrator.getCheckpointManager();
      const sub = args[0];

      if (sub === "list") {
        const cps = cpMgr.list("repl");
        if (cps.length === 0) {
          renderer.info("no checkpoints");
        } else {
          process.stdout.write("\n");
          for (const cp of cps) {
            renderer.info(`\x1b[2m${cp.createdAt}\x1b[0m  ${cp.label}  \x1b[2m${cp.sha.slice(0, 8)}\x1b[0m`);
          }
          process.stdout.write("\n");
        }
        return "continue";
      }

      if (sub === "rollback") {
        const ok = await cpMgr.rollbackToLatest("repl");
        if (ok) {
          renderer.info("\u2713 rolled back to latest checkpoint");
        } else {
          renderer.error("no checkpoint to rollback to");
        }
        return "continue";
      }

      // Default: create checkpoint with optional label
      const label = args.join(" ") || `manual-${Date.now().toString(36)}`;
      try {
        const cp = await cpMgr.create("repl", "user", label);
        renderer.info(`\u2713 checkpoint ${cp.id.slice(0, 12)} (${cp.label})`);
      } catch (e) {
        renderer.error((e as Error).message);
      }
      return "continue";
    }

    case "mcp": {
      const mcpMgr = ctx.orchestrator.getMcpManager();
      const sub = args[0];

      if (sub === "tools") {
        const tools = mcpMgr.getTools();
        if (tools.length === 0) {
          renderer.info("no MCP tools available");
        } else {
          process.stdout.write("\n");
          let currentServer = "";
          for (const t of tools) {
            if (t.serverName !== currentServer) {
              currentServer = t.serverName;
              renderer.info(`\x1b[1m${currentServer}\x1b[0m`);
            }
            renderer.info(`  \x1b[2m${t.name}: ${t.description}\x1b[0m`);
          }
          process.stdout.write("\n");
        }
        return "continue";
      }

      if (sub === "connect") {
        const name = args[1];
        if (!name) { renderer.error("usage: /mcp connect <server-name>"); return "continue"; }
        const entry = getCatalogEntry(name);
        if (!entry) { renderer.error(`unknown server: "${name}"`); return "continue"; }
        const connected = await mcpMgr.connectOnDemand([entry]);
        if (connected.length > 0) {
          renderer.info(`\u2713 connected ${name} (${mcpMgr.getTools([name]).length} tools)`);
        } else {
          renderer.error(`failed to connect ${name}`);
        }
        return "continue";
      }

      if (sub === "disconnect") {
        const name = args[1];
        if (!name) { renderer.error("usage: /mcp disconnect <server-name>"); return "continue"; }
        const ok = await mcpMgr.disconnectServer(name);
        renderer.info(ok ? `\u2713 disconnected ${name}` : `"${name}" not connected`);
        return "continue";
      }

      // Default: show connected servers
      const servers = mcpMgr.getConnectedServers();
      if (servers.length === 0) {
        renderer.info("no MCP servers connected");
        renderer.info("\x1b[2musage: /mcp connect <name> | /mcp tools\x1b[0m");
      } else {
        process.stdout.write("\n");
        for (const name of servers) {
          const toolCount = mcpMgr.getTools([name]).length;
          renderer.info(`\x1b[32m●\x1b[0m ${name} \x1b[2m(${toolCount} tools)\x1b[0m`);
        }
        renderer.info(`\x1b[2m${mcpMgr.getToolCount()} tools total\x1b[0m`);
        process.stdout.write("\n");
      }
      return "continue";
    }

    case "plan": {
      if (!ctx.planMode) {
        renderer.error("plan mode not available");
        return "continue";
      }
      const sub = args[0];

      if (sub === "list") {
        const plans = await ctx.planMode.listPlans(process.cwd());
        if (plans.length === 0) {
          renderer.info("no plans saved");
        } else {
          process.stdout.write("\n");
          for (const p of plans) {
            renderer.info(`\x1b[2m${p.createdAt}\x1b[0m  \x1b[1m${p.title}\x1b[0m  \x1b[2m${p.id}\x1b[0m`);
          }
          process.stdout.write("\n");
        }
        return "continue";
      }

      if (sub === "save") {
        const title = args.slice(1).join(" ") || "Untitled Plan";
        const content = ctx.conversation.generateSummary();
        const plan = await ctx.planMode.savePlan(title, content, process.cwd());
        renderer.info(`\u2713 plan saved: ${plan.filePath}`);
        return "continue";
      }

      // Default: toggle plan mode
      const isActive = ctx.planMode.toggle();
      renderer.info(isActive
        ? "\x1b[33m\u2713 plan mode ON\x1b[0m — read-only analysis, no code changes"
        : "\u2713 plan mode OFF — full editing restored");
      return "continue";
    }

    case "fork": {
      if (!ctx.forkManager) {
        renderer.error("session forking not available");
        return "continue";
      }
      const sub = args[0];

      if (sub === "list") {
        const branches = ctx.forkManager.listBranches();
        process.stdout.write("\n");
        for (const b of branches) {
          const active = b.active ? " \x1b[33m<- active\x1b[0m" : "";
          renderer.info(`  ${b.label} \x1b[2m(${b.turnCount} turns, fork@${b.forkPoint})\x1b[0m${active}`);
        }
        process.stdout.write("\n");
        return "continue";
      }

      if (sub === "tree") {
        process.stdout.write("\n" + ctx.forkManager.formatTree() + "\n\n");
        return "continue";
      }

      if (sub === "switch") {
        const branchId = args[1];
        if (!branchId) { renderer.error("usage: /fork switch <branch-id>"); return "continue"; }
        const branches = ctx.forkManager.listBranches();
        const target = branches.find(b => b.label === branchId || b.id.startsWith(branchId));
        if (!target) { renderer.error(`branch not found: ${branchId}`); return "continue"; }
        const switched = ctx.forkManager.switchTo(target.id);
        if (switched) {
          // Sync conversation with branch turns
          ctx.conversation.clear();
          for (const turn of switched.turns) {
            ctx.conversation.add(turn);
          }
          renderer.info(`\u2713 switched to ${target.label} (${switched.turns.length} turns)`);
        }
        return "continue";
      }

      // Default: create fork at current position
      const label = args.join(" ") || undefined;
      const branch = ctx.forkManager.fork(ctx.conversation.length, label);
      renderer.info(`\u2713 forked at turn ${ctx.conversation.length} → ${branch.label}`);
      return "continue";
    }

    case "lsp": {
      const lspMgr = ctx.orchestrator.getLspManager();
      const sub = args[0];

      if (sub === "diagnostics") {
        const file = args[1];
        if (!file) { renderer.error("usage: /lsp diagnostics <file>"); return "continue"; }
        const diags = await lspMgr.getDiagnostics(file);
        if (diags.length === 0) {
          renderer.info("no diagnostics");
        } else {
          process.stdout.write("\n");
          for (const d of diags) {
            const color = d.severity === "error" ? "\x1b[31m" : d.severity === "warning" ? "\x1b[33m" : "\x1b[2m";
            renderer.info(`${color}${d.severity}\x1b[0m ${d.file}:${d.line + 1}:${d.column + 1} ${d.message}`);
          }
          process.stdout.write("\n");
        }
        return "continue";
      }

      if (sub === "symbols") {
        const file = args[1];
        if (!file) { renderer.error("usage: /lsp symbols <file>"); return "continue"; }
        const symbols = await lspMgr.documentSymbols(file);
        if (symbols.length === 0) {
          renderer.info("no symbols found");
        } else {
          process.stdout.write("\n");
          for (const s of symbols) {
            renderer.info(`\x1b[1m${s.kind}\x1b[0m ${s.name} \x1b[2m${s.file}:${s.line + 1}\x1b[0m`);
          }
          process.stdout.write("\n");
        }
        return "continue";
      }

      // Default: show active LSP servers
      const active = lspMgr.listActive();
      if (active.length === 0) {
        renderer.info("no LSP servers running");
        renderer.info("\x1b[2musage: /lsp diagnostics <file> | /lsp symbols <file>\x1b[0m");
      } else {
        process.stdout.write("\n");
        for (const name of active) {
          renderer.info(`\x1b[32m●\x1b[0m ${name}`);
        }
        process.stdout.write("\n");
      }
      return "continue";
    }

    case "spec": {
      const task = args.join(" ");
      if (!task) {
        renderer.error("usage: /spec <task description>");
        return "continue";
      }

      const complexity = args.length > 20 ? "complex" : args.length > 8 ? "standard" : "simple";
      const phases = selectPhases(complexity);
      renderer.info(`spec pipeline: ${complexity} (${phases.join(" → ")})`);

      const outputs = new Map<SpecPhase, string>();
      for (const phase of phases) {
        renderer.info(`\x1b[2m▸ ${phase}...\x1b[0m`);
        const prompt = buildPhasePrompt(phase, { task, previousOutputs: outputs });
        // Store prompt as output placeholder (agent execution would replace this)
        outputs.set(phase, prompt);
      }

      const specOutput = outputs.get("spec") ?? outputs.get("planning") ?? "";
      const parsed = parseSpecResult(specOutput);

      process.stdout.write("\n");
      if (parsed.requirements.length > 0) {
        renderer.info("\x1b[1mRequirements:\x1b[0m");
        for (const r of parsed.requirements.slice(0, 10)) renderer.info(`  • ${r}`);
      }
      if (parsed.implementationSteps.length > 0) {
        renderer.info("\x1b[1mImplementation Steps:\x1b[0m");
        for (const s of parsed.implementationSteps.slice(0, 10)) renderer.info(`  ${s}`);
      }
      if (parsed.risks.length > 0) {
        renderer.info("\x1b[1mRisks:\x1b[0m");
        for (const r of parsed.risks.slice(0, 5)) renderer.info(`  △ ${r}`);
      }
      renderer.info(`\x1b[2mestimated complexity: ${parsed.estimatedComplexity}\x1b[0m`);
      process.stdout.write("\n");
      return "continue";
    }

    case "ideate": {
      const task = args.join(" ");
      if (!task) {
        renderer.error("usage: /ideate <code context or task>");
        return "continue";
      }

      const dimensions = Object.keys(DIMENSION_PROMPTS) as IdeationDimension[];
      renderer.info(`ideation: analyzing ${dimensions.length} dimensions...`);

      const allIdeas: import("../config/types.ts").Idea[] = [];
      for (const dim of dimensions) {
        const prompt = buildIdeationPrompt(dim, task);
        // In a full flow the prompt would be sent to an agent
        // For now, provide the structured prompt for user to feed to an agent
        renderer.info(`  \x1b[2m▸ ${dim}: ${DIMENSION_PROMPTS[dim].slice(0, 60)}...\x1b[0m`);
      }

      // If no ideas parsed (no agent call), show prompt summary
      if (allIdeas.length === 0) {
        process.stdout.write("\n");
        renderer.info("Prompts generated for each dimension.");
        renderer.info("Use these as subtask prompts in multi-agent mode for full analysis.");
        renderer.info(`\x1b[2mdimensions: ${dimensions.join(", ")}\x1b[0m`);
      } else {
        const prioritized = prioritizeIdeas(allIdeas);
        process.stdout.write("\n");
        for (const idea of prioritized.slice(0, 10)) {
          const prio = idea.priority === "high" ? "\x1b[31m" : idea.priority === "medium" ? "\x1b[33m" : "\x1b[32m";
          renderer.info(`${prio}[${idea.priority}]\x1b[0m ${idea.title} \x1b[2m(effort: ${idea.effort})\x1b[0m`);
          if (idea.description) renderer.info(`  \x1b[2m${idea.description.slice(0, 100)}\x1b[0m`);
        }
      }
      process.stdout.write("\n");
      return "continue";
    }

    case "doctor": {
      const doctor = ctx.orchestrator.getDoctor();
      renderer.info("running diagnostics...");
      const results = await doctor.runAll();
      process.stdout.write("\n");
      for (const r of results) {
        const icon = r.status === "pass" ? "\x1b[32m✓\x1b[0m" : r.status === "warn" ? "\x1b[33m△\x1b[0m" : "\x1b[31m✗\x1b[0m";
        renderer.info(`${icon} ${r.check}: ${r.detail}`);
      }
      process.stdout.write("\n");
      return "continue";
    }

    case "stats": {
      const stats = ctx.orchestrator.getStatistics();
      const session = stats.getSessionStats();
      process.stdout.write("\n" + stats.formatStats(session) + "\n\n");
      return "continue";
    }

    case "worktree": {
      const wt = ctx.orchestrator.getGitWorktree();
      const sub = args[0];
      if (sub === "list") {
        const trees = await wt.list();
        if (trees.length === 0) {
          renderer.info("no active worktrees");
        } else {
          process.stdout.write("\n");
          for (const t of trees) {
            renderer.info(`\x1b[1m${t.branch}\x1b[0m \x1b[2m${t.path}\x1b[0m${t.agentId ? ` \x1b[33m(${t.agentId})\x1b[0m` : ""}`);
          }
          process.stdout.write("\n");
        }
        return "continue";
      }
      if (sub === "create") {
        const branch = args[1];
        if (!branch) { renderer.error("usage: /worktree create <branch>"); return "continue"; }
        try {
          const info = await wt.create(branch);
          renderer.info(`✓ worktree created: ${info.path} (${info.branch})`);
        } catch (e) { renderer.error((e as Error).message); }
        return "continue";
      }
      if (sub === "remove") {
        const path = args[1];
        if (!path) { renderer.error("usage: /worktree remove <path>"); return "continue"; }
        try {
          await wt.remove(path);
          renderer.info(`✓ worktree removed: ${path}`);
        } catch (e) { renderer.error((e as Error).message); }
        return "continue";
      }
      if (sub === "cleanup") {
        await wt.cleanupAll();
        renderer.info("✓ all worktrees cleaned up");
        return "continue";
      }
      renderer.info("usage: /worktree [list|create|remove|cleanup]");
      return "continue";
    }

    case "background": {
      const bg = ctx.orchestrator.getBackgroundAgent();
      const sub = args[0];
      if (sub === "list") {
        const active = bg.listActive();
        if (active.length === 0) {
          renderer.info("no background tasks");
        } else {
          process.stdout.write("\n");
          for (const t of active) {
            const status = t.status === "running" ? "\x1b[33m●\x1b[0m" : t.status === "completed" ? "\x1b[32m●\x1b[0m" : "\x1b[31m●\x1b[0m";
            renderer.info(`${status} ${t.id.slice(0, 8)} \x1b[2m${t.prompt.slice(0, 60)}\x1b[0m`);
          }
          process.stdout.write("\n");
        }
        return "continue";
      }
      if (sub === "cancel") {
        const taskId = args[1];
        if (!taskId) { renderer.error("usage: /background cancel <task-id>"); return "continue"; }
        bg.cancel(taskId);
        renderer.info(`✓ cancelled ${taskId}`);
        return "continue";
      }
      if (sub === "result") {
        const taskId = args[1];
        if (!taskId) { renderer.error("usage: /background result <task-id>"); return "continue"; }
        const result = await bg.getResult(taskId);
        if (result) {
          process.stdout.write("\n" + result.slice(0, 2000) + "\n\n");
        } else {
          renderer.info("no result yet or task not found");
        }
        return "continue";
      }
      renderer.info("usage: /background [list|cancel|result] ...");
      return "continue";
    }

    case "stash": {
      const stash = ctx.orchestrator.getPromptStash();
      const sub = args[0];
      if (sub === "push") {
        const text = args.slice(1).join(" ");
        if (!text) { renderer.error("usage: /stash push <text>"); return "continue"; }
        await stash.push(text);
        renderer.info(`✓ stashed: ${text.slice(0, 60)}`);
        return "continue";
      }
      if (sub === "pop") {
        const text = await stash.pop();
        if (text) {
          renderer.info(`popped: ${text}`);
        } else {
          renderer.info("stash is empty");
        }
        return "continue";
      }
      if (sub === "list") {
        const entries = await stash.list();
        if (entries.length === 0) {
          renderer.info("stash is empty");
        } else {
          process.stdout.write("\n");
          for (let i = 0; i < entries.length; i++) {
            renderer.info(`\x1b[2m${i}:\x1b[0m ${entries[i].text.slice(0, 80)} \x1b[2m(${entries[i].timestamp})\x1b[0m`);
          }
          process.stdout.write("\n");
        }
        return "continue";
      }
      renderer.info("usage: /stash [push|pop|list] ...");
      return "continue";
    }

    case "question": {
      renderer.info("usage: questions are asked by agents via the question tool");
      renderer.info("\x1b[2mpending questions will appear in the REPL for you to answer\x1b[0m");
      return "continue";
    }

    case "search": {
      const engine = ctx.orchestrator.getCodeSearch();
      const query = args.join(" ");
      if (!query) { renderer.error("usage: /search <query>"); return "continue"; }
      try {
        const results = await engine.search(query);
        if (results.length === 0) {
          renderer.info("no results");
        } else {
          process.stdout.write("\n");
          for (const r of results) {
            renderer.info(`\x1b[1m${r.title}\x1b[0m \x1b[2m(${r.score.toFixed(2)})\x1b[0m`);
            renderer.info(`  \x1b[2m${r.url}\x1b[0m`);
            if (r.content) renderer.info(`  ${r.content.slice(0, 120)}`);
          }
          process.stdout.write("\n");
        }
      } catch (e) { renderer.error((e as Error).message); }
      return "continue";
    }

    case "tasks": {
      const taskMgr = ctx.orchestrator.getPersistentTasks();
      const sub = args[0];
      if (sub === "create") {
        const subject = args.slice(1).join(" ");
        if (!subject) { renderer.error("usage: /tasks create <subject>"); return "continue"; }
        const task = await taskMgr.create({ subject, description: "", status: "pending" });
        renderer.info(`✓ task ${task.id.slice(0, 8)}: ${subject}`);
        return "continue";
      }
      if (sub === "done") {
        const id = args[1];
        if (!id) { renderer.error("usage: /tasks done <id>"); return "continue"; }
        await taskMgr.update(id, { status: "completed" });
        renderer.info(`✓ completed ${id}`);
        return "continue";
      }
      // Default: list
      const tasks = await taskMgr.list();
      if (tasks.length === 0) {
        renderer.info("no tasks");
      } else {
        process.stdout.write("\n");
        for (const t of tasks) {
          const icon = t.status === "completed" ? "\x1b[32m✓\x1b[0m" : t.status === "in_progress" ? "\x1b[33m●\x1b[0m" : "\x1b[90m○\x1b[0m";
          renderer.info(`${icon} ${t.id.slice(0, 8)} ${t.subject}`);
        }
        process.stdout.write("\n");
      }
      return "continue";
    }

    case "handoff": {
      const gen = ctx.orchestrator.getHandoffGenerator();
      const turns = ctx.conversation.getTurns();
      const output = gen.generate(turns, {
        sessionSummary: ctx.conversation.generateSummary(),
        gitStatus: true,
        todoState: true,
      });
      process.stdout.write("\n" + output + "\n\n");
      return "continue";
    }

    case "refactor": {
      const engine = ctx.orchestrator.getRefactorEngine();
      const goal = args.join(" ");
      if (!goal) { renderer.error("usage: /refactor <goal>"); return "continue"; }
      renderer.info("starting refactor...");
      try {
        const result = await engine.execute(process.cwd(), goal);
        process.stdout.write("\n");
        for (const phase of result.phases) {
          const icon = phase.status === "success" ? "\x1b[32m✓\x1b[0m" : phase.status === "failed" ? "\x1b[31m✗\x1b[0m" : "\x1b[90m-\x1b[0m";
          renderer.info(`${icon} ${phase.name} \x1b[2m(${phase.durationMs}ms)\x1b[0m`);
        }
        renderer.info(`\n${result.summary}`);
        process.stdout.write("\n");
      } catch (e) { renderer.error((e as Error).message); }
      return "continue";
    }

    case "variants": {
      const mgr = ctx.orchestrator.getModelVariants();
      const sub = args[0];
      if (sub === "set") {
        const variant = args[1];
        if (!variant) { renderer.error("usage: /variants set <fast|default|high|max>"); return "continue"; }
        const config = mgr.getVariant("default", variant);
        if (config) {
          renderer.info(`✓ variant: ${variant} (temp=${config.temperature}, maxTokens=${config.maxTokens})`);
        } else {
          renderer.error(`unknown variant: ${variant}`);
        }
        return "continue";
      }
      const variants = mgr.listVariants();
      process.stdout.write("\n");
      for (const v of variants) {
        renderer.info(`\x1b[1m${v}\x1b[0m`);
      }
      process.stdout.write("\n");
      return "continue";
    }

    case "ultrawork": {
      const uw = ctx.orchestrator.getUltrawork();
      const overrides = uw.getOverrides();
      renderer.info(`\x1b[1multrawork mode\x1b[0m: model=${overrides.model}, maxTurns=${overrides.maxTurns}, forceMultiAgent=${overrides.forceMultiAgent}`);
      return "continue";
    }

    case "github": {
      const gh = ctx.orchestrator.getGitHub();
      const sub = args[0];
      if (sub === "branch") {
        const name = args[1];
        if (!name) { renderer.error("usage: /github branch <name>"); return "continue"; }
        try {
          await gh.createBranch(name);
          renderer.info(`✓ branch created: ${name}`);
        } catch (e) { renderer.error((e as Error).message); }
        return "continue";
      }
      if (sub === "pr") {
        const title = args.slice(1).join(" ");
        if (!title) { renderer.error("usage: /github pr <title>"); return "continue"; }
        try {
          const url = await gh.createPR(title, "");
          renderer.info(`✓ PR created: ${url}`);
        } catch (e) { renderer.error((e as Error).message); }
        return "continue";
      }
      if (sub === "issue") {
        const url = args[1];
        if (!url) { renderer.error("usage: /github issue <url-or-number>"); return "continue"; }
        try {
          const info = await gh.parseIssue(url);
          process.stdout.write("\n");
          renderer.info(`\x1b[1m#${info.number}\x1b[0m ${info.title}`);
          renderer.info(`\x1b[2m${info.body.slice(0, 200)}\x1b[0m`);
          process.stdout.write("\n");
        } catch (e) { renderer.error((e as Error).message); }
        return "continue";
      }
      renderer.info("usage: /github [branch|pr|issue] ...");
      return "continue";
    }

    case "help": {
      process.stdout.write("\n");
      renderer.info("\x1b[1m/status\x1b[0m\x1b[2m              agent statuses");
      renderer.info("\x1b[1m/stop\x1b[0m \x1b[2m<agent>        stop a running agent");
      renderer.info("\x1b[1m/spawn\x1b[0m \x1b[2m<agent>       spawn an agent");
      renderer.info("\x1b[1m/task\x1b[0m \x1b[2m<agent> <msg>   assign task to agent");
      renderer.info("\x1b[1m/budget\x1b[0m\x1b[2m              budget usage");
      renderer.info("\x1b[1m/trace\x1b[0m\x1b[2m               active traces");
      renderer.info("\x1b[1m/agents\x1b[0m\x1b[2m              agent profiles & health");
      renderer.info("\x1b[1m/agents select\x1b[0m \x1b[2m<name> pin to a specific agent");
      renderer.info("\x1b[1m/agents auto\x1b[0m\x1b[2m         restore auto routing");
      renderer.info("\x1b[1m/messages\x1b[0m \x1b[2m<agent>    message history");
      renderer.info("\x1b[1m/ownership\x1b[0m\x1b[2m           file ownership map");
      renderer.info("\x1b[1m/mcp\x1b[0m\x1b[2m                 MCP server status");
      renderer.info("\x1b[1m/mcp tools\x1b[0m\x1b[2m           list MCP tools");
      renderer.info("\x1b[1m/mcp connect\x1b[0m \x1b[2m<name>   connect catalog server");
      renderer.info("\x1b[1m/mcp disconnect\x1b[0m \x1b[2m<n>  disconnect server");
      renderer.info("\x1b[1m/plan\x1b[0m\x1b[2m                toggle plan mode (read-only)");
      renderer.info("\x1b[1m/plan list\x1b[0m\x1b[2m           list saved plans");
      renderer.info("\x1b[1m/plan save\x1b[0m \x1b[2m<title>   save current plan");
      renderer.info("\x1b[1m/fork\x1b[0m\x1b[2m                fork conversation at current point");
      renderer.info("\x1b[1m/fork list\x1b[0m\x1b[2m           list branches");
      renderer.info("\x1b[1m/fork tree\x1b[0m\x1b[2m           show branch tree");
      renderer.info("\x1b[1m/fork switch\x1b[0m \x1b[2m<name>  switch to branch");
      renderer.info("\x1b[1m/lsp\x1b[0m\x1b[2m                 active LSP servers");
      renderer.info("\x1b[1m/lsp diagnostics\x1b[0m \x1b[2m<f> file diagnostics");
      renderer.info("\x1b[1m/lsp symbols\x1b[0m \x1b[2m<file>   document symbols");
      renderer.info("\x1b[1m/pause\x1b[0m\x1b[2m               save session snapshot");
      renderer.info("\x1b[1m/resume\x1b[0m\x1b[2m              restore last session");
      renderer.info("\x1b[1m/sessions\x1b[0m\x1b[2m            saved session list");
      renderer.info("\x1b[1m/memory\x1b[0m\x1b[2m              persistent memory");
      renderer.info("\x1b[1m/permissions\x1b[0m\x1b[2m         show permission rules");
      renderer.info("\x1b[1m/undo\x1b[0m\x1b[2m                revert to previous snapshot");
      renderer.info("\x1b[1m/redo\x1b[0m\x1b[2m                restore undone snapshot");
      renderer.info("\x1b[1m/theme\x1b[0m \x1b[2m<name>         switch color theme");
      renderer.info("\x1b[1m/theme list\x1b[0m\x1b[2m          available themes");
      renderer.info("\x1b[1m/theme preview\x1b[0m\x1b[2m       preview current theme colors");
      renderer.info("\x1b[1m/models\x1b[0m\x1b[2m              model registry & pricing");
      renderer.info("\x1b[1m/models\x1b[0m \x1b[2m<name>        model details");
      renderer.info("\x1b[1m/plugins\x1b[0m\x1b[2m             loaded plugins");
      renderer.info("\x1b[1m/plugins reload\x1b[0m\x1b[2m      reload plugins");
      renderer.info("\x1b[1m/share\x1b[0m \x1b[2m<title>        export session as markdown");
      renderer.info("\x1b[1m/share list\x1b[0m\x1b[2m          list shared sessions");
      renderer.info("\x1b[1m/share import\x1b[0m \x1b[2m<file>  import shared session");
      renderer.info("\x1b[1m/ast search\x1b[0m \x1b[2m<pattern> structural code search");
      renderer.info("\x1b[1m/ast replace\x1b[0m \x1b[2m<p> <r>  structural code replace");
      renderer.info("\x1b[1m/pipeline\x1b[0m \x1b[2m<task>      run plan→review→validate pipeline");
      renderer.info("\x1b[1m/boulder\x1b[0m\x1b[2m             active boulders (WIP tasks)");
      renderer.info("\x1b[1m/boulder resume\x1b[0m \x1b[2m<id>  resume a boulder");
      renderer.info("\x1b[1m/boulder pause\x1b[0m \x1b[2m<id>   pause a boulder");
      renderer.info("\x1b[1m/notepad\x1b[0m\x1b[2m             list notepads");
      renderer.info("\x1b[1m/notepad add\x1b[0m \x1b[2m<name>    create new notepad");
      renderer.info("\x1b[1m/notepad search\x1b[0m \x1b[2m<q>  search notepad entries");
      renderer.info("\x1b[1m/oauth authorize\x1b[0m \x1b[2m<s>  OAuth flow for MCP server");
      renderer.info("\x1b[1m/oauth status\x1b[0m \x1b[2m<s>    check OAuth token status");
      renderer.info("\x1b[1m/category\x1b[0m\x1b[2m            list task categories");
      renderer.info("\x1b[1m/category classify\x1b[0m \x1b[2m<p> classify a prompt");
      renderer.info("\x1b[1m/diff\x1b[0m\x1b[2m                show changes since session start");
      renderer.info("\x1b[1m/compact\x1b[0m\x1b[2m             compress conversation history");
      renderer.info("\x1b[1m/trust\x1b[0m\x1b[2m               trust project config dir");
      renderer.info("\x1b[1m/consolidate\x1b[0m\x1b[2m         consolidate memories from sessions");
      renderer.info("\x1b[1m/checkpoint\x1b[0m\x1b[2m          create a git checkpoint");
      renderer.info("\x1b[1m/checkpoint list\x1b[0m\x1b[2m     list checkpoints");
      renderer.info("\x1b[1m/checkpoint rollback\x1b[0m\x1b[2m rollback to latest");
      renderer.info("\x1b[1m/spec\x1b[0m \x1b[2m<task>          generate structured spec pipeline");
      renderer.info("\x1b[1m/ideate\x1b[0m \x1b[2m<context>      brainstorm improvements across dimensions");
      renderer.info("\x1b[1m/doctor\x1b[0m\x1b[2m              run system diagnostics");
      renderer.info("\x1b[1m/stats\x1b[0m\x1b[2m               session statistics");
      renderer.info("\x1b[1m/worktree\x1b[0m\x1b[2m            manage git worktrees");
      renderer.info("\x1b[1m/worktree create\x1b[0m \x1b[2m<b> create worktree for branch");
      renderer.info("\x1b[1m/worktree remove\x1b[0m \x1b[2m<p> remove worktree");
      renderer.info("\x1b[1m/worktree cleanup\x1b[0m\x1b[2m    remove all worktrees");
      renderer.info("\x1b[1m/background\x1b[0m\x1b[2m          list background tasks");
      renderer.info("\x1b[1m/background cancel\x1b[0m \x1b[2m<id> cancel a background task");
      renderer.info("\x1b[1m/background result\x1b[0m \x1b[2m<id> get task result");
      renderer.info("\x1b[1m/stash\x1b[0m\x1b[2m               prompt stash (push/pop/list)");
      renderer.info("\x1b[1m/question\x1b[0m\x1b[2m            agent question info");
      renderer.info("\x1b[1m/search\x1b[0m \x1b[2m<query>       code search");
      renderer.info("\x1b[1m/tasks\x1b[0m\x1b[2m               list persistent tasks");
      renderer.info("\x1b[1m/tasks create\x1b[0m \x1b[2m<subj>  create a task");
      renderer.info("\x1b[1m/tasks done\x1b[0m \x1b[2m<id>      mark task completed");
      renderer.info("\x1b[1m/handoff\x1b[0m\x1b[2m             generate session handoff document");
      renderer.info("\x1b[1m/refactor\x1b[0m \x1b[2m<goal>      run automated refactor");
      renderer.info("\x1b[1m/variants\x1b[0m\x1b[2m            list model variants");
      renderer.info("\x1b[1m/variants set\x1b[0m \x1b[2m<name>  set model variant");
      renderer.info("\x1b[1m/ultrawork\x1b[0m\x1b[2m           show ultrawork mode config");
      renderer.info("\x1b[1m/github branch\x1b[0m \x1b[2m<name> create branch");
      renderer.info("\x1b[1m/github pr\x1b[0m \x1b[2m<title>    create pull request");
      renderer.info("\x1b[1m/github issue\x1b[0m \x1b[2m<url>   view issue details");
      renderer.info("\x1b[1m/clear\x1b[0m\x1b[2m               clear conversation");
      renderer.info("\x1b[1m/lang\x1b[0m \x1b[2m<language>      set response language");
      renderer.info("\x1b[1m/help\x1b[0m\x1b[2m                this help");
      renderer.info("\x1b[1m/quit\x1b[0m\x1b[2m                exit");
      process.stdout.write("\n");
      return "continue";
    }

    case "quit":
    case "exit":
    case "q": {
      return "quit";
    }

    case "": {
      // bare "/" — show available commands
      process.stdout.write("\n");
      renderer.info(`\x1b[2m${COMMANDS.join("  ")}\x1b[0m`);
      process.stdout.write("\n");
      return "continue";
    }

    default: {
      renderer.error(`unknown command: /${cmd}`);
      return "continue";
    }
  }
}
