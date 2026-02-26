import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentProfile } from "../config/types.ts";

export class AgentRegistry {
  private agents: Map<string, AgentProfile> = new Map();

  constructor() {}

  async loadProfiles(profileDir: string): Promise<void> {
    const entries = await readdir(profileDir);
    const mdFiles = entries.filter((f) => f.endsWith(".md"));

    for (const file of mdFiles) {
      const content = await readFile(join(profileDir, file), "utf-8");
      const profile = parseProfile(content);
      this.register(profile);
    }
  }

  register(profile: AgentProfile): void {
    this.agents.set(profile.name, profile);
  }

  get(name: string): AgentProfile | undefined {
    return this.agents.get(name);
  }

  list(): AgentProfile[] {
    return Array.from(this.agents.values());
  }

  has(name: string): boolean {
    return this.agents.has(name);
  }
}

export function parseProfile(content: string): AgentProfile {
  const parts = content.split("---");
  if (parts.length < 3) {
    throw new Error("Invalid profile: missing YAML frontmatter delimiters");
  }

  const frontmatter = parseYaml(parts[1].trim()) as Record<string, unknown>;
  const systemPrompt = parts.slice(2).join("---").trim();

  return {
    name: frontmatter.name as string,
    provider: frontmatter.provider as string,
    model: frontmatter.model as AgentProfile["model"],
    role: frontmatter.role as string,
    maxBudgetUsd: frontmatter.maxBudgetUsd as number,
    requires: (frontmatter.requires as string[]) ?? [],
    worktree: (frontmatter.worktree as boolean) ?? false,
    systemPrompt,
  };
}
