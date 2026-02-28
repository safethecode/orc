import type { Orchestrator } from "../core/orchestrator.ts";
import type { Conversation } from "./conversation.ts";
import { diffFromGhost } from "../utils/ghost-commit.ts";
import { loadExecPolicy, trustProject, isProjectTrusted } from "../sandbox/rules.ts";
import { getCatalogEntry } from "../mcp/catalog.ts";
import * as renderer from "./renderer.ts";

export const COMMANDS = [
  "/status", "/stop", "/clear", "/lang",
  "/budget", "/trace", "/agents", "/messages",
  "/ownership", "/spawn", "/task", "/mcp",
  "/pause", "/resume", "/sessions", "/memory",
  "/diff", "/compact", "/trust", "/consolidate",
  "/help", "/quit",
];

export const LANGUAGES = [
  "korean", "english", "japanese", "chinese",
  "spanish", "french", "german", "portuguese",
  "russian", "arabic", "italian", "dutch",
];

export interface CommandContext {
  orchestrator: Orchestrator;
  conversation: Conversation;
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
      const before = ctx.conversation.length;
      const summary = ctx.conversation.generateSummary();
      ctx.conversation.clear();
      ctx.conversation.add({
        role: "assistant",
        content: `[Compacted ${before} turns. Summary: ${summary}]`,
        timestamp: new Date().toISOString(),
      });
      renderer.info(`\u2713 compacted ${before} turns`);
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
      renderer.info("\x1b[1m/pause\x1b[0m\x1b[2m               save session snapshot");
      renderer.info("\x1b[1m/resume\x1b[0m\x1b[2m              restore last session");
      renderer.info("\x1b[1m/sessions\x1b[0m\x1b[2m            saved session list");
      renderer.info("\x1b[1m/memory\x1b[0m\x1b[2m              persistent memory");
      renderer.info("\x1b[1m/diff\x1b[0m\x1b[2m                show changes since session start");
      renderer.info("\x1b[1m/compact\x1b[0m\x1b[2m             compress conversation history");
      renderer.info("\x1b[1m/trust\x1b[0m\x1b[2m               trust project config dir");
      renderer.info("\x1b[1m/consolidate\x1b[0m\x1b[2m         consolidate memories from sessions");
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
