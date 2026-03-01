// ── Layout Manager ──────────────────────────────────────────────────
// Manages split-pane terminal layout using ANSI scroll regions.
// Provides: scroll region for agent output, fixed status bar, input area
// with message queuing during agent execution.

import stringWidth from "string-width";

// ── ANSI helpers ────────────────────────────────────────────────────

const ESC = "\x1b";
const RESET = `${ESC}[0m`;
const DIM = `${ESC}[2m`;
const BOLD = `${ESC}[1m`;
const BG_GRAY = `${ESC}[48;5;236m`; // dark gray bg for status bar
const FG_WHITE = `${ESC}[37m`;
const FG_GREEN = `${ESC}[32m`;
const FG_YELLOW = `${ESC}[33m`;
const FG_CYAN = `${ESC}[36m`;
const FG_DIM = `${ESC}[90m`;

/** Save cursor position (DEC) */
const SAVE = `${ESC}7`;
/** Restore cursor position (DEC) */
const RESTORE = `${ESC}8`;
/** Hide cursor */
const HIDE_CURSOR = `${ESC}[?25l`;
/** Show cursor */
const SHOW_CURSOR = `${ESC}[?25h`;

function moveTo(row: number, col: number): string {
  return `${ESC}[${row};${col}H`;
}

function clearLine(): string {
  return `${ESC}[2K`;
}

function setScrollRegion(top: number, bottom: number): string {
  return `${ESC}[${top};${bottom}r`;
}

function resetScrollRegion(): string {
  return `${ESC}[r`;
}

// ── Types ───────────────────────────────────────────────────────────

export type AgentState = "idle" | "thinking" | "streaming" | "tool_use";

interface LayoutState {
  rows: number;
  cols: number;
  scrollBottom: number; // last row of scroll region
  statusRow: number;    // row for status bar
  inputRow: number;     // row for input area
}

interface KeyInfo {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

// ── LayoutManager ───────────────────────────────────────────────────

const MIN_ROWS = 8;
const RESERVED_ROWS = 2; // status bar + input line
const PROMPT_STR = "❯ ";
const PROMPT_W = 2; // visible width of "❯ "

export class LayoutManager {
  private state: LayoutState;
  private active = false;
  private inAgentMode = false;

  // Agent state for status bar
  private agentState: AgentState = "idle";
  private agentName = "";
  private costSoFar = 0;
  private elapsedStart = 0;
  private statusTimer: ReturnType<typeof setInterval> | null = null;

  // Input queuing during agent mode
  private inputBuffer = "";
  private inputCursor = 0;
  private messageQueue: string[] = [];

  // Resize debounce
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.state = this.calcLayout();
  }

  // ── Layout calculation ──────────────────────────────────────────

  private calcLayout(): LayoutState {
    const rows = process.stdout.rows || 24;
    const cols = process.stdout.columns || 80;
    const scrollBottom = Math.max(rows - RESERVED_ROWS, 1);
    return {
      rows,
      cols,
      scrollBottom,
      statusRow: rows - 1,
      inputRow: rows,
    };
  }

  // ── Activation ──────────────────────────────────────────────────

  activate(): void {
    if (!process.stdout.isTTY) return;
    if (this.state.rows < MIN_ROWS) return;

    this.active = true;
    this.state = this.calcLayout();

    // Set scroll region (output area)
    process.stdout.write(setScrollRegion(1, this.state.scrollBottom));

    // Draw initial chrome
    this.renderStatusBar();
    this.renderInputHint();

    // Position cursor in scroll region
    process.stdout.write(moveTo(this.state.scrollBottom, 1));

    // Start status bar refresh timer (every second for elapsed time)
    this.statusTimer = setInterval(() => {
      if (this.inAgentMode) this.renderStatusBar();
    }, 1000);
  }

  deactivate(): void {
    if (!this.active) return;
    this.active = false;

    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = null;
    }

    // Reset scroll region to full terminal
    process.stdout.write(resetScrollRegion());

    // Clear status and input rows
    process.stdout.write(moveTo(this.state.statusRow, 1) + clearLine());
    process.stdout.write(moveTo(this.state.inputRow, 1) + clearLine());

    // Move cursor to bottom
    process.stdout.write(moveTo(this.state.rows, 1));
    process.stdout.write(SHOW_CURSOR);
  }

  // ── Resize handling ─────────────────────────────────────────────

  handleResize(): void {
    if (!this.active) return;

    // Debounce resize events
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.state = this.calcLayout();

      if (this.state.rows < MIN_ROWS) {
        // Terminal too small — disable split pane
        process.stdout.write(resetScrollRegion());
        return;
      }

      // Re-establish scroll region
      process.stdout.write(SAVE);
      process.stdout.write(setScrollRegion(1, this.state.scrollBottom));
      this.renderStatusBar();
      if (this.inAgentMode) {
        this.renderInputArea();
      } else {
        this.renderInputHint();
      }
      process.stdout.write(RESTORE);
    }, 100);
  }

  // ── Agent mode ──────────────────────────────────────────────────

  enterAgentMode(agentName: string): void {
    if (!this.active) return;

    this.inAgentMode = true;
    this.agentName = agentName;
    this.agentState = "thinking";
    this.elapsedStart = Date.now();
    this.costSoFar = 0;
    this.inputBuffer = "";
    this.inputCursor = 0;
    // Don't clear messageQueue — allow carry-over from previous turns

    this.renderStatusBar();
    this.renderInputArea();
  }

  exitAgentMode(): string[] {
    if (!this.active) {
      const q = [...this.messageQueue];
      this.messageQueue = [];
      return q;
    }

    this.inAgentMode = false;
    this.agentState = "idle";

    const queued = [...this.messageQueue];
    this.messageQueue = [];

    this.renderStatusBar();
    this.renderInputHint();

    return queued;
  }

  // ── Status updates (called from renderer hooks) ─────────────────

  updateAgentState(state: AgentState): void {
    if (!this.active) return;
    this.agentState = state;
    this.renderStatusBar();
  }

  updateCost(usd: number): void {
    if (!this.active) return;
    this.costSoFar = usd;
    this.renderStatusBar();
  }

  // ── Keypress handling (agent mode input) ────────────────────────

  handleKeypress(str: string | undefined, key: KeyInfo): void {
    if (!this.active || !this.inAgentMode) return;

    // Ctrl+C — don't handle, let SIGINT propagate
    if (key.ctrl && key.name === "c") return;

    // Enter — queue the message
    if (key.name === "return") {
      const msg = this.inputBuffer.trim();
      if (msg) {
        this.messageQueue.push(msg);
      }
      this.inputBuffer = "";
      this.inputCursor = 0;
      this.renderInputArea();
      return;
    }

    // Backspace
    if (key.name === "backspace") {
      if (this.inputCursor > 0) {
        this.inputBuffer =
          this.inputBuffer.slice(0, this.inputCursor - 1) +
          this.inputBuffer.slice(this.inputCursor);
        this.inputCursor--;
        this.renderInputArea();
      }
      return;
    }

    // Left/right arrow
    if (key.name === "left") {
      if (this.inputCursor > 0) this.inputCursor--;
      this.renderInputArea();
      return;
    }
    if (key.name === "right") {
      if (this.inputCursor < this.inputBuffer.length) this.inputCursor++;
      this.renderInputArea();
      return;
    }

    // Home/End
    if (key.name === "home") { this.inputCursor = 0; this.renderInputArea(); return; }
    if (key.name === "end") { this.inputCursor = this.inputBuffer.length; this.renderInputArea(); return; }

    // Printable character
    if (str && !key.ctrl && !key.meta) {
      this.inputBuffer =
        this.inputBuffer.slice(0, this.inputCursor) +
        str +
        this.inputBuffer.slice(this.inputCursor);
      this.inputCursor += str.length;
      this.renderInputArea();
    }
  }

  // ── Rendering ───────────────────────────────────────────────────

  private renderStatusBar(): void {
    if (!this.active) return;

    const { statusRow, cols } = this.state;

    // Build left side: state indicator + agent name
    let left: string;
    let leftW: number;

    if (this.agentState === "idle") {
      left = `${FG_DIM}  ○ idle${RESET}`;
      leftW = 10;
    } else {
      const stateLabel =
        this.agentState === "thinking" ? "thinking" :
        this.agentState === "streaming" ? "streaming" :
        "running tool";
      const stateColor =
        this.agentState === "thinking" ? FG_YELLOW :
        this.agentState === "streaming" ? FG_GREEN :
        FG_CYAN;
      left = `${stateColor}  ◉ ${this.agentName} ${stateLabel}${RESET}`;
      leftW = 4 + this.agentName.length + 1 + stateLabel.length;
    }

    // Build right side: cost + elapsed
    let right = "";
    let rightW = 0;

    if (this.inAgentMode) {
      const elapsed = Math.round((Date.now() - this.elapsedStart) / 1000);
      const costStr = this.costSoFar > 0 ? `$${this.costSoFar.toFixed(4)}` : "";
      const timeStr = `${elapsed}s`;

      if (costStr) {
        right = `${FG_DIM}${costStr}  │  ${timeStr}  ${RESET}`;
        rightW = costStr.length + 5 + timeStr.length + 2;
      } else {
        right = `${FG_DIM}${timeStr}  ${RESET}`;
        rightW = timeStr.length + 2;
      }
    }

    // Compose status line
    const padW = Math.max(0, cols - leftW - rightW);
    const pad = " ".repeat(padW);
    const statusLine = `${BG_GRAY}${left}${pad}${right}${RESET}`;

    process.stdout.write(
      SAVE +
      HIDE_CURSOR +
      moveTo(statusRow, 1) +
      clearLine() +
      statusLine +
      SHOW_CURSOR +
      RESTORE,
    );
  }

  private renderInputArea(): void {
    if (!this.active) return;

    const { inputRow, cols } = this.state;

    // Build display content
    let display: string;
    let cursorCol: number;

    if (this.inputBuffer.length === 0 && this.messageQueue.length === 0) {
      // Empty — show hint
      display = `${DIM}${PROMPT_STR}type to queue a message...${RESET}`;
      cursorCol = PROMPT_W + 1;
    } else if (this.inputBuffer.length === 0 && this.messageQueue.length > 0) {
      // Empty buffer but has queued messages
      const s = this.messageQueue.length === 1 ? "" : "s";
      display = `${DIM}${PROMPT_STR}(${this.messageQueue.length} message${s} queued)${RESET}`;
      cursorCol = PROMPT_W + 1;
    } else {
      // Has content
      const visibleW = stringWidth(this.inputBuffer);
      const maxW = cols - PROMPT_W - 1;
      const truncated = visibleW > maxW
        ? this.inputBuffer.slice(0, maxW) + "…"
        : this.inputBuffer;
      const queueHint = this.messageQueue.length > 0
        ? `${FG_DIM} (${this.messageQueue.length} queued)${RESET}`
        : "";
      display = `${PROMPT_STR}${truncated}${queueHint}`;

      // Calculate cursor position
      const beforeCursor = this.inputBuffer.slice(0, this.inputCursor);
      cursorCol = PROMPT_W + stringWidth(beforeCursor) + 1;
    }

    process.stdout.write(
      SAVE +
      moveTo(inputRow, 1) +
      clearLine() +
      display +
      moveTo(inputRow, cursorCol) +
      RESTORE,
    );
  }

  private renderInputHint(): void {
    if (!this.active) return;

    const { inputRow } = this.state;
    // When not in agent mode, the readline handles the input row.
    // Just clear our hint.
    process.stdout.write(
      SAVE +
      moveTo(inputRow, 1) +
      clearLine() +
      RESTORE,
    );
  }

  // ── Getters ─────────────────────────────────────────────────────

  isActive(): boolean {
    return this.active;
  }

  isInAgentMode(): boolean {
    return this.inAgentMode;
  }

  getQueuedCount(): number {
    return this.messageQueue.length;
  }

  /** Drain all queued messages without exiting agent mode */
  drainQueue(): string[] {
    const msgs = [...this.messageQueue];
    this.messageQueue = [];
    this.renderInputArea();
    return msgs;
  }

  getLayout(): LayoutState {
    return { ...this.state };
  }
}
