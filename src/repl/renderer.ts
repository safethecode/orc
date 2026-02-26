import ora, { type Ora } from "ora";
import type { ModelTier } from "../config/types.ts";

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
let atLineStart = true;
const BOX_PAD = "  ";
const boxBorder = () => `${boxColor}│${RESET} `;

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

  const w = (process.stdout.columns || 80) - 4;
  process.stdout.write(`${BOX_PAD}${color}╭${"─".repeat(w)}${RESET}\n`);
}

export function endBox(): void {
  // flush remaining partial line
  if (lineBuffer) {
    const rendered = renderMarkdownLine(lineBuffer);
    process.stdout.write(`${atLineStart ? `${BOX_PAD}${boxBorder()}` : ""}${rendered}`);
    lineBuffer = "";
    atLineStart = false;
  }
  if (!atLineStart) {
    process.stdout.write("\n");
  }
  const w = (process.stdout.columns || 80) - 4;
  process.stdout.write(`${BOX_PAD}${boxColor}╰${"─".repeat(w)}${RESET}\n`);
}

// ── Streaming Text (writes inside box with markdown) ────────────────

export function text(content: string): void {
  for (const ch of content) {
    if (ch === "\n") {
      const rendered = renderMarkdownLine(lineBuffer);
      process.stdout.write(
        `${atLineStart ? `${BOX_PAD}${boxBorder()}` : ""}${rendered}\n`,
      );
      lineBuffer = "";
      atLineStart = true;
    } else {
      lineBuffer += ch;
    }
  }
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

export function stopSpinner(): void {
  if (spinner) {
    spinner.stop();
    process.stdout.write("\r\x1b[K");
    spinner = null;
  }
}
