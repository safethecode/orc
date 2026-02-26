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
    `\n  ${color}${BOLD}${name}${RESET} ${badge}${reasonText}\n\n`,
  );
}

// ── Streaming Text ───────────────────────────────────────────────────

export function text(content: string): void {
  process.stdout.write(content);
}

// ── Cost / Stats ─────────────────────────────────────────────────────

export function cost(usd: number, inputTokens: number, outputTokens: number, durationMs?: number): void {
  const price = usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
  const tokens = `${inputTokens.toLocaleString()} → ${outputTokens.toLocaleString()}`;
  const duration = durationMs ? `  ${GRAY}${(durationMs / 1000).toFixed(1)}s${RESET}` : "";

  process.stdout.write(
    `\n  ${GRAY}${price}  ${DIM}│${RESET}  ${GRAY}${tokens} tokens${RESET}${duration}\n`,
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

// ── Thinking indicator ───────────────────────────────────────────────

export function thinking(agentName: string): void {
  process.stdout.write(`  ${DIM}${agentName} is thinking...${RESET}`);
}

export function clearThinking(): void {
  process.stdout.write("\r\x1b[K");
}
