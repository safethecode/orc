import type { FileRefResolver, FileMatch } from "./file-ref.ts";

interface PickerState {
  active: boolean;
  query: string;
  atIndex: number;
  results: FileMatch[];
  selected: number;
  renderedLines: number;
}

interface LayoutInfo {
  scrollBottom: number;
  cols: number;
}

export class FilePicker {
  private state: PickerState;
  private resolver: FileRefResolver;
  private maxResults = 5;

  constructor(resolver: FileRefResolver) {
    this.resolver = resolver;
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
    // Keep selection in bounds
    if (this.state.selected >= this.state.results.length) {
      this.state.selected = Math.max(0, this.state.results.length - 1);
    }
  }

  moveSelection(delta: number): void {
    const len = this.state.results.length;
    if (len === 0) return;
    this.state.selected = ((this.state.selected + delta) % len + len) % len;
  }

  getSelected(): FileMatch | null {
    if (this.state.results.length === 0) return null;
    return this.state.results[this.state.selected];
  }

  render(getLayout: () => LayoutInfo | null): void {
    if (!this.state.active) return;

    const layoutInfo = getLayout();
    if (!layoutInfo) return;

    const { scrollBottom, cols } = layoutInfo;
    const results = this.state.results;
    const numResults = results.length;

    // Nothing to show: clear any previous render
    if (numResults === 0) {
      this.clearRender(getLayout);
      return;
    }

    // Render results above the status bar (bottom of scroll region)
    const startRow = scrollBottom - numResults + 1;
    if (startRow < 1) return;

    let buf = "\x1b7"; // save cursor

    for (let i = 0; i < numResults; i++) {
      const row = startRow + i;
      const result = results[i];
      const isSelected = i === this.state.selected;

      const maxPathLen = cols - 6;
      const displayPath = result.path.length > maxPathLen
        ? "\u2026" + result.path.slice(result.path.length - maxPathLen + 1)
        : result.path;

      const line = isSelected
        ? `  \x1b[7m ${displayPath} \x1b[0m`
        : `   \x1b[2m${displayPath}\x1b[0m`;

      buf += `\x1b[${row};1H\x1b[2K${line}`;
    }

    buf += "\x1b8"; // restore cursor
    this.state.renderedLines = numResults;

    process.stdout.write(buf);
  }

  clearRender(getLayout: () => LayoutInfo | null): void {
    if (this.state.renderedLines === 0) return;

    const layoutInfo = getLayout();
    if (!layoutInfo) return;

    const { scrollBottom } = layoutInfo;
    const numLines = this.state.renderedLines;
    const startRow = scrollBottom - numLines + 1;
    if (startRow < 1) return;

    let buf = "\x1b7"; // save cursor
    for (let i = 0; i < numLines; i++) {
      buf += `\x1b[${startRow + i};1H\x1b[2K`;
    }
    buf += "\x1b8"; // restore cursor
    this.state.renderedLines = 0;

    process.stdout.write(buf);
  }
}
