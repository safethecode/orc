import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentProfile } from "../config/types.ts";

// ── Role → Skill auto-mapping ──────────────────────────────────────────
// Keys match profile `name` or fall back to keyword matching on `role`.
// Explicit `skills:` in frontmatter merges on top (deduped).

const ROLE_SKILL_MAP: Record<string, string[]> = {
  coder: [
    "frontend-design",
    "webapp-testing",
    "vercel-react-best-practices",
    "vercel-composition-patterns",
    "mcp-builder",
  ],
  architect: [
    "mcp-builder",
    "vercel-composition-patterns",
    "web-design-guidelines",
    "doc-coauthoring",
  ],
  reviewer: [
    "web-design-guidelines",
    "vercel-react-best-practices",
    "webapp-testing",
  ],
  researcher: [
    "doc-coauthoring",
    "web-design-guidelines",
  ],
  rapid: [],
};

// Fallback keyword → key mapping for custom profiles
const ROLE_KEYWORDS: [RegExp, string][] = [
  [/engineer|coder|developer/i, "coder"],
  [/architect/i, "architect"],
  [/review/i, "reviewer"],
  [/research|analyst/i, "researcher"],
  [/quick|rapid|fast/i, "rapid"],
];

export function skillsForRole(name: string, role: string): string[] {
  // Direct name match first
  if (name in ROLE_SKILL_MAP) return ROLE_SKILL_MAP[name];

  // Keyword match on role string
  for (const [pattern, key] of ROLE_KEYWORDS) {
    if (pattern.test(role)) return ROLE_SKILL_MAP[key];
  }

  return [];
}

// ── Registry ────────────────────────────────────────────────────────────

export class AgentRegistry {
  private agents: Map<string, AgentProfile> = new Map();

  constructor() {}

  async loadProfiles(profileDir: string, skillSearchDirs?: string[]): Promise<void> {
    const entries = await readdir(profileDir);
    const mdFiles = entries.filter((f) => f.endsWith(".md"));

    for (const file of mdFiles) {
      const content = await readFile(join(profileDir, file), "utf-8");
      const profile = parseProfile(content);

      if (skillSearchDirs) {
        // Merge: role-based auto-skills + explicit frontmatter skills (deduped)
        const autoSkills = skillsForRole(profile.name, profile.role);
        const explicit = profile.skills ?? [];
        const merged = [...new Set([...autoSkills, ...explicit])];

        if (merged.length > 0) {
          const skillBodies = await resolveSkills(merged, skillSearchDirs);
          if (skillBodies.length > 0) {
            profile.systemPrompt += "\n\n" + skillBodies.join("\n\n");
          }
        }
        profile.skills = merged;
      }

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
    skills: (frontmatter.skills as string[]) ?? [],
  };
}

export function stripFrontmatter(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n?/);
  if (match) {
    return content.slice(match[0].length).trim();
  }
  return content.trim();
}

export async function resolveSkills(
  skillNames: string[],
  searchDirs: string[],
): Promise<string[]> {
  const results: string[] = [];

  for (const name of skillNames) {
    let found = false;
    for (const dir of searchDirs) {
      const skillPath = join(dir, name, "SKILL.md");
      try {
        const raw = await readFile(skillPath, "utf-8");
        results.push(stripFrontmatter(raw));
        found = true;
        break;
      } catch {
        // not found in this dir, try next
      }
    }
    if (!found) {
      console.warn(`[orc] skill "${name}" not found in any search directory`);
    }
  }

  return results;
}
