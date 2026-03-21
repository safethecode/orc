import type { Orchestrator } from "../core/orchestrator.ts";
import type { Conversation } from "./conversation.ts";
import { BENCHMARK_TASKS, getTasksByCategory, getTasksByDifficulty, getTaskById } from "../benchmark/tasks.ts";
import { BenchmarkRunner, estimateBenchmarkCost } from "../benchmark/runner.ts";
import { ReportGenerator } from "../benchmark/report-generator.ts";
import { diffFromGhost } from "../utils/ghost-commit.ts";
import { loadExecPolicy, trustProject, isProjectTrusted } from "../sandbox/rules.ts";
import { getCatalogEntry } from "../mcp/catalog.ts";
import { setMarkdownTheme, getMarkdownThemes } from "../tui-repl/markdown.ts";
import { selectPhases, buildPhasePrompt, parseSpecResult } from "../core/spec-pipeline.ts";
import { buildIdeationPrompt, parseIdeationResponse, prioritizeIdeas, DIMENSION_PROMPTS } from "../core/ideation.ts";
import type { SpecPhase, IdeationDimension } from "../config/types.ts";
import type { TaskPriority } from "../core/scheduler.ts";
import type { PlanMode } from "./plan-mode.ts";
import { SessionForkManager } from "../core/session-fork.ts";
import { ContextCompactor } from "../core/compaction.ts";
import type { SessionSharer } from "../core/session-share.ts";
import type { RendererPort } from "./renderer-types.ts";

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
  "/variants", "/fastwork", "/ultrathink", "/github",
  "/queue", "/cancel", "/dlq", "/enforce", "/doomloop",
  "/diff", "/compact", "/trust", "/consolidate",
  "/checkpoint", "/spec", "/ideate", "/benchmark", "/optimize", "/scan", "/providers", "/help", "/quit",
];

export const LANGUAGES = [
  "korean", "english", "japanese", "chinese",
  "spanish", "french", "german", "portuguese",
  "russian", "arabic", "italian", "dutch",
];

export interface CommandContext {
  orchestrator: Orchestrator;
  conversation: Conversation;
  renderer: RendererPort;
  planMode?: PlanMode;
  forkManager?: SessionForkManager;
  getPinnedAgent: () => string | null;
  setPinnedAgent: (name: string | null) => void;
  consumePendingSnapshot?: () => {
    id: string;
    sessionName: string;
    turnsJson: string;
    language: string | null;
    summary: string | null;
    turnCount: number;
    createdAt: string;
  } | null;
}

export function isCommand(input: string): boolean {
  return input.startsWith("/");
}

export async function handleCommand(
  input: string,
  ctx: CommandContext,
): Promise<"continue" | "quit"> {
  const [cmd, ...args] = input.slice(1).split(/\s+/);
  const r = ctx.renderer;

  switch (cmd) {
    case "status": {
      const agents = await ctx.orchestrator.listAgents();
      if (agents.length === 0) {
        r.info("no agents running");
      } else {
  
        r.separator();
        for (const agent of agents) {
          const taskInfo = agent.currentTask ? `  \x1b[90mtask: ${agent.currentTask}\x1b[0m` : "";
          const statusColor = agent.status === "running" ? "\x1b[32m" : "\x1b[90m";
          r.info(`${statusColor}●\x1b[0m ${agent.name} \x1b[90m${agent.status}\x1b[0m${taskInfo}`);
        }
        r.separator();
      }
      return "continue";
    }

    case "stop": {
      const agentName = args[0];
      if (!agentName) {
        r.error("usage: /stop <agent-name>");
        return "continue";
      }
      try {
        await ctx.orchestrator.stopAgent(agentName);
        r.info(`✓ stopped ${agentName}`);
      } catch (e) {
        r.error((e as Error).message);
      }
      return "continue";
    }

    case "clear": {
      ctx.conversation.clear();
      r.info("✓ conversation cleared");
      return "continue";
    }

    case "lang": {
      const lang = args[0];
      if (!lang) {
        const current = ctx.conversation.getLanguage();
  
        r.info(current ? `current: \x1b[1m${current}\x1b[0m` : "no language set (default)");
        r.info(`\x1b[2m${LANGUAGES.join(" · ")}\x1b[0m`);
        r.info("\x1b[2musage: /lang <language>\x1b[0m");
  
      } else {
        ctx.conversation.setLanguage(lang);
        r.info(`✓ language set to ${lang}`);
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


      r.info(`\x1b[1mSession Budget\x1b[0m`);
      r.info(`  spent: \x1b[1m$${totalCost < 0.01 ? totalCost.toFixed(4) : totalCost.toFixed(2)}\x1b[0m  (${totalTokens.toLocaleString()} tokens, ${taskCount} tasks)`);
      if (budgetEnabled && budgetLimit > 0) {
        const pct = Math.round((totalCost / budgetLimit) * 100);
        const color = pct > 90 ? "\x1b[31m" : pct > 70 ? "\x1b[33m" : "\x1b[32m";
        r.info(`  limit: $${budgetLimit.toFixed(2)}  ${color}${pct}% used\x1b[0m`);
      } else {
        r.info(`  \x1b[2mbudget enforcement: off\x1b[0m`);
      }

      // Show per-prompt estimate if user provided an argument
      const prompt = args.join(" ");
      if (prompt) {
        const estimator = ctx.orchestrator.getCostEstimator();
        const est = estimator.estimate(prompt);
  
        r.info(estimator.formatEstimate(est));
      }


      return "continue";
    }

    case "trace": {
      const dtracer = ctx.orchestrator.getDistributedTracer();
      const sub = args[0];

      if (!sub) {
        // Show recent traces (last 10)
        const recent = dtracer.getRecentTraces(10);
        if (recent.length === 0) {
          r.info("no traces recorded");
        } else {
    
          for (const t of recent) {
            const dur = t.durationMs !== null ? `${t.durationMs}ms` : "in progress";
            const statusColor = t.status === "ok"
              ? "\x1b[32m"
              : t.status === "error"
                ? "\x1b[31m"
                : t.status === "in_progress"
                  ? "\x1b[33m"
                  : "\x1b[90m";
            r.info(
              `${statusColor}${t.status}\x1b[0m  ${t.traceId.slice(0, 12)}  ${t.rootOperation} \x1b[2m(${dur}, ${t.spanCount} spans, ${t.services.join(",")})\x1b[0m`,
            );
          }
    
        }
        return "continue";
      }

      if (sub === "active") {
        const active = dtracer.getActiveSpans();
        if (active.length === 0) {
          r.info("no active spans");
        } else {
    
          for (const span of active) {
            const elapsed = Date.now() - span.startTime;
            r.info(
              `\x1b[33m${span.spanId.slice(0, 12)}\x1b[0m  ${span.operationName} [\x1b[36m${span.serviceName}\x1b[0m] \x1b[2m${elapsed}ms elapsed\x1b[0m`,
            );
          }
    
        }
        return "continue";
      }

      if (sub === "search") {
        const query = args.slice(1).join(" ");
        if (!query) {
          r.error("usage: /trace search <operation-name>");
          return "continue";
        }
        const results = dtracer.search({ operationName: query });
        if (results.length === 0) {
          r.info("no matching spans");
        } else {
    
          for (const span of results.slice(0, 20)) {
            const dur = span.durationMs !== null ? `${span.durationMs}ms` : "...";
            const statusColor = span.status === "ok" ? "\x1b[32m" : span.status === "error" ? "\x1b[31m" : "\x1b[90m";
            r.info(
              `${statusColor}${span.status}\x1b[0m  ${span.operationName} [\x1b[36m${span.serviceName}\x1b[0m] ${dur} \x1b[2mtrace:${span.traceId.slice(0, 8)}\x1b[0m`,
            );
          }
    
        }
        return "continue";
      }

      if (sub === "slow") {
        const recent = dtracer.getRecentTraces(50);
        const completed = recent.filter(t => t.durationMs !== null);
        completed.sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0));
        const top = completed.slice(0, 10);
        if (top.length === 0) {
          r.info("no completed traces");
        } else {
    
          r.info("\x1b[1mSlowest traces:\x1b[0m");
          for (const t of top) {
            r.info(
              `  ${t.durationMs}ms  ${t.traceId.slice(0, 12)}  ${t.rootOperation} \x1b[2m(${t.spanCount} spans)\x1b[0m`,
            );
          }
    
        }
        return "continue";
      }

      // Treat sub as a trace ID — show full trace timeline
      const traceId = sub;
      // Find matching trace (partial ID match)
      const allRecent = dtracer.getRecentTraces(50);
      const match = allRecent.find(t => t.traceId.startsWith(traceId));
      if (match) {
        r.info(dtracer.formatTrace(match.traceId));
      } else {
        // Try direct lookup
        const spans = dtracer.getTrace(traceId);
        if (spans && spans.length > 0) {
          r.info(dtracer.formatTrace(traceId));
        } else {
          r.error(`trace not found: ${traceId}`);
        }
      }
      return "continue";
    }

    case "agents": {
      const sub = args[0];

      if (sub === "select") {
        const name = args[1];
        if (!name) { r.error("usage: /agents select <name>"); return "continue"; }
        const profile = ctx.orchestrator.getRegistry().get(name);
        if (!profile) { r.error(`unknown profile: "${name}"`); return "continue"; }
        ctx.setPinnedAgent(name);
        r.info(`✓ pinned to ${name} (${profile.provider}/${profile.model})`);
        return "continue";
      }

      if (sub === "auto") {
        ctx.setPinnedAgent(null);
        r.info("✓ auto routing restored");
        return "continue";
      }

      const profiles = ctx.orchestrator.getRegistry().list();
      const pinned = ctx.getPinnedAgent();
      if (profiles.length === 0) {
        r.info("no agent profiles loaded");
      } else {
  
        for (const p of profiles) {
          const health = ctx.orchestrator.getHealth().getStatus(p.name);
          const wt = p.worktree ? "worktree" : "shared";
          const statusIcon = health?.sessionAlive ? "\x1b[32m●\x1b[0m" : "\x1b[90m○\x1b[0m";
          const pinMark = pinned === p.name ? " \x1b[33m← pinned\x1b[0m" : "";
          r.info(`${statusIcon} ${p.name} \x1b[2m(${p.provider}/${p.model}) ${wt} $${p.maxBudgetUsd}\x1b[0m${pinMark}`);
        }
  
      }
      return "continue";
    }

    case "messages": {
      const agentName = args[0];
      if (!agentName) {
        r.error("usage: /messages <agent-name>");
        return "continue";
      }
      const inbox = ctx.orchestrator.getInbox();
      const messages = inbox.getHistory(agentName, 10);
      if (messages.length === 0) {
        r.info("no messages");
      } else {
  
        for (const msg of messages) {
          const dir = msg.from === agentName ? "\x1b[33m→\x1b[0m" : "\x1b[36m←\x1b[0m";
          const other = msg.from === agentName ? msg.to : msg.from;
          r.info(`${dir} ${other}: ${msg.content.slice(0, 80)}`);
        }
  
      }
      return "continue";
    }

    case "ownership": {
      const report = ctx.orchestrator.getOwnership().formatReport();
      r.info(report);
      return "continue";
    }

    case "spawn": {
      const agentName = args[0];
      if (!agentName) {
        r.error("usage: /spawn <agent-name>");
        return "continue";
      }
      try {
        const session = await ctx.orchestrator.spawnAgent(agentName);
        r.info(`spawned ${agentName} in ${session.name}`);
      } catch (e) {
        r.error((e as Error).message);
      }
      return "continue";
    }

    case "task": {
      const agentName = args[0];
      const prompt = args.slice(1).join(" ");
      if (!agentName || !prompt) {
        r.error("usage: /task <agent> <prompt>");
        return "continue";
      }
      try {
        const taskId = await ctx.orchestrator.assign(agentName, prompt);
        r.info(`task ${taskId.slice(0, 8)} assigned to ${agentName}`);
      } catch (e) {
        r.error((e as Error).message);
      }
      return "continue";
    }

    case "pause": {
      if (ctx.conversation.length === 0) {
        r.info("nothing to save");
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
      r.info(`\u2713 session saved (${ctx.conversation.length} turns)`);
      return "continue";
    }

    case "resume": {
      const snap = ctx.consumePendingSnapshot?.() ?? ctx.orchestrator.getStore().getLatestSnapshot();
      if (!snap) {
        r.info("no saved session found");
        return "continue";
      }
      const turns = JSON.parse(snap.turnsJson);
      ctx.conversation.restore({ turns, language: snap.language ?? undefined });
      ctx.orchestrator.getStore().deleteSnapshot(snap.id);
      r.info(`\u2713 restored ${snap.turnCount} turns from ${snap.createdAt}`);
      return "continue";
    }

    case "sessions": {
      const snapshots = ctx.orchestrator.getStore().listSnapshots(undefined, 10);
      if (snapshots.length === 0) {
        r.info("no saved sessions");
        return "continue";
      }

      for (const s of snapshots) {
        const summary = s.summary || "no summary";
        r.info(`\x1b[2m${s.createdAt}\x1b[0m  ${s.turnCount} turns  \x1b[2m${summary}\x1b[0m`);
      }

      return "continue";
    }

    case "memory": {
      const mem = ctx.orchestrator.getMemory();
      const sub = args[0];

      if (!sub) {
        const entries = mem.list("global", 20);
        if (entries.length === 0) {
          r.info("no memories stored");
        } else {
    
          for (const e of entries) {
            r.info(`\x1b[1m${e.key}\x1b[0m\x1b[2m = ${e.value}\x1b[0m`);
          }
    
        }
        return "continue";
      }

      if (sub === "set") {
        const key = args[1];
        const value = args.slice(2).join(" ");
        if (!key || !value) {
          r.error("usage: /memory set <key> <value>");
          return "continue";
        }
        mem.set("global", key, value, "user");
        r.info(`\u2713 ${key} = ${value}`);
        return "continue";
      }

      if (sub === "get") {
        const key = args[1];
        if (!key) {
          r.error("usage: /memory get <key>");
          return "continue";
        }
        const entry = mem.get("global", key);
        if (!entry) {
          r.info(`no memory for "${key}"`);
        } else {
          r.info(`\x1b[1m${entry.key}\x1b[0m = ${entry.value}`);
        }
        return "continue";
      }

      if (sub === "search") {
        const query = args.slice(1).join(" ");
        if (!query) {
          r.error("usage: /memory search <query>");
          return "continue";
        }
        const results = mem.search(query, undefined, 10);
        if (results.length === 0) {
          r.info("no matches");
        } else {
    
          for (const e of results) {
            r.info(`\x1b[1m${e.key}\x1b[0m\x1b[2m = ${e.value}\x1b[0m`);
          }
    
        }
        return "continue";
      }

      if (sub === "delete") {
        const key = args[1];
        if (!key) {
          r.error("usage: /memory delete <key>");
          return "continue";
        }
        const deleted = mem.delete("global", key);
        r.info(deleted ? `\u2713 deleted "${key}"` : `no memory for "${key}"`);
        return "continue";
      }

      r.error("usage: /memory [set|get|search|delete] ...");
      return "continue";
    }

    case "permissions": {
      const permMgr = ctx.orchestrator.getPermissions();
      const permConfig = permMgr.getConfig();

      r.info("\x1b[1mDefaults:\x1b[0m");
      for (const [tool, action] of Object.entries(permConfig.defaults)) {
        const color = action === "allow" ? "\x1b[32m" : action === "deny" ? "\x1b[31m" : "\x1b[33m";
        r.info(`  ${color}${action}\x1b[0m  ${tool}`);
      }
      if (permConfig.rules.length > 0) {
        r.info("\x1b[1mRules:\x1b[0m");
        for (const rule of permConfig.rules) {
          const color = rule.action === "allow" ? "\x1b[32m" : rule.action === "deny" ? "\x1b[31m" : "\x1b[33m";
          r.info(`  ${color}${rule.action}\x1b[0m  ${rule.tool}: ${rule.pattern}`);
        }
      }
      const overrides = Object.keys(permConfig.agentOverrides);
      if (overrides.length > 0) {
        r.info("\x1b[1mAgent overrides:\x1b[0m " + overrides.join(", "));
      }

      return "continue";
    }

    case "undo": {
      const snapMgr = ctx.orchestrator.getGitSnapshots();
      if (!snapMgr.canUndo()) {
        r.info("nothing to undo");
        return "continue";
      }
      const undoResult = await snapMgr.undo();
      if (undoResult.success) {
        r.info(`\u2713 undone (${undoResult.filesReverted.length} files reverted)`);
        for (const f of undoResult.filesReverted.slice(0, 5)) {
          r.info(`  \x1b[2m${f}\x1b[0m`);
        }
        if (undoResult.filesReverted.length > 5) {
          r.info(`  \x1b[2m... and ${undoResult.filesReverted.length - 5} more\x1b[0m`);
        }
      } else {
        r.error(undoResult.error ?? "undo failed");
      }
      return "continue";
    }

    case "redo": {
      const snapMgr = ctx.orchestrator.getGitSnapshots();
      if (!snapMgr.canRedo()) {
        r.info("nothing to redo");
        return "continue";
      }
      const redoResult = await snapMgr.redo();
      if (redoResult.success) {
        r.info(`\u2713 redone (${redoResult.filesReverted.length} files restored)`);
        for (const f of redoResult.filesReverted.slice(0, 5)) {
          r.info(`  \x1b[2m${f}\x1b[0m`);
        }
        if (redoResult.filesReverted.length > 5) {
          r.info(`  \x1b[2m... and ${redoResult.filesReverted.length - 5} more\x1b[0m`);
        }
      } else {
        r.error(redoResult.error ?? "redo failed");
      }
      return "continue";
    }

    case "theme": {
      const themeMgr = ctx.orchestrator.getThemeManager();
      const sub = args[0];

      if (sub === "list") {
        const themes = themeMgr.list();
        const current = themeMgr.get().name;
  
        for (const name of themes) {
          const mark = name === current ? " \x1b[33m← active\x1b[0m" : "";
          r.info(`  ${name}${mark}`);
        }
  
        return "continue";
      }

      if (sub === "preview") {
        r.info(themeMgr.formatPreview());
        return "continue";
      }

      if (sub === "markdown") {
        const mdTheme = args[1];
        if (!mdTheme) {
          r.info("Markdown themes: " + getMarkdownThemes().join(", "));
          return "continue";
        }
        const ok = setMarkdownTheme(mdTheme);
        r.info(ok ? `\u2713 Markdown theme: ${mdTheme}` : `Unknown markdown theme: ${mdTheme} (available: ${getMarkdownThemes().join(", ")})`);
        return "continue";
      }

      if (sub) {
        const ok = themeMgr.switch(sub);
        r.info(ok ? `\u2713 Theme: ${sub}` : `Unknown theme: ${sub}`);
      } else {
        r.info(`Current theme: \x1b[1m${themeMgr.get().name}\x1b[0m`);
        r.info(`Markdown themes: ${getMarkdownThemes().join(", ")}`);
        r.info("\x1b[2mUsage: /theme <name> | /theme markdown <name> | /theme list\x1b[0m");
      }
      return "continue";
    }

    case "models": {
      const registry = ctx.orchestrator.getModelRegistry();
      const sub = args[0];

      if (sub) {
        const model = registry.get(sub);
        if (model) {
    
          r.info(registry.formatModelLine(model));
          if (model.cost.cacheReadPerMillion !== undefined) {
            r.info(`  \x1b[2mcache read: $${model.cost.cacheReadPerMillion}/M\x1b[0m`);
          }
    
        } else {
          r.error(`model not found: ${sub}`);
        }
        return "continue";
      }

      const models = registry.list();

      let lastProvider = "";
      for (const m of models) {
        if (m.provider !== lastProvider) {
          lastProvider = m.provider;
          r.info(`\x1b[1m${m.provider}\x1b[0m`);
        }
        r.info(`  \x1b[2m${registry.formatModelLine(m)}\x1b[0m`);
      }

      return "continue";
    }

    case "plugins": {
      const pluginMgr = ctx.orchestrator.getPluginManager();
      const sub = args[0];

      if (sub === "reload") {
        const count = await pluginMgr.reload();
        r.info(`\u2713 reloaded ${count} plugins`);
        return "continue";
      }

      if (sub === "enable" || sub === "disable") {
        const name = args[1];
        if (!name) { r.error(`usage: /plugins ${sub} <name>`); return "continue"; }
        const ok = pluginMgr.setEnabled(name, sub === "enable");
        r.info(ok ? `\u2713 ${name} ${sub}d` : `plugin not found: ${name}`);
        return "continue";
      }

      const list = pluginMgr.list();
      if (list.length === 0) {
        r.info("no plugins loaded");
        r.info("\x1b[2mPlace plugins in .orchestrator/plugins/ or ~/.orchestrator/plugins/\x1b[0m");
      } else {
  
        for (const p of list) {
          const status = p.enabled ? "\x1b[32m●\x1b[0m" : "\x1b[90m○\x1b[0m";
          r.info(`${status} ${p.name} \x1b[2mv${p.version} (${p.hookCount} hooks)\x1b[0m`);
          r.info(`  \x1b[2m${p.description}\x1b[0m`);
        }
  
      }
      return "continue";
    }

    case "share": {
      const sharer = ctx.orchestrator.getSessionSharer();
      const sub = args[0];

      if (sub === "list") {
        const shared = await sharer.list();
        if (shared.length === 0) {
          r.info("no shared sessions");
        } else {
    
          for (const s of shared) {
            r.info(`\x1b[2m${s.createdAt}\x1b[0m  \x1b[1m${s.title}\x1b[0m  \x1b[2m${s.filePath}\x1b[0m`);
          }
    
        }
        return "continue";
      }

      if (sub === "import") {
        const filePath = args[1];
        if (!filePath) { r.error("usage: /share import <file>"); return "continue"; }
        const session = await sharer.import(filePath);
        if (session) {
          for (const turn of session.turns) {
            ctx.conversation.add(turn);
          }
          r.info(`\u2713 imported ${session.turns.length} turns from "${session.title}"`);
        } else {
          r.error("failed to import session");
        }
        return "continue";
      }

      // Default: export current session
      if (ctx.conversation.length === 0) {
        r.info("nothing to share");
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
      r.info(`\u2713 shared: ${result.filePath}`);
      return "continue";
    }

    case "ast": {
      const astGrep = ctx.orchestrator.getAstGrep();
      const available = await astGrep.isAvailable();
      if (!available) {
        r.error("ast-grep (sg) is not installed. Install: npm i -g @ast-grep/cli");
        return "continue";
      }

      const sub = args[0];
      if (!sub) {
        r.info("usage: /ast search <pattern> [--lang <lang>] [--path <path>]");
        r.info("       /ast replace <pattern> <replacement> [--lang <lang>]");
        return "continue";
      }

      if (sub === "search") {
        const pattern = args[1];
        if (!pattern) { r.error("usage: /ast search <pattern>"); return "continue"; }
        const langIdx = args.indexOf("--lang");
        const pathIdx = args.indexOf("--path");
        const language = langIdx >= 0 ? args[langIdx + 1] : undefined;
        const path = pathIdx >= 0 ? args[pathIdx + 1] : undefined;
        const matches = await astGrep.search(pattern, { language, path, maxResults: 20 });
        r.info(astGrep.formatResults(matches));
        return "continue";
      }

      if (sub === "replace") {
        const pattern = args[1];
        const replacement = args[2];
        if (!pattern || !replacement) { r.error("usage: /ast replace <pattern> <replacement>"); return "continue"; }
        const langIdx = args.indexOf("--lang");
        const language = langIdx >= 0 ? args[langIdx + 1] : undefined;
        const results = await astGrep.replace(pattern, replacement, { language, dryRun: args.includes("--dry-run") });
        for (const r of results) {
          if (r.success) {
            r.info(`\u2713 ${r.file}: ${r.replacements} replacements`);
          } else {
            r.error(`${r.file}: ${r.error}`);
          }
        }
        return "continue";
      }

      r.error(`unknown ast subcommand: ${sub}`);
      return "continue";
    }

    case "pipeline": {
      const task = args.join(" ");
      if (!task) {
        r.error("usage: /pipeline <task description>");
        return "continue";
      }
      const pipeline = ctx.orchestrator.getPlanningPipeline();
      const result = await pipeline.runPipeline(task);

      for (const stage of result.stages) {
        const icon = stage.completed ? "\x1b[32m\u2713\x1b[0m" : "\x1b[31m\u2717\x1b[0m";
        r.info(`${icon} ${stage.stage} \x1b[2m(${stage.durationMs}ms)\x1b[0m ${stage.output}`);
      }
      r.info(pipeline.formatPlan(result.plan));
      return "continue";
    }

    case "boulder": {
      const boulderMgr = ctx.orchestrator.getBoulderManager();
      const sub = args[0];

      if (sub === "list") {
        const boulders = await boulderMgr.list();
        if (boulders.length === 0) {
          r.info("no boulders");
        } else {
    
          for (const b of boulders) {
            const pct = b.totalSteps > 0 ? Math.round((b.completedSteps.length / b.totalSteps) * 100) : 0;
            const color = b.status === "in_progress" ? "\x1b[33m" : b.status === "completed" ? "\x1b[32m" : "\x1b[31m";
            r.info(`${color}${b.status}\x1b[0m  ${b.task.slice(0, 60)}  \x1b[2m${pct}% (${b.completedSteps.length}/${b.totalSteps})\x1b[0m`);
          }
    
        }
        return "continue";
      }

      if (sub === "resume") {
        const latest = await boulderMgr.loadLatest();
        if (!latest) {
          r.info("no active boulder to resume");
        } else {
          r.info(boulderMgr.formatResumeContext(latest));
        }
        return "continue";
      }

      if (sub === "pause") {
        const latest = await boulderMgr.loadLatest();
        if (!latest) { r.info("no active boulder"); return "continue"; }
        const hint = args.slice(1).join(" ") || "manually paused";
        await boulderMgr.pause(latest.id, hint);
        r.info(`\u2713 boulder paused: ${hint}`);
        return "continue";
      }

      if (sub === "cleanup") {
        const removed = await boulderMgr.cleanup();
        r.info(`\u2713 cleaned up ${removed} completed boulders`);
        return "continue";
      }

      // Default: show latest
      const latest = await boulderMgr.loadLatest();
      if (latest) {
        r.info(boulderMgr.formatResumeContext(latest));
      } else {
        r.info("no active boulder");
        r.info("\x1b[2musage: /boulder list | /boulder resume | /boulder pause <hint>\x1b[0m");
      }
      return "continue";
    }

    case "notepad": {
      const npMgr = ctx.orchestrator.getNotepadManager();
      const sub = args[0];

      if (sub === "list") {
        const names = npMgr.listNotepads();
        if (names.length === 0) {
          r.info("no notepads");
        } else {
    
          for (const name of names) {
            r.info(`  ${name}`);
          }
    
        }
        return "continue";
      }

      if (sub === "add") {
        const notepadName = args[1] || "session";
        const category = (args[2] || "learning") as import("../core/notepad.ts").NoteCategory;
        const content = args.slice(3).join(" ");
        if (!content) { r.error("usage: /notepad add <pad> <category> <content>"); return "continue"; }
        npMgr.addNote(notepadName, category, content, "user");
        await npMgr.save(notepadName);
        r.info(`\u2713 note added to ${notepadName} [${category}]`);
        return "continue";
      }

      if (sub === "search") {
        const query = args.slice(1).join(" ");
        if (!query) { r.error("usage: /notepad search <query>"); return "continue"; }
        const results = npMgr.search(query);
        if (results.length === 0) {
          r.info("no matches");
        } else {
    
          for (const note of results.slice(0, 10)) {
            r.info(`\x1b[1m[${note.category}]\x1b[0m ${note.content.slice(0, 80)} \x1b[2m(${note.source})\x1b[0m`);
          }
    
        }
        return "continue";
      }

      if (sub === "show") {
        const name = args[1] || "session";
        const wisdom = npMgr.getWisdom(name);
        if (wisdom) {
          r.info(wisdom);
        } else {
          r.info(`notepad "${name}" is empty`);
        }
        return "continue";
      }

      r.info("usage: /notepad [list|add|search|show] ...");
      return "continue";
    }

    case "oauth": {
      const oauth = ctx.orchestrator.getOAuthMcp();
      const sub = args[0];

      if (!sub) {
        r.info("usage: /oauth authorize <server-name> --auth-url <url> --token-url <url>");
        r.info("       /oauth status <server-name>");
        return "continue";
      }

      if (sub === "authorize") {
        const serverName = args[1];
        if (!serverName) { r.error("usage: /oauth authorize <server-name> --auth-url <url> --token-url <url>"); return "continue"; }
        const authUrlIdx = args.indexOf("--auth-url");
        const tokenUrlIdx = args.indexOf("--token-url");
        if (authUrlIdx < 0 || tokenUrlIdx < 0) { r.error("must provide --auth-url and --token-url"); return "continue"; }
        const authUrl = args[authUrlIdx + 1];
        const tokenUrl = args[tokenUrlIdx + 1];
        if (!authUrl || !tokenUrl) { r.error("invalid urls"); return "continue"; }

        try {
          const { url, token } = await oauth.authorize(serverName, { authorizationUrl: authUrl, tokenUrl });
          r.info(`\x1b[2mOpen this URL to authorize:\x1b[0m`);
          r.info(`\x1b[1m${url}\x1b[0m`);
          r.info("\x1b[2mwaiting for callback...\x1b[0m");
          const result = await token;
          r.info(`\u2713 authorized ${serverName} (expires ${new Date(result.expiresAt).toISOString()})`);
        } catch (e) {
          r.error((e as Error).message);
        }
        return "continue";
      }

      if (sub === "status") {
        const serverName = args[1];
        if (!serverName) { r.error("usage: /oauth status <server-name>"); return "continue"; }
        const token = await oauth.getToken(serverName);
        if (token) {
          const expired = Date.now() > token.expiresAt;
          const status = expired ? "\x1b[31mexpired\x1b[0m" : "\x1b[32mactive\x1b[0m";
          r.info(`${serverName}: ${status} (expires ${new Date(token.expiresAt).toISOString()})`);
        } else {
          r.info(`${serverName}: not authorized`);
        }
        return "continue";
      }

      r.error(`unknown oauth subcommand: ${sub}`);
      return "continue";
    }

    case "category": {
      const categoryRouter = ctx.orchestrator.getCategoryRouter();
      const sub = args[0];

      if (sub === "list") {
        const categories = categoryRouter.listCategories();
  
        for (const cat of categories) {
          r.info(`\x1b[1m${cat.name}\x1b[0m \x1b[2m→ ${cat.tier} (${cat.description})\x1b[0m`);
        }
  
        return "continue";
      }

      if (sub === "classify") {
        const prompt = args.slice(1).join(" ");
        if (!prompt) { r.error("usage: /category classify <prompt>"); return "continue"; }
        const result = categoryRouter.classify(prompt);
        const config = categoryRouter.getCategory(result);
        r.info(`category: \x1b[1m${result}\x1b[0m → ${config?.tier ?? "unknown"} (${config?.description ?? ""})`);
        return "continue";
      }

      // Default: show current categories
      const categories = categoryRouter.listCategories();

      for (const cat of categories) {
        r.info(`\x1b[1m${cat.name}\x1b[0m \x1b[2m→ ${cat.tier} (${cat.description})\x1b[0m`);
      }
      r.info("\n\x1b[2musage: /category list | /category classify <prompt>\x1b[0m");

      return "continue";
    }

    case "queue": {
      const scheduler = ctx.orchestrator.getScheduler();
      const sub = args[0];

      if (sub === "priority") {
        const taskId = args[1];
        const level = args[2] as TaskPriority | undefined;
        if (!taskId || !level) {
          r.error("usage: /queue priority <id> <critical|high|normal|low|background>");
          return "continue";
        }
        const validLevels: TaskPriority[] = ["critical", "high", "normal", "low", "background"];
        if (!validLevels.includes(level)) {
          r.error(`invalid priority: ${level} (use: ${validLevels.join(", ")})`);
          return "continue";
        }
        const matched = findTaskById(scheduler, taskId);
        if (!matched) { r.error(`task not found in queue: ${taskId}`); return "continue"; }
        const ok = scheduler.setPriority(matched, level);
        r.info(ok ? `priority set to ${level} for ${taskId}` : `task not found in queue: ${taskId}`);
        return "continue";
      }

      if (sub === "promote") {
        const taskId = args[1];
        if (!taskId) { r.error("usage: /queue promote <id>"); return "continue"; }
        const matched = findTaskById(scheduler, taskId);
        if (!matched) { r.error(`task not found in queue: ${taskId}`); return "continue"; }
        const ok = scheduler.promote(matched);
        r.info(ok ? `promoted ${taskId}` : `cannot promote ${taskId} (already at highest or not in queue)`);
        return "continue";
      }

      if (sub === "demote") {
        const taskId = args[1];
        if (!taskId) { r.error("usage: /queue demote <id>"); return "continue"; }
        const matched = findTaskById(scheduler, taskId);
        if (!matched) { r.error(`task not found in queue: ${taskId}`); return "continue"; }
        const ok = scheduler.demote(matched);
        r.info(ok ? `demoted ${taskId}` : `cannot demote ${taskId} (already at lowest or not in queue)`);
        return "continue";
      }

      if (sub === "force") {
        const taskId = args[1];
        if (!taskId) { r.error("usage: /queue force <id>"); return "continue"; }
        const matched = findTaskById(scheduler, taskId);
        if (!matched) { r.error(`task not found in queue: ${taskId}`); return "continue"; }
        const snapshot = scheduler.getQueueSnapshot();
        const entry = snapshot.find((q) => q.taskId === matched);
        if (!entry) { r.error(`task not found in queue: ${taskId}`); return "continue"; }
        // Build a minimal Task object for forceExecute
        const store = ctx.orchestrator.getStore();
        const task = store.getTask(matched);
        if (!task) { r.error(`task not found: ${taskId}`); return "continue"; }
        scheduler.forceExecute(task);
        r.info(`force-executing ${taskId}`);
        return "continue";
      }

      if (sub === "cancel") {
        const taskId = args[1];
        if (!taskId) { r.error("usage: /queue cancel <id>"); return "continue"; }
        const matched = findTaskById(scheduler, taskId);
        if (!matched) { r.error(`task not found in queue: ${taskId}`); return "continue"; }
        const ok = scheduler.cancel(matched);
        r.info(ok ? `cancelled ${taskId}` : `task not found in queue: ${taskId}`);
        return "continue";
      }

      // Default: show running + queued tasks
      const running = scheduler.getRunningSnapshot();
      const queued = scheduler.getQueueSnapshot();


      r.info(`\x1b[1mRunning (${running.length}/${scheduler.getRunningCount() + scheduler.getQueueLength() > 0 ? running.length : 0}):\x1b[0m`);
      if (running.length === 0) {
        r.info("  \x1b[2m(none)\x1b[0m");
      } else {
        for (const r of running) {
          const elapsed = formatDuration(r.runningMs);
          const store = ctx.orchestrator.getStore();
          const task = store.getTask(r.taskId);
          const label = task?.prompt?.slice(0, 40) ?? r.taskId;
          r.info(`  \x1b[32m●\x1b[0m ${r.taskId.slice(0, 8)}  \x1b[33m[${r.priority}]\x1b[0m  ${elapsed}  \x1b[2m"${label}"\x1b[0m`);
        }
      }


      r.info(`\x1b[1mQueued (${queued.length}):\x1b[0m`);
      if (queued.length === 0) {
        r.info("  \x1b[2m(none)\x1b[0m");
      } else {
        for (const q of queued) {
          const waited = formatDuration(q.waitingMs);
          const store = ctx.orchestrator.getStore();
          const task = store.getTask(q.taskId);
          const label = task?.prompt?.slice(0, 40) ?? q.taskId;
          r.info(`  ${q.position}. ${q.taskId.slice(0, 8)}  \x1b[33m[${q.priority}]\x1b[0m  ${waited}  \x1b[2m"${label}"\x1b[0m`);
        }
      }

      return "continue";
    }

    case "cancel": {
      const sub = args[0];
      const supervisor = ctx.orchestrator.getSupervisor();
      const pool = supervisor.getPool();

      if (!sub) {
        r.error("usage: /cancel <worker-id>  — cancel a specific worker (partial ID match)");
        r.error("       /cancel all           — cancel all running workers");
        r.error("       /cancel queue <id>    — remove a task from the scheduler queue");
        return "continue";
      }

      if (sub === "all") {
        const reason = args.slice(1).join(" ") || "user requested";
        const count = await ctx.orchestrator.cancelAllWorkers(reason);
        if (count === 0) {
          r.info("no active workers to cancel");
        } else {
          r.info(`cancelled ${count} worker${count !== 1 ? "s" : ""}`);
        }

        // Show current status
        const counts = pool.countByStatus();
        r.info(`\x1b[2mstatus: ${counts.running} running, ${counts.completed} completed, ${counts.failed} failed, ${counts.cancelled} cancelled\x1b[0m`);
        return "continue";
      }

      if (sub === "queue") {
        const taskId = args[1];
        if (!taskId) { r.error("usage: /cancel queue <task-id>"); return "continue"; }
        const scheduler = ctx.orchestrator.getScheduler();
        const matched = findTaskById(scheduler, taskId);
        if (!matched) { r.error(`task not found in queue: ${taskId}`); return "continue"; }
        const ok = scheduler.cancel(matched);
        r.info(ok ? `cancelled queued task ${matched.slice(0, 12)}` : `task not found in queue: ${taskId}`);
        return "continue";
      }

      // Cancel a specific worker by partial ID match
      const reason = args.slice(1).join(" ") || "user requested";
      const allWorkers = pool.getActive();
      const matched = allWorkers.find(
        (w) => w.id === sub || w.id.startsWith(sub),
      );

      if (!matched) {
        r.error(`no active worker matching "${sub}"`);
        const active = pool.getActive();
        if (active.length > 0) {
          r.info("\x1b[2mactive workers:\x1b[0m");
          for (const w of active) {
            r.info(`  \x1b[2m${w.id}  ${w.agentName}  ${w.status}\x1b[0m`);
          }
        }
        return "continue";
      }

      const ok = await ctx.orchestrator.cancelWorker(matched.id, reason);
      if (ok) {
        r.info(`cancelled ${matched.id} (${matched.agentName})`);
      } else {
        r.error(`failed to cancel ${matched.id}`);
      }

      // Show current status
      const counts = pool.countByStatus();
      r.info(`\x1b[2mstatus: ${counts.running} running, ${counts.completed} completed, ${counts.failed} failed, ${counts.cancelled} cancelled\x1b[0m`);
      return "continue";
    }

    case "dlq": {
      const dlq = ctx.orchestrator.getDeadLetterQueue();
      const sub = args[0];

      if (!sub) {
        // Default: show DLQ summary
        const dlqStats = dlq.stats();
  
        r.info(`\x1b[1mDead Letter Queue\x1b[0m`);
        r.info(`  pending: \x1b[33m${dlqStats.pending}\x1b[0m  retrying: \x1b[36m${dlqStats.retrying}\x1b[0m  resolved: \x1b[32m${dlqStats.resolved}\x1b[0m  discarded: \x1b[90m${dlqStats.discarded}\x1b[0m`);
        if (dlqStats.totalCostWasted > 0) {
          r.info(`  wasted: \x1b[31m$${dlqStats.totalCostWasted < 0.01 ? dlqStats.totalCostWasted.toFixed(4) : dlqStats.totalCostWasted.toFixed(2)}\x1b[0m`);
        }
        if (dlqStats.topErrors.length > 0) {
          r.info(`  \x1b[1mtop errors:\x1b[0m`);
          for (const err of dlqStats.topErrors.slice(0, 3)) {
            r.info(`    ${err.count}x  ${err.error.slice(0, 70)}`);
          }
        }
        if (dlqStats.total === 0) {
          r.info(`  \x1b[2m(empty)\x1b[0m`);
        }
  
        return "continue";
      }

      if (sub === "list") {
        const pending = dlq.list("pending");
        if (pending.length === 0) {
          r.info("no pending dead letters");
          return "continue";
        }
  
        r.info(`\x1b[1mDead Letter Queue\x1b[0m (${pending.length} pending):`);
        for (let i = 0; i < pending.length; i++) {
          const letter = pending[i];
          const ago = formatTimeAgo(letter.enqueuedAt);
          r.info(`  ${i + 1}. \x1b[1m${letter.id.slice(0, 12)}\x1b[0m  \x1b[33m[${letter.reason}]\x1b[0m  ${ago}`);
          r.info(`     \x1b[2m"${letter.prompt.slice(0, 50) || letter.agentName}" — ${letter.error.slice(0, 60)}\x1b[0m`);
        }
  
        return "continue";
      }

      if (sub === "show") {
        const id = args[1];
        if (!id) { r.error("usage: /dlq show <id>"); return "continue"; }
        const letter = dlq.get(id);
        if (!letter) { r.error(`dead letter not found: ${id}`); return "continue"; }
  
        r.info(`\x1b[1m${letter.id}\x1b[0m`);
        r.info(`  status:    ${letter.status}`);
        r.info(`  reason:    ${letter.reason}`);
        r.info(`  task:      ${letter.taskId}`);
        r.info(`  subtask:   ${letter.subtaskId}`);
        r.info(`  worker:    ${letter.workerId}`);
        r.info(`  agent:     ${letter.agentName}`);
        r.info(`  provider:  ${letter.provider}/${letter.model}`);
        r.info(`  attempts:  ${letter.attempts}`);
        r.info(`  enqueued:  ${letter.enqueuedAt}`);
        r.info(`  error:     \x1b[31m${letter.error}\x1b[0m`);
        if (letter.prompt) {
          r.info(`  prompt:    ${letter.prompt.slice(0, 200)}`);
        }
        r.info(`  tokens:    ${letter.metadata.tokenUsage.toLocaleString()}`);
        r.info(`  cost:      $${letter.metadata.costUsd < 0.01 ? letter.metadata.costUsd.toFixed(4) : letter.metadata.costUsd.toFixed(2)}`);
        if (letter.metadata.corrections.length > 0) {
          r.info(`  corrections:`);
          for (const c of letter.metadata.corrections) {
            r.info(`    - ${c.slice(0, 100)}`);
          }
        }
        if (letter.metadata.turnHistory.length > 0) {
          r.info(`  turn history:`);
          for (const t of letter.metadata.turnHistory.slice(-5)) {
            r.info(`    - ${t.slice(0, 100)}`);
          }
        }
        if (letter.metadata.intermediateResults.length > 0) {
          r.info(`  intermediate results: ${letter.metadata.intermediateResults.length}`);
        }
  
        return "continue";
      }

      if (sub === "retry") {
        const id = args[1];
        if (!id) { r.error("usage: /dlq retry <id>"); return "continue"; }
        const payload = dlq.getRetryPayload(id);
        if (!payload) { r.error(`dead letter not found: ${id}`); return "continue"; }
        const marked = dlq.markRetrying(id);
        if (!marked) { r.error(`cannot retry: letter is not in pending state`); return "continue"; }
  
        r.info(`retrying dead letter ${id} (attempt ${payload.previousAttempts + 1})`);
        r.info(`\x1b[2merror context injected: ${payload.errorContext.split("\n").length} lines\x1b[0m`);
  
        return "continue";
      }

      if (sub === "discard") {
        const id = args[1];
        if (!id) { r.error("usage: /dlq discard <id>"); return "continue"; }
        const ok = dlq.discard(id);
        r.info(ok ? `discarded ${id}` : `dead letter not found: ${id}`);
        return "continue";
      }

      if (sub === "stats") {
        const dlqStats = dlq.stats();
  
        r.info(`\x1b[1mDLQ Statistics\x1b[0m`);
        r.info(`  total:     ${dlqStats.total}`);
        r.info(`  pending:   \x1b[33m${dlqStats.pending}\x1b[0m`);
        r.info(`  retrying:  \x1b[36m${dlqStats.retrying}\x1b[0m`);
        r.info(`  resolved:  \x1b[32m${dlqStats.resolved}\x1b[0m`);
        r.info(`  discarded: \x1b[90m${dlqStats.discarded}\x1b[0m`);
        r.info(`  cost wasted: \x1b[31m$${dlqStats.totalCostWasted < 0.01 ? dlqStats.totalCostWasted.toFixed(4) : dlqStats.totalCostWasted.toFixed(2)}\x1b[0m`);
        if (dlqStats.topErrors.length > 0) {
          r.info(`\n  \x1b[1mTop Errors:\x1b[0m`);
          for (const err of dlqStats.topErrors) {
            r.info(`    ${err.count}x  ${err.error}`);
          }
        }
  
        return "continue";
      }

      if (sub === "clear") {
        dlq.clear();
        r.info("cleared resolved/discarded entries from DLQ");
        return "continue";
      }

      r.error("usage: /dlq [list|show|retry|discard|stats|clear]");
      return "continue";
    }

    case "enforce": {
      const enforcer = ctx.orchestrator.getHarnessEnforcer();
      const sub = parts[1]?.toLowerCase();

      if (!sub || sub === "status") {
        const state = enforcer.getState();
        r.info(`\x1b[1m── Harness Enforcer ──\x1b[0m`);
        r.info(`  enabled:     ${enforcer.isEnabled() ? "\x1b[32myes\x1b[0m" : "\x1b[31mno\x1b[0m"}`);
        r.info(`  role:        ${state.activeRules.length > 0 ? "active" : "none"}`);
        r.info(`  rules:       ${state.activeRules.join(", ")}`);
        r.info(`  tool calls:  ${state.totalToolCalls}`);
        r.info(`  violations:  ${state.violationCount}`);
        r.info(`  files read:  ${state.filesRead}`);
        r.info(`  files mod:   ${state.filesWritten + state.filesEdited}`);
        r.info(`  src modified: ${state.sourceFilesModified} (tests run: ${state.testRunSinceLastModify ? "yes" : "no"})`);
        return "continue";
      }

      if (sub === "on") {
        enforcer.setEnabled(true);
        r.info("harness enforcer \x1b[32menabled\x1b[0m");
        return "continue";
      }

      if (sub === "off") {
        enforcer.setEnabled(false);
        r.info("harness enforcer \x1b[31mdisabled\x1b[0m");
        return "continue";
      }

      if (sub === "violations" || sub === "v") {
        const violations = enforcer.getViolations();
        if (violations.length === 0) {
          r.info("no violations recorded");
          return "continue";
        }
        r.info(`\x1b[1m── Violations (${violations.length}) ──\x1b[0m`);
        for (const v of violations.slice(-20)) {
          const icon = v.severity === "block" ? "\x1b[31mX\x1b[0m" : v.severity === "warn" ? "\x1b[33m!\x1b[0m" : "\x1b[36m~\x1b[0m";
          r.info(`  [${icon}] \x1b[1m${v.ruleId}\x1b[0m ${v.toolName}: ${v.message}`);
        }
        if (violations.length > 20) r.info(`\x1b[2m  ... and ${violations.length - 20} more\x1b[0m`);
        return "continue";
      }

      if (sub === "report") {
        r.info(enforcer.formatReport());
        return "continue";
      }

      if (sub === "reset") {
        enforcer.reset();
        r.info("enforcer state reset");
        return "continue";
      }

      r.error("usage: /enforce [status|on|off|violations|report|reset]");
      return "continue";
    }

    case "diff": {
      const ghostSha = ctx.orchestrator.getGhostSha();
      if (!ghostSha) {
        r.info("no session snapshot available (not in a git repo?)");
        return "continue";
      }
      const diff = await diffFromGhost(ghostSha);
      if (!diff) {
        r.info("no changes since session start");
      } else {
  
        for (const line of diff.split("\n").slice(0, 30)) {
          const color = line.startsWith("+") ? "\x1b[32m" : line.startsWith("-") ? "\x1b[31m" : "\x1b[2m";
          r.info(`${color}${line}\x1b[0m`);
        }
        if (diff.split("\n").length > 30) r.info("\x1b[2m... truncated\x1b[0m");
  
      }
      return "continue";
    }

    case "compact": {
      const compactor = new ContextCompactor();
      const turns = ctx.conversation.getTurns();
      if (turns.length === 0) {
        r.info("nothing to compact");
        return "continue";
      }
      const { turns: compactedTurns, result: compactionResult } = compactor.compact(turns);
      ctx.conversation.clear();
      for (const turn of compactedTurns) {
        ctx.conversation.add(turn);
      }
      r.info(
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
        r.info(`${dir} is already trusted`);
      } else {
        await trustProject(dir);
        r.info(`\u2713 trusted ${dir}`);
      }
      return "continue";
    }

    case "consolidate": {
      const consolidator = ctx.orchestrator.getConsolidator();
      r.info("consolidating memories from past sessions...");
      const result = await consolidator.consolidate();
      r.info(`\u2713 extracted ${result.extracted}, consolidated ${result.consolidated}`);
      return "continue";
    }

    case "checkpoint": {
      const cpMgr = ctx.orchestrator.getCheckpointManager();
      const sub = args[0];

      if (sub === "list") {
        const cps = cpMgr.list("repl");
        if (cps.length === 0) {
          r.info("no checkpoints");
        } else {
    
          for (const cp of cps) {
            r.info(`\x1b[2m${cp.createdAt}\x1b[0m  ${cp.label}  \x1b[2m${cp.sha.slice(0, 8)}\x1b[0m`);
          }
    
        }
        return "continue";
      }

      if (sub === "rollback") {
        const ok = await cpMgr.rollbackToLatest("repl");
        if (ok) {
          r.info("\u2713 rolled back to latest checkpoint");
        } else {
          r.error("no checkpoint to rollback to");
        }
        return "continue";
      }

      // Default: create checkpoint with optional label
      const label = args.join(" ") || `manual-${Date.now().toString(36)}`;
      try {
        const cp = await cpMgr.create("repl", "user", label);
        r.info(`\u2713 checkpoint ${cp.id.slice(0, 12)} (${cp.label})`);
      } catch (e) {
        r.error((e as Error).message);
      }
      return "continue";
    }

    case "mcp": {
      const mcpMgr = ctx.orchestrator.getMcpManager();
      const sub = args[0];

      if (sub === "tools") {
        const tools = mcpMgr.getTools();
        if (tools.length === 0) {
          r.info("no MCP tools available");
        } else {
    
          let currentServer = "";
          for (const t of tools) {
            if (t.serverName !== currentServer) {
              currentServer = t.serverName;
              r.info(`\x1b[1m${currentServer}\x1b[0m`);
            }
            r.info(`  \x1b[2m${t.name}: ${t.description}\x1b[0m`);
          }
    
        }
        return "continue";
      }

      if (sub === "connect") {
        const name = args[1];
        if (!name) { r.error("usage: /mcp connect <server-name>"); return "continue"; }
        const entry = getCatalogEntry(name);
        if (!entry) { r.error(`unknown server: "${name}"`); return "continue"; }
        const connected = await mcpMgr.connectOnDemand([entry]);
        if (connected.length > 0) {
          r.info(`\u2713 connected ${name} (${mcpMgr.getTools([name]).length} tools)`);
        } else {
          r.error(`failed to connect ${name}`);
        }
        return "continue";
      }

      if (sub === "disconnect") {
        const name = args[1];
        if (!name) { r.error("usage: /mcp disconnect <server-name>"); return "continue"; }
        const ok = await mcpMgr.disconnectServer(name);
        r.info(ok ? `\u2713 disconnected ${name}` : `"${name}" not connected`);
        return "continue";
      }

      // Default: show connected servers
      const servers = mcpMgr.getConnectedServers();
      if (servers.length === 0) {
        r.info("no MCP servers connected");
        r.info("\x1b[2musage: /mcp connect <name> | /mcp tools\x1b[0m");
      } else {
  
        for (const name of servers) {
          const toolCount = mcpMgr.getTools([name]).length;
          r.info(`\x1b[32m●\x1b[0m ${name} \x1b[2m(${toolCount} tools)\x1b[0m`);
        }
        r.info(`\x1b[2m${mcpMgr.getToolCount()} tools total\x1b[0m`);
  
      }
      return "continue";
    }

    case "plan": {
      if (!ctx.planMode) {
        r.error("plan mode not available");
        return "continue";
      }
      const sub = args[0];

      if (sub === "list") {
        const plans = await ctx.planMode.listPlans(process.cwd());
        if (plans.length === 0) {
          r.info("no plans saved");
        } else {
    
          for (const p of plans) {
            r.info(`\x1b[2m${p.createdAt}\x1b[0m  \x1b[1m${p.title}\x1b[0m  \x1b[2m${p.id}\x1b[0m`);
          }
    
        }
        return "continue";
      }

      if (sub === "save") {
        const title = args.slice(1).join(" ") || "Untitled Plan";
        const content = ctx.conversation.generateSummary();
        const plan = await ctx.planMode.savePlan(title, content, process.cwd());
        r.info(`\u2713 plan saved: ${plan.filePath}`);
        return "continue";
      }

      // Default: toggle plan mode
      const isActive = ctx.planMode.toggle();
      r.info(isActive
        ? "\x1b[33m\u2713 plan mode ON\x1b[0m — read-only analysis, no code changes"
        : "\u2713 plan mode OFF — full editing restored");
      return "continue";
    }

    case "fork": {
      if (!ctx.forkManager) {
        r.error("session forking not available");
        return "continue";
      }
      const sub = args[0];

      if (sub === "list") {
        const branches = ctx.forkManager.listBranches();
  
        for (const b of branches) {
          const active = b.active ? " \x1b[33m<- active\x1b[0m" : "";
          r.info(`  ${b.label} \x1b[2m(${b.turnCount} turns, fork@${b.forkPoint})\x1b[0m${active}`);
        }
  
        return "continue";
      }

      if (sub === "tree") {
        r.info(ctx.forkManager.formatTree());
        return "continue";
      }

      if (sub === "switch") {
        const branchId = args[1];
        if (!branchId) { r.error("usage: /fork switch <branch-id>"); return "continue"; }
        const branches = ctx.forkManager.listBranches();
        const target = branches.find(b => b.label === branchId || b.id.startsWith(branchId));
        if (!target) { r.error(`branch not found: ${branchId}`); return "continue"; }
        const switched = ctx.forkManager.switchTo(target.id);
        if (switched) {
          // Sync conversation with branch turns
          ctx.conversation.clear();
          for (const turn of switched.turns) {
            ctx.conversation.add(turn);
          }
          r.info(`\u2713 switched to ${target.label} (${switched.turns.length} turns)`);
        }
        return "continue";
      }

      // Default: create fork at current position
      const label = args.join(" ") || undefined;
      const branch = ctx.forkManager.fork(ctx.conversation.length, label);
      r.info(`\u2713 forked at turn ${ctx.conversation.length} → ${branch.label}`);
      return "continue";
    }

    case "lsp": {
      const lspMgr = ctx.orchestrator.getLspManager();
      const sub = args[0];

      if (sub === "diagnostics") {
        const file = args[1];
        if (!file) { r.error("usage: /lsp diagnostics <file>"); return "continue"; }
        const diags = await lspMgr.getDiagnostics(file);
        if (diags.length === 0) {
          r.info("no diagnostics");
        } else {
    
          for (const d of diags) {
            const color = d.severity === "error" ? "\x1b[31m" : d.severity === "warning" ? "\x1b[33m" : "\x1b[2m";
            r.info(`${color}${d.severity}\x1b[0m ${d.file}:${d.line + 1}:${d.column + 1} ${d.message}`);
          }
    
        }
        return "continue";
      }

      if (sub === "symbols") {
        const file = args[1];
        if (!file) { r.error("usage: /lsp symbols <file>"); return "continue"; }
        const symbols = await lspMgr.documentSymbols(file);
        if (symbols.length === 0) {
          r.info("no symbols found");
        } else {
    
          for (const s of symbols) {
            r.info(`\x1b[1m${s.kind}\x1b[0m ${s.name} \x1b[2m${s.file}:${s.line + 1}\x1b[0m`);
          }
    
        }
        return "continue";
      }

      // Default: show active LSP servers
      const active = lspMgr.listActive();
      if (active.length === 0) {
        r.info("no LSP servers running");
        r.info("\x1b[2musage: /lsp diagnostics <file> | /lsp symbols <file>\x1b[0m");
      } else {
  
        for (const name of active) {
          r.info(`\x1b[32m●\x1b[0m ${name}`);
        }
  
      }
      return "continue";
    }

    case "spec": {
      const task = args.join(" ");
      if (!task) {
        r.error("usage: /spec <task description>");
        return "continue";
      }

      const complexity = args.length > 20 ? "complex" : args.length > 8 ? "standard" : "simple";
      const phases = selectPhases(complexity);
      r.info(`spec pipeline: ${complexity} (${phases.join(" → ")})`);

      const outputs = new Map<SpecPhase, string>();
      for (const phase of phases) {
        r.info(`\x1b[2m▸ ${phase}...\x1b[0m`);
        const prompt = buildPhasePrompt(phase, { task, previousOutputs: outputs });
        // Store prompt as output placeholder (agent execution would replace this)
        outputs.set(phase, prompt);
      }

      const specOutput = outputs.get("spec") ?? outputs.get("planning") ?? "";
      const parsed = parseSpecResult(specOutput);


      if (parsed.requirements.length > 0) {
        r.info("\x1b[1mRequirements:\x1b[0m");
        for (const r of parsed.requirements.slice(0, 10)) r.info(`  • ${r}`);
      }
      if (parsed.implementationSteps.length > 0) {
        r.info("\x1b[1mImplementation Steps:\x1b[0m");
        for (const s of parsed.implementationSteps.slice(0, 10)) r.info(`  ${s}`);
      }
      if (parsed.risks.length > 0) {
        r.info("\x1b[1mRisks:\x1b[0m");
        for (const r of parsed.risks.slice(0, 5)) r.info(`  △ ${r}`);
      }
      r.info(`\x1b[2mestimated complexity: ${parsed.estimatedComplexity}\x1b[0m`);

      return "continue";
    }

    case "ideate": {
      const task = args.join(" ");
      if (!task) {
        r.error("usage: /ideate <code context or task>");
        return "continue";
      }

      const dimensions = Object.keys(DIMENSION_PROMPTS) as IdeationDimension[];
      r.info(`ideation: analyzing ${dimensions.length} dimensions...`);

      const allIdeas: import("../config/types.ts").Idea[] = [];
      for (const dim of dimensions) {
        const prompt = buildIdeationPrompt(dim, task);
        // In a full flow the prompt would be sent to an agent
        // For now, provide the structured prompt for user to feed to an agent
        r.info(`  \x1b[2m▸ ${dim}: ${DIMENSION_PROMPTS[dim].slice(0, 60)}...\x1b[0m`);
      }

      // If no ideas parsed (no agent call), show prompt summary
      if (allIdeas.length === 0) {
  
        r.info("Prompts generated for each dimension.");
        r.info("Use these as subtask prompts in multi-agent mode for full analysis.");
        r.info(`\x1b[2mdimensions: ${dimensions.join(", ")}\x1b[0m`);
      } else {
        const prioritized = prioritizeIdeas(allIdeas);
  
        for (const idea of prioritized.slice(0, 10)) {
          const prio = idea.priority === "high" ? "\x1b[31m" : idea.priority === "medium" ? "\x1b[33m" : "\x1b[32m";
          r.info(`${prio}[${idea.priority}]\x1b[0m ${idea.title} \x1b[2m(effort: ${idea.effort})\x1b[0m`);
          if (idea.description) r.info(`  \x1b[2m${idea.description.slice(0, 100)}\x1b[0m`);
        }
      }

      return "continue";
    }

    case "doctor": {
      const doctor = ctx.orchestrator.getDoctor();
      r.info("running diagnostics...");
      const results = await doctor.runAll();

      for (const r of results) {
        const icon = r.status === "pass" ? "\x1b[32m✓\x1b[0m" : r.status === "warn" ? "\x1b[33m△\x1b[0m" : "\x1b[31m✗\x1b[0m";
        r.info(`${icon} ${r.check}: ${r.detail}`);
      }

      return "continue";
    }

    case "stats": {
      const stats = ctx.orchestrator.getStatistics();
      const session = stats.getSessionStats();
      r.info(stats.formatStats(session));
      return "continue";
    }

    case "worktree": {
      const wt = ctx.orchestrator.getGitWorktree();
      const sub = args[0];
      if (sub === "list") {
        const trees = await wt.list();
        if (trees.length === 0) {
          r.info("no active worktrees");
        } else {
    
          for (const t of trees) {
            r.info(`\x1b[1m${t.branch}\x1b[0m \x1b[2m${t.path}\x1b[0m${t.agentId ? ` \x1b[33m(${t.agentId})\x1b[0m` : ""}`);
          }
    
        }
        return "continue";
      }
      if (sub === "create") {
        const branch = args[1];
        if (!branch) { r.error("usage: /worktree create <branch>"); return "continue"; }
        try {
          const info = await wt.create(branch);
          r.info(`✓ worktree created: ${info.path} (${info.branch})`);
        } catch (e) { r.error((e as Error).message); }
        return "continue";
      }
      if (sub === "remove") {
        const path = args[1];
        if (!path) { r.error("usage: /worktree remove <path>"); return "continue"; }
        try {
          await wt.remove(path);
          r.info(`✓ worktree removed: ${path}`);
        } catch (e) { r.error((e as Error).message); }
        return "continue";
      }
      if (sub === "cleanup") {
        await wt.cleanupAll();
        r.info("✓ all worktrees cleaned up");
        return "continue";
      }
      r.info("usage: /worktree [list|create|remove|cleanup]");
      return "continue";
    }

    case "background": {
      const bg = ctx.orchestrator.getBackgroundAgent();
      const sub = args[0];
      if (sub === "list") {
        const active = bg.listActive();
        if (active.length === 0) {
          r.info("no background tasks");
        } else {
    
          for (const t of active) {
            const status = t.status === "running" ? "\x1b[33m●\x1b[0m" : t.status === "completed" ? "\x1b[32m●\x1b[0m" : "\x1b[31m●\x1b[0m";
            r.info(`${status} ${t.id.slice(0, 8)} \x1b[2m${t.prompt.slice(0, 60)}\x1b[0m`);
          }
    
        }
        return "continue";
      }
      if (sub === "cancel") {
        const taskId = args[1];
        if (!taskId) { r.error("usage: /background cancel <task-id>"); return "continue"; }
        bg.cancel(taskId);
        r.info(`✓ cancelled ${taskId}`);
        return "continue";
      }
      if (sub === "result") {
        const taskId = args[1];
        if (!taskId) { r.error("usage: /background result <task-id>"); return "continue"; }
        const result = await bg.getResult(taskId);
        if (result) {
          r.info(result.slice(0, 2000));
        } else {
          r.info("no result yet or task not found");
        }
        return "continue";
      }
      r.info("usage: /background [list|cancel|result] ...");
      return "continue";
    }

    case "stash": {
      const stash = ctx.orchestrator.getPromptStash();
      const sub = args[0];
      if (sub === "push") {
        const text = args.slice(1).join(" ");
        if (!text) { r.error("usage: /stash push <text>"); return "continue"; }
        await stash.push(text);
        r.info(`✓ stashed: ${text.slice(0, 60)}`);
        return "continue";
      }
      if (sub === "pop") {
        const text = await stash.pop();
        if (text) {
          r.info(`popped: ${text}`);
        } else {
          r.info("stash is empty");
        }
        return "continue";
      }
      if (sub === "list") {
        const entries = await stash.list();
        if (entries.length === 0) {
          r.info("stash is empty");
        } else {
    
          for (let i = 0; i < entries.length; i++) {
            r.info(`\x1b[2m${i}:\x1b[0m ${entries[i].text.slice(0, 80)} \x1b[2m(${entries[i].timestamp})\x1b[0m`);
          }
    
        }
        return "continue";
      }
      r.info("usage: /stash [push|pop|list] ...");
      return "continue";
    }

    case "question": {
      r.info("usage: questions are asked by agents via the question tool");
      r.info("\x1b[2mpending questions will appear in the REPL for you to answer\x1b[0m");
      return "continue";
    }

    case "search": {
      const sub = args[0];

      if (sub === "web") {
        const query = args.slice(1).join(" ");
        if (!query) { r.error("usage: /search web <query>"); return "continue"; }
        try {
          const webEngine = ctx.orchestrator.getWebSearch();
          const results = await webEngine.search(query);
          if (results.length === 0) {
            r.info("no results");
          } else {
      
            for (const r of results) {
              r.info(`\x1b[1m${r.title}\x1b[0m`);
              r.info(`  \x1b[2m${r.url}\x1b[0m`);
              if (r.snippet) r.info(`  ${r.snippet.slice(0, 150)}`);
            }
      
          }
        } catch (e) { r.error((e as Error).message); }
        return "continue";
      }

      if (sub === "code") {
        const query = args.slice(1).join(" ");
        if (!query) { r.error("usage: /search code <query>"); return "continue"; }
        try {
          const codeEngine = ctx.orchestrator.getBuiltinCodeSearch();
          const results = await codeEngine.search(query);
          if (results.length === 0) {
            r.info("no results");
          } else {
      
            for (const r of results) {
              const loc = r.repo ? `\x1b[36m${r.repo}\x1b[0m/` : "";
              const lineInfo = r.line ? `:${r.line}` : "";
              r.info(`${loc}\x1b[1m${r.file}\x1b[0m${lineInfo}`);
              if (r.content) r.info(`  \x1b[2m${r.content.slice(0, 120)}\x1b[0m`);
            }
      
          }
        } catch (e) { r.error((e as Error).message); }
        return "continue";
      }

      if (sub === "local") {
        const query = args.slice(1).join(" ");
        if (!query) { r.error("usage: /search local <query>"); return "continue"; }
        try {
          const codeEngine = ctx.orchestrator.getBuiltinCodeSearch();
          const results = await codeEngine.search(query, { local: true });
          if (results.length === 0) {
            r.info("no results");
          } else {
      
            for (const r of results) {
              const lineInfo = r.line ? `:${r.line}` : "";
              r.info(`\x1b[1m${r.file}\x1b[0m${lineInfo}`);
              if (r.content) r.info(`  \x1b[2m${r.content.slice(0, 120)}\x1b[0m`);
            }
      
          }
        } catch (e) { r.error((e as Error).message); }
        return "continue";
      }

      // Default: try existing Exa-based CodeSearchEngine first, then fall back to web search
      const query = args.join(" ");
      if (!query) { r.error("usage: /search [web|code|local] <query>"); return "continue"; }
      try {
        const engine = ctx.orchestrator.getCodeSearch();
        const results = await engine.search(query);
        if (results.length > 0) {
    
          for (const r of results) {
            r.info(`\x1b[1m${r.title}\x1b[0m \x1b[2m(${r.score.toFixed(2)})\x1b[0m`);
            r.info(`  \x1b[2m${r.url}\x1b[0m`);
            if (r.content) r.info(`  ${r.content.slice(0, 120)}`);
          }
    
        } else {
          // Fall back to web search
          const webEngine = ctx.orchestrator.getWebSearch();
          const webResults = await webEngine.search(query);
          if (webResults.length === 0) {
            r.info("no results");
          } else {
      
            r.info("\x1b[2m(via web search)\x1b[0m");
            for (const r of webResults) {
              r.info(`\x1b[1m${r.title}\x1b[0m`);
              r.info(`  \x1b[2m${r.url}\x1b[0m`);
              if (r.snippet) r.info(`  ${r.snippet.slice(0, 150)}`);
            }
      
          }
        }
      } catch (e) { r.error((e as Error).message); }
      return "continue";
    }

    case "tasks": {
      const taskMgr = ctx.orchestrator.getPersistentTasks();
      const sub = args[0];
      if (sub === "create") {
        const subject = args.slice(1).join(" ");
        if (!subject) { r.error("usage: /tasks create <subject>"); return "continue"; }
        const task = await taskMgr.create({ subject, description: "", status: "pending" });
        r.info(`✓ task ${task.id.slice(0, 8)}: ${subject}`);
        return "continue";
      }
      if (sub === "done") {
        const id = args[1];
        if (!id) { r.error("usage: /tasks done <id>"); return "continue"; }
        await taskMgr.update(id, { status: "completed" });
        r.info(`✓ completed ${id}`);
        return "continue";
      }
      // Default: list
      const tasks = await taskMgr.list();
      if (tasks.length === 0) {
        r.info("no tasks");
      } else {
  
        for (const t of tasks) {
          const icon = t.status === "completed" ? "\x1b[32m✓\x1b[0m" : t.status === "in_progress" ? "\x1b[33m●\x1b[0m" : "\x1b[90m○\x1b[0m";
          r.info(`${icon} ${t.id.slice(0, 8)} ${t.subject}`);
        }
  
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
      r.info(output);
      return "continue";
    }

    case "refactor": {
      const engine = ctx.orchestrator.getRefactorEngine();
      const goal = args.join(" ");
      if (!goal) { r.error("usage: /refactor <goal>"); return "continue"; }
      r.info("starting refactor...");
      try {
        const result = await engine.execute(process.cwd(), goal);
  
        for (const phase of result.phases) {
          const icon = phase.status === "success" ? "\x1b[32m✓\x1b[0m" : phase.status === "failed" ? "\x1b[31m✗\x1b[0m" : "\x1b[90m-\x1b[0m";
          r.info(`${icon} ${phase.name} \x1b[2m(${phase.durationMs}ms)\x1b[0m`);
        }
        r.info(`\n${result.summary}`);
  
      } catch (e) { r.error((e as Error).message); }
      return "continue";
    }

    case "variants": {
      const mgr = ctx.orchestrator.getModelVariants();
      const sub = args[0];
      if (sub === "set") {
        const variant = args[1];
        if (!variant) { r.error("usage: /variants set <fast|default|high|max>"); return "continue"; }
        const config = mgr.getVariant("default", variant);
        if (config) {
          r.info(`✓ variant: ${variant} (temp=${config.temperature}, maxTokens=${config.maxTokens})`);
        } else {
          r.error(`unknown variant: ${variant}`);
        }
        return "continue";
      }
      const variants = mgr.listVariants();

      for (const v of variants) {
        r.info(`\x1b[1m${v}\x1b[0m`);
      }

      return "continue";
    }

    case "fastwork": {
      const fw = ctx.orchestrator.getFastwork();
      const overrides = fw.getOverrides();
      r.info(`\x1b[1mfastwork mode\x1b[0m: model=${overrides.model}, maxTurns=${overrides.maxTurns}, forceMultiAgent=${overrides.forceMultiAgent}`);
      return "continue";
    }

    case "ultrathink": {
      const uth = ctx.orchestrator.getUltrathink();
      const uthOverrides = uth.getOverrides();
      r.info(`\x1b[1multrathink mode\x1b[0m: model=${uthOverrides.model}, maxTurns=${uthOverrides.maxTurns}, temperature=${uthOverrides.temperature}, forcePlanning=${uthOverrides.forcePlanning}, forceQA=${uthOverrides.forceQA}, forceIdeation=${uthOverrides.forceIdeation}`);
      return "continue";
    }

    case "doomloop": {
      const doomLoop = ctx.orchestrator.getDoomLoop();
      const subCmd = args[0];

      if (subCmd === "on" || subCmd === "enable" || subCmd === "true") {
        doomLoop.enable();
        r.info("✓ doom loop detection enabled");
      } else if (subCmd === "off" || subCmd === "disable" || subCmd === "false") {
        doomLoop.disable();
        r.info("✓ doom loop detection disabled");
      } else if (subCmd === "status" || !subCmd) {
        const enabled = doomLoop.isEnabled();
        const status = enabled ? "\x1b[32menabled\x1b[0m" : "\x1b[90mdisabled\x1b[0m";
        r.info(`doom loop detection: ${status}`);
      } else {
        r.error("usage: /doomloop [on|off|enable|disable|true|false|status]");
      }
      return "continue";
    }

    case "github": {
      const gh = ctx.orchestrator.getGitHub();
      const sub = args[0];
      if (sub === "branch") {
        const name = args[1];
        if (!name) { r.error("usage: /github branch <name>"); return "continue"; }
        try {
          await gh.createBranch(name);
          r.info(`✓ branch created: ${name}`);
        } catch (e) { r.error((e as Error).message); }
        return "continue";
      }
      if (sub === "pr") {
        const title = args.slice(1).join(" ");
        if (!title) { r.error("usage: /github pr <title>"); return "continue"; }
        try {
          const url = await gh.createPR(title, "");
          r.info(`✓ PR created: ${url}`);
        } catch (e) { r.error((e as Error).message); }
        return "continue";
      }
      if (sub === "issue") {
        const url = args[1];
        if (!url) { r.error("usage: /github issue <url-or-number>"); return "continue"; }
        try {
          const info = await gh.parseIssue(url);
    
          r.info(`\x1b[1m#${info.number}\x1b[0m ${info.title}`);
          r.info(`\x1b[2m${info.body.slice(0, 200)}\x1b[0m`);
    
        } catch (e) { r.error((e as Error).message); }
        return "continue";
      }
      r.info("usage: /github [branch|pr|issue] ...");
      return "continue";
    }

    case "benchmark": {
      const sub = args[0];

      if (!sub) {
        // /benchmark — show benchmark info
  
        r.info("\x1b[1mBenchmark Runner\x1b[0m");
        r.info(`  tasks: \x1b[1m${BENCHMARK_TASKS.length}\x1b[0m across ${new Set(BENCHMARK_TASKS.map(t => t.category)).size} categories`);
        r.info(`  categories: \x1b[2m${[...new Set(BENCHMARK_TASKS.map(t => t.category))].join(", ")}\x1b[0m`);
        r.info(`  difficulty: \x1b[2measy (${getTasksByDifficulty("easy").length}), medium (${getTasksByDifficulty("medium").length}), hard (${getTasksByDifficulty("hard").length})\x1b[0m`);
  
        r.info("\x1b[2musage:\x1b[0m");
        r.info("  \x1b[1m/benchmark run\x1b[0m              \x1b[2mrun full suite (all providers)\x1b[0m");
        r.info("  \x1b[1m/benchmark run <provider>\x1b[0m   \x1b[2mrun for one provider\x1b[0m");
        r.info("  \x1b[1m/benchmark report\x1b[0m           \x1b[2mgenerate/show last report\x1b[0m");
        r.info("  \x1b[1m/benchmark tasks\x1b[0m            \x1b[2mlist benchmark tasks\x1b[0m");
        r.info("  \x1b[1m/benchmark cost\x1b[0m             \x1b[2mestimate cost for full run\x1b[0m");
  
        return "continue";
      }

      if (sub === "tasks") {
  
        const categories = [...new Set(BENCHMARK_TASKS.map(t => t.category))];
        for (const cat of categories) {
          r.info(`\x1b[1m${cat.charAt(0).toUpperCase() + cat.slice(1)}\x1b[0m`);
          const tasks = getTasksByCategory(cat);
          for (const task of tasks) {
            const diffColor = task.difficulty === "easy" ? "\x1b[32m" : task.difficulty === "medium" ? "\x1b[33m" : "\x1b[31m";
            r.info(`  ${diffColor}${task.difficulty.padEnd(6)}\x1b[0m ${task.name} \x1b[2m(${task.id})\x1b[0m`);
            r.info(`         \x1b[2mtimeout: ${task.timeoutMs / 1000}s, budget: $${task.maxCostUsd.toFixed(2)}\x1b[0m`);
          }
        }
  
        return "continue";
      }

      if (sub === "cost") {
        const provider = args[1];
        const providers = provider
          ? [provider]
          : ["claude", "codex", "gemini", "kiro"];

        const estimate = estimateBenchmarkCost(
          BENCHMARK_TASKS.length,
          providers,
          true, // harnessComparison
        );

  
        r.info("\x1b[1mBenchmark Cost Estimate\x1b[0m");
        r.info(`  total runs: \x1b[1m${estimate.runCount}\x1b[0m (${BENCHMARK_TASKS.length} tasks x ${providers.length} providers x 2 harness modes)`);
        r.info(`  estimated cost: \x1b[1m$${estimate.totalEstimate.toFixed(3)}\x1b[0m`);
  
        for (const [prov, cost] of Object.entries(estimate.perProvider)) {
          r.info(`  ${prov.padEnd(10)} $${cost.toFixed(3)}`);
        }
  
        return "continue";
      }

      if (sub === "run") {
        const providerArg = args[1];
        const providers = providerArg
          ? [providerArg]
          : ["claude", "codex", "gemini", "kiro"];

        // Validate providers
        const validProviders = ["claude", "codex", "gemini", "kiro"];
        for (const p of providers) {
          if (!validProviders.includes(p)) {
            r.error(`unknown provider: ${p} (valid: ${validProviders.join(", ")})`);
            return "continue";
          }
        }

        const runner = new BenchmarkRunner({
          providers,
          harnessComparison: true,
          parallel: false,
          timeoutMs: 600_000,
          maxCostUsd: 5.0,
          evaluator: "auto",
        });

        r.info(`\x1b[1mstarting benchmark\x1b[0m: ${BENCHMARK_TASKS.length} tasks, ${providers.length} providers`);
        r.info("\x1b[2mthis may take a while...\x1b[0m");

        try {
          const runs = await runner.runAll(BENCHMARK_TASKS);

          const reportGen = new ReportGenerator();
          const report = reportGen.generate(BENCHMARK_TASKS, runs);

          // Save report to file
          const reportPath = `${process.cwd()}/benchmark-report-${new Date().toISOString().split("T")[0]}.md`;
          await Bun.write(reportPath, report);

          // Store for /benchmark report
          (ctx.orchestrator as any).__lastBenchmarkReport = report;
          (ctx.orchestrator as any).__lastBenchmarkRuns = runs;

    
          r.info(`\x1b[32m\u2713\x1b[0m benchmark complete: ${runs.length} runs`);
          r.info(`  total cost: \x1b[1m$${runner.getTotalCost().toFixed(4)}\x1b[0m`);
          r.info(`  report saved: \x1b[2m${reportPath}\x1b[0m`);

          const completed = runs.filter(r => r.status === "completed").length;
          const failed = runs.filter(r => r.status === "failed").length;
          const timeout = runs.filter(r => r.status === "timeout").length;
          const budgetExceeded = runs.filter(r => r.status === "budget_exceeded").length;

          r.info(`  completed: ${completed}, failed: ${failed}, timeout: ${timeout}, budget_exceeded: ${budgetExceeded}`);
    
        } catch (e) {
          r.error(`benchmark failed: ${(e as Error).message}`);
        }

        return "continue";
      }

      if (sub === "report") {
        const lastReport = (ctx.orchestrator as any).__lastBenchmarkReport as string | undefined;
        if (!lastReport) {
          r.info("no benchmark report available — run /benchmark run first");
          return "continue";
        }

  
        // Print report lines (strip markdown headers for terminal readability)
        for (const line of lastReport.split("\n")) {
          if (line.startsWith("# ")) {
            r.info(`\x1b[1m${line.slice(2)}\x1b[0m`);
          } else if (line.startsWith("## ")) {
            r.info(`\x1b[1m\x1b[36m${line.slice(3)}\x1b[0m`);
          } else if (line.startsWith("### ")) {
            r.info(`\x1b[1m${line.slice(4)}\x1b[0m`);
          } else if (line.startsWith("---")) {
            r.separator();
          } else if (line.startsWith("|")) {
            r.info(`\x1b[2m${line}\x1b[0m`);
          } else if (line.trim()) {
            r.info(line);
          }
        }
  
        return "continue";
      }

      r.error("usage: /benchmark [run|report|tasks|cost]");
      return "continue";
    }

    case "optimize": {
      // /optimize <test-cmd> <metric-regex> <target> <file> [options]
      // Example: /optimize "python tests/submission_tests.py" "CYCLES:\s+(\d+)" 1487 perf_takehome.py
      if (args.length < 4) {
        r.info("\x1b[1mUsage:\x1b[0m /optimize <test-cmd> <metric-regex> <target> <file> [--rounds N] [--paths N] [--iters N] [--model tier]");
        r.info("\x1b[2mExample: /optimize \"python tests/submission_tests.py\" \"CYCLES:\\s+(\\d+)\" 1487 perf_takehome.py\x1b[0m");
        r.info("\x1b[2mStarts iterative optimization: edit→test→measure→feedback loop with parallel exploration\x1b[0m");
        return "continue";
      }
      // Store args for the REPL to pick up — actual execution happens in repl.ts
      (ctx as any).__optimizeArgs = args;
      return "continue";
    }

    case "scan": {
      const scanner = ctx.orchestrator.getCodebaseScanner();
      const force = args.includes("--force") || args.includes("-f");

      if (force || !scanner.getScanResult()) {
        const result = scanner.scan();
        r.info(`Scanned: ${result.totalFiles} files, ${result.modules.length} modules`);
        r.info(scanner.formatForPrompt(result));
      } else {
        const result = scanner.getScanResult()!;
        const age = Date.now() - new Date(result.scannedAt).getTime();
        const ageMin = Math.round(age / 60_000);
        r.info(`Cached scan (${ageMin}m ago): ${result.totalFiles} files, ${result.modules.length} modules`);
        r.info(scanner.formatForPrompt(result));
        r.info("\x1b[2muse /scan --force to re-scan\x1b[0m");
      }
      return "continue";
    }

    case "providers": {
      const config = ctx.orchestrator.getConfig();
      const supervisor = ctx.orchestrator.getSupervisor();
      const current = supervisor.getPreferredProviders();
      const all = Object.keys(config.providers);

      if (args.length === 0) {
        r.info("\x1b[1mpreferred providers\x1b[0m");
        for (const p of all) {
          const active = current.includes(p as any);
          const icon = active ? "\x1b[32m●\x1b[0m" : "\x1b[90m○\x1b[0m";
          r.info(`  ${icon} ${p}`);
        }
        r.info(`\x1b[2muse /providers set <name,...> to change\x1b[0m`);
        return "continue";
      }

      if (args[0] === "set" && args[1]) {
        const names = args[1] === "default"
          ? [...all]
          : args[1].split(",").map(s => s.trim()).filter(Boolean);
        const invalid = names.filter(n => !all.includes(n));
        if (invalid.length > 0) {
          r.error(`unknown provider: ${invalid.join(", ")} (available: ${all.join(", ")})`);
          return "continue";
        }
        if (!config.supervisor) {
          (config as any).supervisor = { preferredProviders: names };
        } else {
          config.supervisor.preferredProviders = names as any;
        }
        supervisor.setPreferredProviders(names as any);
        r.info(`\x1b[32m✓\x1b[0m providers → ${names.join(", ")}`);
        return "continue";
      }

      r.info("usage: /providers            list providers");
      r.info("       /providers set <p,...> set preferred (e.g. /providers set claude)");
      return "continue";
    }

    case "help": {

      r.info("\x1b[1m/status\x1b[0m\x1b[2m              agent statuses");
      r.info("\x1b[1m/stop\x1b[0m \x1b[2m<agent>        stop a running agent");
      r.info("\x1b[1m/spawn\x1b[0m \x1b[2m<agent>       spawn an agent");
      r.info("\x1b[1m/task\x1b[0m \x1b[2m<agent> <msg>   assign task to agent");
      r.info("\x1b[1m/budget\x1b[0m\x1b[2m              budget usage");
      r.info("\x1b[1m/trace\x1b[0m\x1b[2m               show recent traces (last 10)");
      r.info("\x1b[1m/trace\x1b[0m \x1b[2m<id>          show full trace timeline");
      r.info("\x1b[1m/trace active\x1b[0m\x1b[2m        show currently active spans");
      r.info("\x1b[1m/trace search\x1b[0m \x1b[2m<q>    search traces by operation name");
      r.info("\x1b[1m/trace slow\x1b[0m\x1b[2m          show slowest traces (by duration)");
      r.info("\x1b[1m/agents\x1b[0m\x1b[2m              agent profiles & health");
      r.info("\x1b[1m/agents select\x1b[0m \x1b[2m<name> pin to a specific agent");
      r.info("\x1b[1m/agents auto\x1b[0m\x1b[2m         restore auto routing");
      r.info("\x1b[1m/messages\x1b[0m \x1b[2m<agent>    message history");
      r.info("\x1b[1m/ownership\x1b[0m\x1b[2m           file ownership map");
      r.info("\x1b[1m/mcp\x1b[0m\x1b[2m                 MCP server status");
      r.info("\x1b[1m/mcp tools\x1b[0m\x1b[2m           list MCP tools");
      r.info("\x1b[1m/mcp connect\x1b[0m \x1b[2m<name>   connect catalog server");
      r.info("\x1b[1m/mcp disconnect\x1b[0m \x1b[2m<n>  disconnect server");
      r.info("\x1b[1m/plan\x1b[0m\x1b[2m                toggle plan mode (read-only)");
      r.info("\x1b[1m/plan list\x1b[0m\x1b[2m           list saved plans");
      r.info("\x1b[1m/plan save\x1b[0m \x1b[2m<title>   save current plan");
      r.info("\x1b[1m/fork\x1b[0m\x1b[2m                fork conversation at current point");
      r.info("\x1b[1m/fork list\x1b[0m\x1b[2m           list branches");
      r.info("\x1b[1m/fork tree\x1b[0m\x1b[2m           show branch tree");
      r.info("\x1b[1m/fork switch\x1b[0m \x1b[2m<name>  switch to branch");
      r.info("\x1b[1m/lsp\x1b[0m\x1b[2m                 active LSP servers");
      r.info("\x1b[1m/lsp diagnostics\x1b[0m \x1b[2m<f> file diagnostics");
      r.info("\x1b[1m/lsp symbols\x1b[0m \x1b[2m<file>   document symbols");
      r.info("\x1b[1m/pause\x1b[0m\x1b[2m               save session snapshot");
      r.info("\x1b[1m/resume\x1b[0m\x1b[2m              restore last session");
      r.info("\x1b[1m/sessions\x1b[0m\x1b[2m            saved session list");
      r.info("\x1b[1m/memory\x1b[0m\x1b[2m              persistent memory");
      r.info("\x1b[1m/permissions\x1b[0m\x1b[2m         show permission rules");
      r.info("\x1b[1m/undo\x1b[0m\x1b[2m                revert to previous snapshot");
      r.info("\x1b[1m/redo\x1b[0m\x1b[2m                restore undone snapshot");
      r.info("\x1b[1m/theme\x1b[0m \x1b[2m<name>         switch color theme");
      r.info("\x1b[1m/theme list\x1b[0m\x1b[2m          available themes");
      r.info("\x1b[1m/theme preview\x1b[0m\x1b[2m       preview current theme colors");
      r.info("\x1b[1m/models\x1b[0m\x1b[2m              model registry & pricing");
      r.info("\x1b[1m/models\x1b[0m \x1b[2m<name>        model details");
      r.info("\x1b[1m/plugins\x1b[0m\x1b[2m             loaded plugins");
      r.info("\x1b[1m/plugins reload\x1b[0m\x1b[2m      reload plugins");
      r.info("\x1b[1m/share\x1b[0m \x1b[2m<title>        export session as markdown");
      r.info("\x1b[1m/share list\x1b[0m\x1b[2m          list shared sessions");
      r.info("\x1b[1m/share import\x1b[0m \x1b[2m<file>  import shared session");
      r.info("\x1b[1m/ast search\x1b[0m \x1b[2m<pattern> structural code search");
      r.info("\x1b[1m/ast replace\x1b[0m \x1b[2m<p> <r>  structural code replace");
      r.info("\x1b[1m/pipeline\x1b[0m \x1b[2m<task>      run plan→review→validate pipeline");
      r.info("\x1b[1m/boulder\x1b[0m\x1b[2m             active boulders (WIP tasks)");
      r.info("\x1b[1m/boulder resume\x1b[0m \x1b[2m<id>  resume a boulder");
      r.info("\x1b[1m/boulder pause\x1b[0m \x1b[2m<id>   pause a boulder");
      r.info("\x1b[1m/notepad\x1b[0m\x1b[2m             list notepads");
      r.info("\x1b[1m/notepad add\x1b[0m \x1b[2m<name>    create new notepad");
      r.info("\x1b[1m/notepad search\x1b[0m \x1b[2m<q>  search notepad entries");
      r.info("\x1b[1m/oauth authorize\x1b[0m \x1b[2m<s>  OAuth flow for MCP server");
      r.info("\x1b[1m/oauth status\x1b[0m \x1b[2m<s>    check OAuth token status");
      r.info("\x1b[1m/category\x1b[0m\x1b[2m            list task categories");
      r.info("\x1b[1m/category classify\x1b[0m \x1b[2m<p> classify a prompt");
      r.info("\x1b[1m/diff\x1b[0m\x1b[2m                show changes since session start");
      r.info("\x1b[1m/compact\x1b[0m\x1b[2m             compress conversation history");
      r.info("\x1b[1m/trust\x1b[0m\x1b[2m               trust project config dir");
      r.info("\x1b[1m/consolidate\x1b[0m\x1b[2m         consolidate memories from sessions");
      r.info("\x1b[1m/checkpoint\x1b[0m\x1b[2m          create a git checkpoint");
      r.info("\x1b[1m/checkpoint list\x1b[0m\x1b[2m     list checkpoints");
      r.info("\x1b[1m/checkpoint rollback\x1b[0m\x1b[2m rollback to latest");
      r.info("\x1b[1m/spec\x1b[0m \x1b[2m<task>          generate structured spec pipeline");
      r.info("\x1b[1m/ideate\x1b[0m \x1b[2m<context>      brainstorm improvements across dimensions");
      r.info("\x1b[1m/doctor\x1b[0m\x1b[2m              run system diagnostics");
      r.info("\x1b[1m/stats\x1b[0m\x1b[2m               session statistics");
      r.info("\x1b[1m/worktree\x1b[0m\x1b[2m            manage git worktrees");
      r.info("\x1b[1m/worktree create\x1b[0m \x1b[2m<b> create worktree for branch");
      r.info("\x1b[1m/worktree remove\x1b[0m \x1b[2m<p> remove worktree");
      r.info("\x1b[1m/worktree cleanup\x1b[0m\x1b[2m    remove all worktrees");
      r.info("\x1b[1m/background\x1b[0m\x1b[2m          list background tasks");
      r.info("\x1b[1m/background cancel\x1b[0m \x1b[2m<id> cancel a background task");
      r.info("\x1b[1m/background result\x1b[0m \x1b[2m<id> get task result");
      r.info("\x1b[1m/stash\x1b[0m\x1b[2m               prompt stash (push/pop/list)");
      r.info("\x1b[1m/question\x1b[0m\x1b[2m            agent question info");
      r.info("\x1b[1m/search\x1b[0m \x1b[2m<query>       search (Exa then web fallback)");
      r.info("\x1b[1m/search web\x1b[0m \x1b[2m<query>   web search (DuckDuckGo/Exa)");
      r.info("\x1b[1m/search code\x1b[0m \x1b[2m<query>  remote code search (grep.app)");
      r.info("\x1b[1m/search local\x1b[0m \x1b[2m<query> local ripgrep search");
      r.info("\x1b[1m/tasks\x1b[0m\x1b[2m               list persistent tasks");
      r.info("\x1b[1m/tasks create\x1b[0m \x1b[2m<subj>  create a task");
      r.info("\x1b[1m/tasks done\x1b[0m \x1b[2m<id>      mark task completed");
      r.info("\x1b[1m/handoff\x1b[0m\x1b[2m             generate session handoff document");
      r.info("\x1b[1m/refactor\x1b[0m \x1b[2m<goal>      run automated refactor");
      r.info("\x1b[1m/variants\x1b[0m\x1b[2m            list model variants");
      r.info("\x1b[1m/variants set\x1b[0m \x1b[2m<name>  set model variant");
      r.info("\x1b[1m/fastwork\x1b[0m\x1b[2m            show fastwork mode config");
      r.info("\x1b[1m/ultrathink\x1b[0m\x1b[2m          show ultrathink mode config");
      r.info("\x1b[1m/doomloop\x1b[0m\x1b[2m            toggle doom loop detection (on|off|status)");
      r.info("\x1b[1m/github branch\x1b[0m \x1b[2m<name> create branch");
      r.info("\x1b[1m/github pr\x1b[0m \x1b[2m<title>    create pull request");
      r.info("\x1b[1m/github issue\x1b[0m \x1b[2m<url>   view issue details");
      r.info("\x1b[1m/queue\x1b[0m\x1b[2m               show running + queued tasks with priorities");
      r.info("\x1b[1m/queue priority\x1b[0m \x1b[2m<id> <level> change task priority");
      r.info("\x1b[1m/queue promote\x1b[0m \x1b[2m<id>  promote one priority level");
      r.info("\x1b[1m/queue demote\x1b[0m \x1b[2m<id>   demote one priority level");
      r.info("\x1b[1m/queue force\x1b[0m \x1b[2m<id>    force-execute immediately");
      r.info("\x1b[1m/queue cancel\x1b[0m \x1b[2m<id>   cancel queued task");
      r.info("\x1b[1m/cancel\x1b[0m \x1b[2m<worker-id>    cancel a specific running worker");
      r.info("\x1b[1m/cancel all\x1b[0m\x1b[2m          cancel all running workers");
      r.info("\x1b[1m/cancel queue\x1b[0m \x1b[2m<id>   remove task from scheduler queue");
      r.info("\x1b[1m/dlq\x1b[0m\x1b[2m                 DLQ summary (pending count, top errors)");
      r.info("\x1b[1m/dlq list\x1b[0m\x1b[2m            list all pending dead letters");
      r.info("\x1b[1m/dlq show\x1b[0m \x1b[2m<id>        show full details of a dead letter");
      r.info("\x1b[1m/dlq retry\x1b[0m \x1b[2m<id>       re-execute a dead letter (with error context)");
      r.info("\x1b[1m/dlq discard\x1b[0m \x1b[2m<id>     discard a dead letter");
      r.info("\x1b[1m/dlq stats\x1b[0m\x1b[2m           show DLQ statistics");
      r.info("\x1b[1m/dlq clear\x1b[0m\x1b[2m           discard all resolved/discarded entries");
      r.info("\x1b[1m/enforce\x1b[0m\x1b[2m             harness enforcer status");
      r.info("\x1b[1m/enforce on|off\x1b[0m\x1b[2m      enable/disable enforcement");
      r.info("\x1b[1m/enforce violations\x1b[0m\x1b[2m  show recorded violations");
      r.info("\x1b[1m/enforce report\x1b[0m\x1b[2m      violation summary report");
      r.info("\x1b[1m/enforce reset\x1b[0m\x1b[2m       reset enforcer state");
      r.info("\x1b[1m/benchmark\x1b[0m\x1b[2m           benchmark runner info");
      r.info("\x1b[1m/benchmark run\x1b[0m\x1b[2m       run full benchmark suite (all providers)");
      r.info("\x1b[1m/benchmark run\x1b[0m \x1b[2m<p>  run benchmarks for one provider");
      r.info("\x1b[1m/benchmark report\x1b[0m\x1b[2m    generate/show last report");
      r.info("\x1b[1m/benchmark tasks\x1b[0m\x1b[2m     list available benchmark tasks");
      r.info("\x1b[1m/benchmark cost\x1b[0m\x1b[2m      estimate cost for full run");
      r.info("\x1b[1m/providers\x1b[0m\x1b[2m           show preferred providers");
      r.info("\x1b[1m/providers set\x1b[0m \x1b[2m<p,...> set preferred (e.g. /providers set claude)");
      r.info("\x1b[1m/scan\x1b[0m\x1b[2m                show codebase analysis");
      r.info("\x1b[1m/scan --force\x1b[0m\x1b[2m        re-scan codebase");
      r.info("\x1b[1m/clear\x1b[0m\x1b[2m               clear conversation");
      r.info("\x1b[1m/lang\x1b[0m \x1b[2m<language>      set response language");
      r.info("\x1b[1m/help\x1b[0m\x1b[2m                this help");
      r.info("\x1b[1m/quit\x1b[0m\x1b[2m                exit");

      return "continue";
    }

    case "quit":
    case "exit":
    case "q": {
      return "quit";
    }

    case "": {
      // bare "/" — show available commands

      r.info(`\x1b[2m${COMMANDS.join("  ")}\x1b[0m`);

      return "continue";
    }

    default: {
      r.error(`unknown command: /${cmd}`);
      return "continue";
    }
  }
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function formatTimeAgo(isoTimestamp: string): string {
  const diffMs = Date.now() - new Date(isoTimestamp).getTime();
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function findTaskById(
  scheduler: import("../core/scheduler.ts").PriorityScheduler,
  partialId: string,
): string | null {
  // Check queued tasks
  const queued = scheduler.getQueueSnapshot();
  const match = queued.find(
    (q) => q.taskId === partialId || q.taskId.startsWith(partialId),
  );
  if (match) return match.taskId;

  // Check running tasks
  const running = scheduler.getRunningSnapshot();
  const runMatch = running.find(
    (r) => r.taskId === partialId || r.taskId.startsWith(partialId),
  );
  if (runMatch) return runMatch.taskId;

  return null;
}
