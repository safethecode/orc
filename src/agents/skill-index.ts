import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { stripFrontmatter } from "./registry.ts";

export interface SkillEntry {
  name: string;
  description: string;
  tokens: Set<string>;
  dir: string;
}

const STOP_WORDS = new Set([
  "the","a","an","is","are","to","for","of","in","on","and","or",
  "this","that","with","you","your","when","use","should","be","do",
  "not","it","any","all","can","from","as","by","if","how","what",
  "will","also","may","has","have","its","but","about","into","more",
  "like","other","such","than","these","those","each","which","their",
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9가-힣\s-]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w))
  );
}

export class SkillIndex {
  private entries: SkillEntry[] = [];

  async scan(searchDirs: string[]): Promise<void> {
    const seen = new Set<string>();
    for (const dir of searchDirs) {
      let names: string[];
      try { names = await readdir(dir); } catch { continue; }
      for (const name of names) {
        if (seen.has(name)) continue;
        const skillPath = join(dir, name, "SKILL.md");
        try {
          const raw = await readFile(skillPath, "utf-8");
          const fm = this.parseFrontmatter(raw);
          if (!fm.name) continue;
          seen.add(name);
          this.entries.push({
            name: fm.name,
            description: fm.description ?? "",
            tokens: tokenize(fm.description ?? name),
            dir: join(dir, name),
          });
        } catch { /* skip */ }
      }
    }
  }

  match(prompt: string, maxResults = 3): SkillEntry[] {
    const promptTokens = tokenize(prompt);
    const scored = this.entries
      .map(entry => {
        let score = 0;
        for (const t of promptTokens) {
          if (entry.tokens.has(t)) score++;
        }
        return { entry, score };
      })
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, maxResults).map(s => s.entry);
  }

  async resolve(entries: SkillEntry[]): Promise<string[]> {
    const bodies: string[] = [];
    for (const entry of entries) {
      try {
        const raw = await readFile(join(entry.dir, "SKILL.md"), "utf-8");
        bodies.push(stripFrontmatter(raw));
      } catch { /* skip */ }
    }
    return bodies;
  }

  list(): SkillEntry[] { return [...this.entries]; }

  private parseFrontmatter(content: string): Record<string, string> {
    const m = content.match(/^---\n([\s\S]*?)\n---/);
    if (!m) return {};
    try {
      const parsed = parseYaml(m[1]) as Record<string, unknown>;
      return {
        name: String(parsed.name ?? ""),
        description: String(parsed.description ?? ""),
      };
    } catch { return {}; }
  }
}
