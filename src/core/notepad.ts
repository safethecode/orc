// ── Notepad: Knowledge Accumulation Across Tasks ─────────────────────
// Accumulates learnings, decisions, issues, and verifications across agent tasks

import { mkdir, readdir, unlink } from "node:fs/promises";

export type NoteCategory = "learning" | "decision" | "issue" | "verification" | "discovery";

export interface Note {
  id: string;
  category: NoteCategory;
  content: string;
  source: string;
  tags: string[];
  createdAt: string;
  relatedFiles?: string[];
}

export interface Notepad {
  id: string;
  name: string;
  notes: Note[];
  createdAt: string;
  lastUpdatedAt: string;
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// Sanitize a notepad name for use as a filename
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
}

export class NotepadManager {
  private notepadDir: string;
  private notepads: Map<string, Notepad> = new Map();

  constructor(projectDir: string) {
    this.notepadDir = `${projectDir}/.orchestrator/notepads`;
  }

  /** Create or get a notepad by name */
  getOrCreate(name: string): Notepad {
    const existing = this.notepads.get(name);
    if (existing) return existing;

    const now = new Date().toISOString();
    const notepad: Notepad = {
      id: generateId("np"),
      name,
      notes: [],
      createdAt: now,
      lastUpdatedAt: now,
    };

    this.notepads.set(name, notepad);
    return notepad;
  }

  /** Add a note to a notepad */
  addNote(
    notepadName: string,
    category: NoteCategory,
    content: string,
    source: string,
    opts?: { tags?: string[]; relatedFiles?: string[] },
  ): Note {
    const notepad = this.getOrCreate(notepadName);

    const note: Note = {
      id: generateId("note"),
      category,
      content,
      source,
      tags: opts?.tags ?? [],
      createdAt: new Date().toISOString(),
    };

    if (opts?.relatedFiles && opts.relatedFiles.length > 0) {
      note.relatedFiles = opts.relatedFiles;
    }

    notepad.notes.push(note);
    notepad.lastUpdatedAt = note.createdAt;

    return note;
  }

  /** Get all notes of a category from a notepad */
  getByCategory(notepadName: string, category: NoteCategory): Note[] {
    const notepad = this.notepads.get(notepadName);
    if (!notepad) return [];
    return notepad.notes.filter((n) => n.category === category);
  }

  /** Search notes across all notepads */
  search(query: string, category?: NoteCategory): Note[] {
    const lowerQuery = query.toLowerCase();
    const results: Note[] = [];

    for (const notepad of this.notepads.values()) {
      for (const note of notepad.notes) {
        if (category && note.category !== category) continue;

        const matchesContent = note.content.toLowerCase().includes(lowerQuery);
        const matchesTags = note.tags.some((t) => t.toLowerCase().includes(lowerQuery));
        const matchesSource = note.source.toLowerCase().includes(lowerQuery);

        if (matchesContent || matchesTags || matchesSource) {
          results.push(note);
        }
      }
    }

    // Sort by recency
    return results.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  /** Get accumulated wisdom for injecting into agent prompt */
  getWisdom(notepadName: string): string {
    const notepad = this.notepads.get(notepadName);
    if (!notepad || notepad.notes.length === 0) return "";

    const grouped: Record<NoteCategory, Note[]> = {
      learning: [],
      decision: [],
      issue: [],
      verification: [],
      discovery: [],
    };

    for (const note of notepad.notes) {
      grouped[note.category].push(note);
    }

    const lines: string[] = ["[Accumulated Knowledge]"];

    if (grouped.learning.length > 0) {
      lines.push("## Learnings");
      for (const note of grouped.learning) {
        lines.push(`- ${note.content}`);
      }
    }

    if (grouped.decision.length > 0) {
      lines.push("## Decisions");
      for (const note of grouped.decision) {
        lines.push(`- ${note.content}`);
      }
    }

    if (grouped.issue.length > 0) {
      lines.push("## Known Issues");
      for (const note of grouped.issue) {
        lines.push(`- ${note.content}`);
      }
    }

    if (grouped.verification.length > 0) {
      lines.push("## Verified");
      for (const note of grouped.verification) {
        lines.push(`- ${note.content}`);
      }
    }

    if (grouped.discovery.length > 0) {
      lines.push("## Discoveries");
      for (const note of grouped.discovery) {
        lines.push(`- ${note.content}`);
      }
    }

    return lines.join("\n");
  }

  /** Save a notepad to disk */
  async save(notepadName: string): Promise<void> {
    const notepad = this.notepads.get(notepadName);
    if (!notepad) return;

    await mkdir(this.notepadDir, { recursive: true });
    const filePath = `${this.notepadDir}/${sanitizeName(notepadName)}.json`;
    await Bun.write(filePath, JSON.stringify(notepad, null, 2));
  }

  /** Load a notepad from disk */
  async load(notepadName: string): Promise<Notepad | null> {
    const filePath = `${this.notepadDir}/${sanitizeName(notepadName)}.json`;
    const file = Bun.file(filePath);
    if (!(await file.exists())) return null;

    try {
      const content = (await file.json()) as Notepad;
      this.notepads.set(content.name, content);
      return content;
    } catch {
      return null;
    }
  }

  /** Load all notepads from disk. Returns the count loaded. */
  async loadAll(): Promise<number> {
    let count = 0;

    try {
      const entries = await readdir(this.notepadDir);

      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const filePath = `${this.notepadDir}/${entry}`;

        try {
          const file = Bun.file(filePath);
          const content = (await file.json()) as Notepad;
          this.notepads.set(content.name, content);
          count++;
        } catch {
          // Skip corrupted files
        }
      }
    } catch {
      // Directory doesn't exist yet
    }

    return count;
  }

  /** List all notepad names (in-memory + on-disk) */
  listNotepads(): string[] {
    return [...this.notepads.keys()].sort();
  }

  /** Clean up old notepads not updated in N days (default: 90) */
  async cleanup(maxAgeDays?: number): Promise<number> {
    const days = maxAgeDays ?? 90;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    let removed = 0;

    try {
      const entries = await readdir(this.notepadDir);

      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const filePath = `${this.notepadDir}/${entry}`;

        try {
          const file = Bun.file(filePath);
          const content = (await file.json()) as Notepad;
          const updatedAt = new Date(content.lastUpdatedAt).getTime();

          if (updatedAt < cutoff) {
            // Remove from in-memory map
            this.notepads.delete(content.name);
            // Remove from disk
            await unlink(filePath);
            removed++;
          }
        } catch {
          // Skip corrupted files
        }
      }
    } catch {
      // Directory doesn't exist
    }

    return removed;
  }
}
