import { parse as parseYaml } from "yaml";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";
import type { OrchestratorConfig } from "./types.ts";

const DEFAULT_CONFIG_PATH = new URL("../../config/default.yml", import.meta.url).pathname;
const USER_CONFIG_PATH = resolve(homedir(), ".orchestrator", "config.yml");

export function loadConfig(overridePath?: string): OrchestratorConfig {
  if (!existsSync(DEFAULT_CONFIG_PATH)) {
    throw new Error(`Default config not found: ${DEFAULT_CONFIG_PATH}`);
  }

  const defaultRaw = readFileSync(DEFAULT_CONFIG_PATH, "utf-8");
  let config = parseYaml(defaultRaw) as Record<string, unknown>;

  if (overridePath) {
    const resolved = resolvePath(overridePath);
    if (existsSync(resolved)) {
      const overrideRaw = readFileSync(resolved, "utf-8");
      const overrideConfig = parseYaml(overrideRaw) as Record<string, unknown>;
      config = deepMerge(config, overrideConfig);
    }
  }

  if (existsSync(USER_CONFIG_PATH)) {
    const userRaw = readFileSync(USER_CONFIG_PATH, "utf-8");
    const userConfig = parseYaml(userRaw) as Record<string, unknown>;
    config = deepMerge(config, userConfig);
  }

  const typed = config as unknown as OrchestratorConfig;

  // Resolve ~ in path fields
  typed.orchestrator.dataDir = resolvePath(typed.orchestrator.dataDir);
  typed.orchestrator.db = resolvePath(typed.orchestrator.db);
  typed.orchestrator.logDir = resolvePath(typed.orchestrator.logDir);

  // Resolve ~ in MCP server command paths
  if (typed.mcp?.servers) {
    for (const server of Object.values(typed.mcp.servers)) {
      if (server.command.startsWith("~")) {
        server.command = resolvePath(server.command);
      }
    }
  }

  return typed;
}

export function resolvePath(p: string): string {
  if (p.startsWith("~")) {
    p = p.replace("~", homedir());
  }
  return resolve(p);
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];

    if (
      srcVal !== null &&
      typeof srcVal === "object" &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === "object" &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>,
      );
    } else if (srcVal !== undefined) {
      result[key] = srcVal;
    }
  }

  return result;
}
