import type { ConversationTurn } from "../config/types.ts";
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

export interface SharedSession {
  id: string;
  title: string;
  turns: ConversationTurn[];
  metadata: {
    createdAt: string;
    turnCount: number;
    models: string[];
    totalCost: number;
  };
}

export interface ShareResult {
  id: string;
  markdown: string;
  filePath: string;
}

export class SessionSharer {
  private shareDir: string;

  constructor(shareDir?: string) {
    this.shareDir = shareDir ?? `${process.env.HOME}/.orchestrator/shared`;
  }

  async share(session: SharedSession): Promise<ShareResult> {
    await this.ensureDir();

    const markdown = this.formatMarkdown(session);
    const fileName = `${session.id}.md`;
    const filePath = join(this.shareDir, fileName);

    await Bun.write(filePath, markdown);

    return { id: session.id, markdown, filePath };
  }

  async import(filePath: string): Promise<SharedSession | null> {
    try {
      const file = Bun.file(filePath);
      const exists = await file.exists();
      if (!exists) return null;

      const markdown = await file.text();
      return this.parseMarkdown(markdown);
    } catch {
      return null;
    }
  }

  async list(): Promise<
    Array<{ id: string; title: string; createdAt: string; filePath: string }>
  > {
    await this.ensureDir();

    const results: Array<{
      id: string;
      title: string;
      createdAt: string;
      filePath: string;
    }> = [];

    let entries: string[];
    try {
      entries = await readdir(this.shareDir);
    } catch {
      return results;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;

      const filePath = join(this.shareDir, entry);
      try {
        const file = Bun.file(filePath);
        const markdown = await file.text();
        const session = this.parseMarkdown(markdown);
        if (session) {
          results.push({
            id: session.id,
            title: session.title,
            createdAt: session.metadata.createdAt,
            filePath,
          });
        }
      } catch {
        // Skip corrupt files
      }
    }

    return results;
  }

  async delete(id: string): Promise<boolean> {
    const filePath = join(this.shareDir, `${id}.md`);
    try {
      const file = Bun.file(filePath);
      const exists = await file.exists();
      if (!exists) return false;

      await unlink(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private formatMarkdown(session: SharedSession): string {
    const lines: string[] = [];

    // Header with metadata as HTML comment for round-trip parsing
    lines.push(`<!-- orc-session`);
    lines.push(`id: ${session.id}`);
    lines.push(`created: ${session.metadata.createdAt}`);
    lines.push(`turns: ${session.metadata.turnCount}`);
    lines.push(`models: ${session.metadata.models.join(", ")}`);
    lines.push(`cost: ${session.metadata.totalCost}`);
    lines.push(`-->`);
    lines.push("");

    // Human-readable header
    lines.push(`# Session: ${session.title}`);
    lines.push(
      `> Created: ${session.metadata.createdAt} | Turns: ${session.metadata.turnCount} | Cost: $${session.metadata.totalCost.toFixed(4)}`,
    );
    lines.push("");

    // Conversation turns
    for (const turn of session.turns) {
      lines.push("---");
      lines.push("");

      if (turn.role === "user") {
        lines.push(`**User:** ${turn.content}`);
      } else {
        const modelInfo = turn.agentName
          ? turn.agentName
          : turn.tier ?? "assistant";
        lines.push(`**Assistant (${modelInfo}):** ${turn.content}`);
      }

      lines.push("");
    }

    lines.push("---");
    return lines.join("\n");
  }

  private parseMarkdown(markdown: string): SharedSession | null {
    // Extract metadata from the HTML comment block
    const metaMatch = markdown.match(
      /<!-- orc-session\n([\s\S]*?)\n-->/,
    );
    if (!metaMatch) return null;

    const metaBlock = metaMatch[1];
    const metaLines = metaBlock.split("\n");
    const meta: Record<string, string> = {};
    for (const line of metaLines) {
      const colonIdx = line.indexOf(": ");
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 2).trim();
      meta[key] = value;
    }

    if (!meta.id) return null;

    // Extract title from the markdown heading
    const titleMatch = markdown.match(/^# Session: (.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : "Untitled";

    // Parse conversation turns from the sections between --- separators
    const turns: ConversationTurn[] = [];

    // Split by --- separator lines, filtering empty sections
    const sections = markdown.split(/\n---\n/).filter((s) => s.trim());

    for (const section of sections) {
      const trimmed = section.trim();

      // User turn
      const userMatch = trimmed.match(/^\*\*User:\*\*\s*([\s\S]+)$/m);
      if (userMatch) {
        turns.push({
          role: "user",
          content: userMatch[1].trim(),
          timestamp: meta.created ?? new Date().toISOString(),
        });
        continue;
      }

      // Assistant turn
      const assistantMatch = trimmed.match(
        /^\*\*Assistant \(([^)]+)\):\*\*\s*([\s\S]+)$/m,
      );
      if (assistantMatch) {
        turns.push({
          role: "assistant",
          content: assistantMatch[2].trim(),
          agentName: assistantMatch[1],
          timestamp: meta.created ?? new Date().toISOString(),
        });
      }
    }

    return {
      id: meta.id,
      title,
      turns,
      metadata: {
        createdAt: meta.created ?? new Date().toISOString(),
        turnCount: parseInt(meta.turns ?? "0", 10) || turns.length,
        models: meta.models ? meta.models.split(", ").filter(Boolean) : [],
        totalCost: parseFloat(meta.cost ?? "0") || 0,
      },
    };
  }

  private async ensureDir(): Promise<void> {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(this.shareDir, { recursive: true });
  }
}
