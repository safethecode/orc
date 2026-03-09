import type { FileRefResolver, FileMatch } from "./file-ref.ts";

export interface PickerItem {
  kind: "file" | "agent";
  label: string;   // display text
  value: string;   // insertion value
  score: number;
  detail?: string; // agent role description
}

interface AgentEntry {
  name: string;
  role: string;
}

interface PickerState {
  active: boolean;
  query: string;
  atIndex: number;
  results: PickerItem[];
  selected: number;
  renderedLines: number;
}

export class FilePicker {
  private state: PickerState;
  private resolver: FileRefResolver;
  private agents: AgentEntry[] = [];
  private maxResults = 8;
  private onClear?: () => void;

  constructor(resolver: FileRefResolver, onClear?: () => void) {
    this.resolver = resolver;
    this.onClear = onClear;
    this.state = {
      active: false,
      query: "",
      atIndex: 0,
      results: [],
      selected: 0,
      renderedLines: 0,
    };
  }

  setAgents(agents: AgentEntry[]): void {
    this.agents = agents;
  }

  isActive(): boolean {
    return this.state.active;
  }

  getAtIndex(): number {
    return this.state.atIndex;
  }

  activate(atIndex: number): void {
    this.state.active = true;
    this.state.atIndex = atIndex;
    this.state.query = "";
    this.state.results = [];
    this.state.selected = 0;
  }

  deactivate(): void {
    this.state.active = false;
    this.state.query = "";
    this.state.results = [];
    this.state.selected = 0;
  }

  updateQuery(query: string): void {
    this.state.query = query;

    // Match agents (show all when query is empty, filter when typing)
    const queryLower = query.toLowerCase();
    const agentItems: PickerItem[] = [];
    for (const agent of this.agents) {
      const nameLower = agent.name.toLowerCase();
      let score = 0;
      if (query.length === 0) {
        score = 0.5; // show all agents on bare @
      } else if (nameLower === queryLower) {
        score = 1.0;
      } else if (nameLower.startsWith(queryLower)) {
        score = 0.9;
      } else if (nameLower.includes(queryLower)) {
        score = 0.7;
      }
      if (score > 0) {
        agentItems.push({
          kind: "agent",
          label: agent.name,
          value: agent.name,
          score: score + 0.1, // boost agents above files
          detail: agent.role,
        });
      }
    }
    agentItems.sort((a, b) => b.score - a.score);

    // Match files (skip when query is empty)
    let fileItems: PickerItem[] = [];
    if (query.length > 0) {
      const fileMatches = this.resolver.searchSync(query, this.maxResults);
      fileItems = fileMatches.map((m) => ({
        kind: "file" as const,
        label: m.path,
        value: m.path,
        score: m.score,
      }));
    }

    // Merge: agents first, then files
    const merged = [...agentItems, ...fileItems];
    merged.sort((a, b) => b.score - a.score);

    this.state.results = merged.slice(0, this.maxResults);
    if (this.state.selected >= this.state.results.length) {
      this.state.selected = Math.max(0, this.state.results.length - 1);
    }
  }

  moveSelection(delta: number): void {
    const len = this.state.results.length;
    if (len === 0) return;
    this.state.selected = ((this.state.selected + delta) % len + len) % len;
  }

  getResultCount(): number {
    return this.state.results.length;
  }

  getSelected(): PickerItem | null {
    if (this.state.results.length === 0) return null;
    return this.state.results[this.state.selected];
  }

  /**
   * Render picker results ABOVE the readline prompt using relative cursor movement.
   * Uses \x1b7/\x1b8 (save/restore) and \x1b[nA (move up) so we don't need
   * to know the absolute row of the prompt.
   *
   * Layout (bottom-up, selected item closest to prompt):
   *   ...previous output...
   *   result 5              ← top of picker (furthest from prompt)
   *   result 4
   *   result 3
   *   result 2
   *   result 1 (selected)   ← just above prompt
   *   ❯ @query|             ← readline prompt (cursor here)
   */
  render(): void {
    if (!this.state.active) return;

    const results = this.state.results;
    const numResults = results.length;

    if (numResults === 0) {
      this.clearRender();
      return;
    }

    const cols = process.stdout.columns || 80;

    // First clear any previously rendered lines (if count differs)
    if (this.state.renderedLines > 0 && this.state.renderedLines !== numResults) {
      this.clearRender();
    }

    let buf = "\x1b7"; // save cursor position

    // Move up N lines from prompt
    buf += `\x1b[${numResults}A`;

    // Render results top-to-bottom (index 0 = top of picker)
    // Reverse order: last result at top, first (selected=0) closest to prompt
    for (let i = 0; i < numResults; i++) {
      const resultIdx = numResults - 1 - i;
      const result = results[resultIdx];
      const isSelected = resultIdx === this.state.selected;

      let displayText: string;
      if (result.kind === "agent") {
        const role = result.detail ? ` \x1b[2m· ${result.detail}\x1b[22m` : "";
        displayText = `\x1b[36m@${result.label}\x1b[0m${role}`;
      } else {
        const maxPathLen = cols - 6;
        displayText = result.label.length > maxPathLen
          ? "\u2026" + result.label.slice(result.label.length - maxPathLen + 1)
          : result.label;
      }

      const line = isSelected
        ? `  \x1b[7m ${displayText} \x1b[0m`
        : `   ${displayText}\x1b[0m`;

      buf += `\r\x1b[2K${line}`; // col 1 + clear line + write
      if (i < numResults - 1) buf += "\x1b[B"; // move down (except last)
    }

    buf += "\x1b8"; // restore cursor to prompt
    this.state.renderedLines = numResults;

    process.stdout.write(buf);
  }

  clearRender(): void {
    const numLines = this.state.renderedLines;
    if (numLines === 0) return;

    let buf = "\x1b7"; // save cursor

    // Move up to the top of the picker
    buf += `\x1b[${numLines}A`;

    // Clear each line
    for (let i = 0; i < numLines; i++) {
      buf += "\r\x1b[2K"; // col 1 + clear line
      if (i < numLines - 1) buf += "\x1b[B"; // move down
    }

    buf += "\x1b8"; // restore cursor
    this.state.renderedLines = 0;

    process.stdout.write(buf);

    // Force readline to redraw its prompt
    this.onClear?.();
  }
}
