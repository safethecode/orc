import type { FileRefResolver, FileMatch } from "./file-ref.ts";

interface PickerState {
  active: boolean;
  query: string;
  atIndex: number;
  results: FileMatch[];
  selected: number;
  renderedLines: number;
}

export class FilePicker {
  private state: PickerState;
  private resolver: FileRefResolver;
  private maxResults = 5;
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
    if (query.length === 0) {
      this.state.results = [];
      this.state.selected = 0;
      return;
    }
    this.state.results = this.resolver.searchSync(query, this.maxResults);
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

  getSelected(): FileMatch | null {
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
      // Map: top of picker = results[numResults-1-i] visually
      // But simpler: just render results[i] at line i (top to bottom)
      // with selected closest to prompt (bottom of picker)
      const resultIdx = numResults - 1 - i;
      const result = results[resultIdx];
      const isSelected = resultIdx === this.state.selected;

      const maxPathLen = cols - 6;
      const displayPath = result.path.length > maxPathLen
        ? "\u2026" + result.path.slice(result.path.length - maxPathLen + 1)
        : result.path;

      const line = isSelected
        ? `  \x1b[7m ${displayPath} \x1b[0m`
        : `   \x1b[2m${displayPath}\x1b[0m`;

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
