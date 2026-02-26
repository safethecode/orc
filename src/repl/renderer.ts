import type { ModelTier } from "../config/types.ts";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";
const GRAY = "\x1b[90m";

const TIER_COLORS: Record<ModelTier, string> = {
  opus: MAGENTA,
  sonnet: CYAN,
  haiku: GREEN,
};

export function agentHeader(name: string, tier: ModelTier, reason: string): void {
  const color = TIER_COLORS[tier];
  process.stdout.write(
    `\n${BOLD}${color}[${name}]${RESET} ${DIM}${tier}${RESET} ${GRAY}-- ${reason}${RESET}\n\n`,
  );
}

export function text(content: string): void {
  process.stdout.write(content);
}

export function cost(usd: number, inputTokens: number, outputTokens: number): void {
  const formatted = usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
  process.stdout.write(
    `\n${DIM}${GRAY}cost: ${formatted} (in: ${inputTokens.toLocaleString()} / out: ${outputTokens.toLocaleString()})${RESET}\n`,
  );
}

export function error(message: string): void {
  process.stderr.write(`${RED}${BOLD}error:${RESET} ${RED}${message}${RESET}\n`);
}

export function info(message: string): void {
  process.stdout.write(`${DIM}${message}${RESET}\n`);
}

export function handoff(from: string, to: string): void {
  process.stdout.write(
    `${YELLOW}${BOLD}handoff:${RESET} ${from} ${DIM}→${RESET} ${to}\n`,
  );
}

export function welcome(): void {
  process.stdout.write(
    `${BOLD}orc${RESET} ${DIM}— interactive orchestrator${RESET}\n` +
    `${DIM}type a task or /help for commands${RESET}\n`,
  );
}
