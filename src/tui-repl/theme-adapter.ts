import type { ThemeColors, Theme } from "../repl/theme.ts";

export interface TuiThemeColors {
  primary: string;
  secondary: string;
  accent: string;
  success: string;
  warning: string;
  error: string;
  info: string;
  dim: string;
  text: string;
  background: string;
  border: string;
}

const ANSI_TO_HEX: Record<string, string> = {
  "\x1b[31m": "#f7768e",
  "\x1b[32m": "#9ece6a",
  "\x1b[33m": "#e0af68",
  "\x1b[34m": "#7aa2f7",
  "\x1b[35m": "#bb9af7",
  "\x1b[36m": "#7dcfff",
  "\x1b[37m": "#c0caf5",
  "\x1b[90m": "#565f89",
  "\x1b[40m": "#1a1b26",
};

function ansiToHex(ansi: string): string {
  // Direct ANSI code mapping
  if (ANSI_TO_HEX[ansi]) return ANSI_TO_HEX[ansi];

  // RGB escape: \x1b[38;2;R;G;Bm or \x1b[48;2;R;G;Bm
  const rgbMatch = ansi.match(/\x1b\[(?:38|48);2;(\d+);(\d+);(\d+)m/);
  if (rgbMatch) {
    const r = parseInt(rgbMatch[1], 10);
    const g = parseInt(rgbMatch[2], 10);
    const b = parseInt(rgbMatch[3], 10);
    return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
  }

  // Fallback
  return "#c0caf5";
}

export function convertTheme(theme: Theme): TuiThemeColors {
  const c = theme.colors;
  return {
    primary: ansiToHex(c.primary),
    secondary: ansiToHex(c.secondary),
    accent: ansiToHex(c.accent),
    success: ansiToHex(c.success),
    warning: ansiToHex(c.warning),
    error: ansiToHex(c.error),
    info: ansiToHex(c.info),
    dim: ansiToHex(c.dim),
    text: ansiToHex(c.text),
    background: ansiToHex(c.background),
    border: ansiToHex(c.border),
  };
}

// Shared spinner frames for animated spinners
export const SPINNER_FRAMES = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"];

// Tier-specific colors (matches renderer.ts TIER_COLORS)
export const TIER_HEX = {
  opus: "#bb9af7",
  sonnet: "#7dcfff",
  haiku: "#9ece6a",
} as const;
