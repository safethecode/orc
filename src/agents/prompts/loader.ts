import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { ProviderName } from "../../config/types.ts";

const PROMPTS_DIR = new URL(".", import.meta.url).pathname;
const USER_PROMPTS_DIR = join(homedir(), ".orchestrator", "prompts");

/** Map provider names to prompt file names when they differ */
const FILE_NAME_MAP: Partial<Record<ProviderName, string>> = {
  claude: "anthropic",
};

const cache = new Map<string, string>();

export function loadProviderPrompt(provider: ProviderName): string {
  const key = provider;
  if (cache.has(key)) return cache.get(key)!;

  const fileName = FILE_NAME_MAP[provider] ?? provider;

  // Check user override first
  const userPath = join(USER_PROMPTS_DIR, `${fileName}.md`);
  if (existsSync(userPath)) {
    const content = readFileSync(userPath, "utf-8");
    cache.set(key, content);
    return content;
  }

  // Built-in prompt
  const builtinPath = join(PROMPTS_DIR, `${fileName}.md`);
  if (existsSync(builtinPath)) {
    const content = readFileSync(builtinPath, "utf-8");
    cache.set(key, content);
    return content;
  }

  return "";
}

export function clearPromptCache(): void {
  cache.clear();
}
