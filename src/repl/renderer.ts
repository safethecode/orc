import ora, { type Ora } from "ora";
import stringWidth from "string-width";
import type { ModelTier, SubTask, ExecutionPlan } from "../config/types.ts";

// ── ANSI Escape Codes ────────────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";
const BLUE = "\x1b[34m";
const GRAY = "\x1b[90m";
const WHITE = "\x1b[37m";
const BG_MAGENTA = "\x1b[45m";
const BG_CYAN = "\x1b[46m";
const BG_GREEN = "\x1b[42m";
const BG_GRAY = "\x1b[100m";
const BLACK = "\x1b[30m";

const TIER_COLORS: Record<ModelTier, string> = {
  opus: MAGENTA,
  sonnet: CYAN,
  haiku: GREEN,
};

const TIER_BG: Record<ModelTier, string> = {
  opus: BG_MAGENTA,
  sonnet: BG_CYAN,
  haiku: BG_GREEN,
};

// ── Box State (for streaming bordered output) ────────────────────────

let boxColor = GRAY;
let boxTextW = 0; // max text width inside box (set on startBox)
let atLineStart = true;
const BOX_PAD = "  ";
const boxBorder = () => `${boxColor}│${RESET} `;
const boxBorderR = () => ` ${boxColor}│${RESET}`;


// ── Markdown State ──────────────────────────────────────────────────

let lineBuffer = "";
let inCodeBlock = false;

// ── Prompt ───────────────────────────────────────────────────────────

export const PROMPT = `${BOLD}${MAGENTA}❯${RESET} `;

// ── Welcome ──────────────────────────────────────────────────────────

export function welcome(profiles: string[]): void {
  const w = process.stdout.columns || 80;
  const line = `${GRAY}${"─".repeat(w)}${RESET}`;

  process.stdout.write("\n");
  process.stdout.write(`  ${BOLD}${WHITE}orc${RESET}  ${DIM}interactive orchestrator${RESET}\n`);
  process.stdout.write(`  ${GRAY}agents: ${profiles.map((p) => `${CYAN}${p}${GRAY}`).join(", ")}${RESET}\n`);
  process.stdout.write(`${line}\n`);
  process.stdout.write(`  ${DIM}type naturally or ${WHITE}/help${GRAY} for commands${RESET}\n\n`);
}

// ── Agent Header ─────────────────────────────────────────────────────

export function agentHeader(name: string, tier: ModelTier, reason: string): void {
  const color = TIER_COLORS[tier];
  const bg = TIER_BG[tier];
  const badge = `${bg}${BLACK}${BOLD} ${tier} ${RESET}`;
  const reasonText = reason ? `  ${GRAY}${ITALIC}${reason}${RESET}` : "";

  process.stdout.write(
    `\n  ${color}${BOLD}${name}${RESET} ${badge}${reasonText}\n`,
  );
}

// ── Response Box ─────────────────────────────────────────────────────

export function startBox(tier: ModelTier): void {
  const color = TIER_COLORS[tier];
  boxColor = color;
  atLineStart = true;
  lineBuffer = "";
  inCodeBlock = false;

  // Box layout:  BOX_PAD + ╭ + ─×dashW + ╮  (total = columns)
  // Content:     BOX_PAD + │ + space + text(textW) + space + │
  const dashW = (process.stdout.columns || 80) - 4; // -2 pad -1 ╭ -1 ╮
  boxTextW = dashW - 2; // text area = dashes minus 2 inner spaces
  process.stdout.write(`${BOX_PAD}${color}╭${"─".repeat(dashW)}╮${RESET}\n`);
}

export function endBox(): void {
  if (lineBuffer) {
    flushLineBuffer();
  }
  if (!atLineStart) {
    process.stdout.write("\n");
  }
  const dashW = (process.stdout.columns || 80) - 4;
  process.stdout.write(`${BOX_PAD}${boxColor}╰${"─".repeat(dashW)}╯${RESET}\n`);
}

// ── Streaming Text (writes inside box with markdown) ────────────────

export function text(content: string): void {
  for (const ch of content) {
    if (ch === "\n") {
      flushLineBuffer();
    } else {
      lineBuffer += ch;
    }
  }
}

function flushLineBuffer(): void {
  const wrapped = wrapText(lineBuffer, boxTextW);
  for (const wline of wrapped) {
    const rendered = renderMarkdownLine(wline);
    const visW = stringWidth(rendered);
    const pad = Math.max(0, boxTextW - visW);
    process.stdout.write(`${BOX_PAD}${boxBorder()}${rendered}${" ".repeat(pad)}${boxBorderR()}\n`);
  }
  lineBuffer = "";
  atLineStart = true;
}

// ── Word Wrap ───────────────────────────────────────────────────────

function wrapText(text: string, maxWidth: number): string[] {
  if (stringWidth(text) <= maxWidth) return [text];

  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;

  for (const word of words) {
    const wordWidth = stringWidth(word);
    if (!current) {
      current = word;
      currentWidth = wordWidth;
    } else if (currentWidth + 1 + wordWidth > maxWidth) {
      lines.push(current);
      current = word;
      currentWidth = wordWidth;
    } else {
      current += " " + word;
      currentWidth += 1 + wordWidth;
    }
  }
  if (current) lines.push(current);

  return lines.length > 0 ? lines : [text];
}

// ── Markdown → ANSI ─────────────────────────────────────────────────

function renderMarkdownLine(line: string): string {
  // Code block delimiter
  if (line.startsWith("```")) {
    inCodeBlock = !inCodeBlock;
    if (inCodeBlock) {
      const lang = line.slice(3).trim();
      const w = (process.stdout.columns || 80) - 10;
      const label = lang ? ` ${lang} ` : "";
      return `${DIM}${label}${"╌".repeat(Math.max(0, w - label.length))}${RESET}`;
    }
    const w = (process.stdout.columns || 80) - 10;
    return `${DIM}${"╌".repeat(w)}${RESET}`;
  }

  // Inside code block — dim, no markdown processing
  if (inCodeBlock) {
    return `${DIM}${line}${RESET}`;
  }

  // Horizontal rule
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
    const w = (process.stdout.columns || 80) - 10;
    return `${DIM}${"─".repeat(w)}${RESET}`;
  }

  // Headers
  const h3 = line.match(/^### (.+)/);
  if (h3) return `${BOLD}${h3[1]}${RESET}`;

  const h2 = line.match(/^## (.+)/);
  if (h2) return `${BOLD}${h2[1]}${RESET}`;

  const h1 = line.match(/^# (.+)/);
  if (h1) return `${BOLD}${WHITE}${h1[1]}${RESET}`;

  // Bullet list
  line = line.replace(/^(\s*)- /, "$1• ");

  // Bold
  line = line.replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${RESET}`);

  // Italic
  line = line.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, `${ITALIC}$1${RESET}`);

  // Inline code
  line = line.replace(/`(.+?)`/g, `${DIM}$1${RESET}`);

  return line;
}

// ── Tool Use ────────────────────────────────────────────────────────

export function toolUse(name: string, detail?: string, insideBox = false): void {
  const label = detail ? `${name} ${detail}` : name;
  if (insideBox) {
    const visW = stringWidth(label) + 2; // ▸ + space
    const pad = Math.max(0, boxTextW - visW);
    process.stdout.write(
      `${BOX_PAD}${boxBorder()}${DIM}${YELLOW}▸${RESET} ${DIM}${label}${RESET}${" ".repeat(pad)}${boxBorderR()}\n`,
    );
  } else {
    process.stdout.write(`  ${DIM}${YELLOW}▸${RESET} ${DIM}${label}${RESET}\n`);
  }
}

// ── Cost / Stats ─────────────────────────────────────────────────────

export function cost(usd: number, inputTokens: number, outputTokens: number, durationMs?: number): void {
  const price = usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
  const tokens = `${inputTokens.toLocaleString()} → ${outputTokens.toLocaleString()}`;
  const duration = durationMs ? `  ${(durationMs / 1000).toFixed(1)}s` : "";

  process.stdout.write(
    `  ${GRAY}${price}  │  ${tokens} tokens${duration}${RESET}\n`,
  );
}

// ── Error ────────────────────────────────────────────────────────────

export function error(message: string): void {
  process.stderr.write(`\n  ${RED}${BOLD}✗${RESET} ${RED}${message}${RESET}\n`);
}

// ── Info ─────────────────────────────────────────────────────────────

export function info(message: string): void {
  process.stdout.write(`  ${DIM}${message}${RESET}\n`);
}

export function dim(message: string): void {
  process.stdout.write(`${DIM}${message}${RESET}\n`);
}

// ── Handoff ──────────────────────────────────────────────────────────

export function handoff(from: string, to: string): void {
  process.stdout.write(
    `  ${YELLOW}${BOLD}↗${RESET} ${DIM}handoff${RESET} ${WHITE}${from}${RESET} ${DIM}→${RESET} ${WHITE}${to}${RESET}\n`,
  );
}

// ── Separator ────────────────────────────────────────────────────────

export function separator(): void {
  const w = process.stdout.columns || 80;
  process.stdout.write(`${GRAY}${"─".repeat(w)}${RESET}\n`);
}

// ── Spinner ──────────────────────────────────────────────────────────

let spinner: Ora | null = null;

export function startSpinner(agentName: string, tier: ModelTier): void {
  const color = tier === "opus" ? "magenta" : tier === "sonnet" ? "cyan" : "green";
  spinner = ora({
    text: `${DIM}${agentName} is thinking...${RESET}`,
    color,
    indent: 2,
    stream: process.stdout,
  }).start();
}

export function updateSpinner(text: string): void {
  if (spinner) {
    spinner.text = `${DIM}${text}${RESET}`;
  }
}

export function stopSpinner(): void {
  if (spinner) {
    spinner.stop();
    process.stdout.write("\r\x1b[K");
    spinner = null;
  }
}

// ── Multi-Agent Plan Display ────────────────────────────────────────

export function planSummary(subtasks: SubTask[], plan: ExecutionPlan): void {
  process.stdout.write(`\n  ${BOLD}${WHITE}Execution Plan${RESET}  ${DIM}${plan.strategy}${RESET}\n`);
  for (const subtask of subtasks) {
    const tier = subtask.model as ModelTier;
    const bg = TIER_BG[tier] ?? BG_GRAY;
    const badge = `${bg}${BLACK}${BOLD} ${subtask.model} ${RESET}`;
    process.stdout.write(
      `  ${DIM}•${RESET} ${badge} ${DIM}${subtask.agentRole}${RESET}  ${GRAY}${subtask.prompt.slice(0, 60)}${subtask.prompt.length > 60 ? "\u2026" : ""}${RESET}\n`,
    );
  }
  process.stdout.write("\n");
}

export function phaseHeader(name: string, count: number, parallel: boolean): void {
  const mode = parallel ? "parallel" : "sequential";
  process.stdout.write(
    `  ${YELLOW}${BOLD}\u25B6${RESET} ${WHITE}${name}${RESET}  ${DIM}${count} task${count > 1 ? "s" : ""}, ${mode}${RESET}\n`,
  );
}

export function mcpStatus(serverNames: string[], toolCount: number): void {
  process.stdout.write(
    `  ${GRAY}mcp: ${serverNames.join(", ")}  (${toolCount} tools)${RESET}\n`,
  );
}

export function mcpScout(names: string[], durationMs: number): void {
  const time = `${(durationMs / 1000).toFixed(1)}s`;
  process.stdout.write(
    `  ${DIM}mcp: ${names.join(", ")}  ${GRAY}(scout ${time})${RESET}\n`,
  );
}

export function skillScout(names: string[], durationMs: number): void {
  const time = `${(durationMs / 1000).toFixed(1)}s`;
  process.stdout.write(
    `  ${DIM}skills: ${names.join(", ")}  ${GRAY}(scout ${time})${RESET}\n`,
  );
}
