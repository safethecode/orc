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
  let config = parseYaml(defaultRaw) as OrchestratorConfig;

  if (overridePath) {
    const resolved = resolvePath(overridePath);
    if (existsSync(resolved)) {
      const overrideRaw = readFileSync(resolved, "utf-8");
      const overrideConfig = parseYaml(overrideRaw) as Partial<OrchestratorConfig>;
      config = deepMerge(config, overrideConfig);
    }
  }

  if (existsSync(USER_CONFIG_PATH)) {
    const userRaw = readFileSync(USER_CONFIG_PATH, "utf-8");
    const userConfig = parseYaml(userRaw) as Partial<OrchestratorConfig>;
    config = deepMerge(config, userConfig);
  }

  // Resolve ~ in path fields
  config.orchestrator.dataDir = resolvePath(config.orchestrator.dataDir);
  config.orchestrator.db = resolvePath(config.orchestrator.db);
  config.orchestrator.logDir = resolvePath(config.orchestrator.logDir);

  return config;
}

export function resolvePath(p: string): string {
  if (p.startsWith("~")) {
    p = p.replace("~", homedir());
  }
  return resolve(p);
}

function deepMerge<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
  const result = { ...target };

  for (const key of Object.keys(source) as (keyof T)[]) {
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
      ) as T[keyof T];
    } else if (srcVal !== undefined) {
      result[key] = srcVal as T[keyof T];
    }
  }

  return result;
}
