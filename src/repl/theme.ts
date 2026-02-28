import { readdir } from "node:fs/promises";
import { join } from "node:path";

export interface ThemeColors {
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
  bold: string;
  italic: string;
  reset: string;
}

export interface Theme {
  name: string;
  description: string;
  colors: ThemeColors;
  dark: boolean;
}

const rgb = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`;
const bgRgb = (r: number, g: number, b: number) => `\x1b[48;2;${r};${g};${b}m`;

const BUILT_IN_THEMES: Record<string, Theme> = {
  default: {
    name: "default",
    description: "Default dark theme",
    dark: true,
    colors: {
      primary: "\x1b[35m",
      secondary: "\x1b[36m",
      accent: "\x1b[33m",
      success: "\x1b[32m",
      warning: "\x1b[33m",
      error: "\x1b[31m",
      info: "\x1b[36m",
      dim: "\x1b[90m",
      text: "\x1b[37m",
      background: "\x1b[40m",
      border: "\x1b[90m",
      bold: "\x1b[1m",
      italic: "\x1b[3m",
      reset: "\x1b[0m",
    },
  },

  tokyonight: {
    name: "tokyonight",
    description: "Tokyo Night color scheme",
    dark: true,
    colors: {
      primary: rgb(122, 162, 247),
      secondary: rgb(125, 207, 255),
      accent: rgb(224, 175, 104),
      success: rgb(158, 206, 106),
      warning: rgb(224, 175, 104),
      error: rgb(247, 118, 142),
      info: rgb(125, 207, 255),
      dim: rgb(86, 95, 137),
      text: rgb(192, 202, 245),
      background: bgRgb(26, 27, 38),
      border: rgb(61, 66, 98),
      bold: "\x1b[1m",
      italic: "\x1b[3m",
      reset: "\x1b[0m",
    },
  },

  catppuccin: {
    name: "catppuccin",
    description: "Catppuccin Mocha flavor",
    dark: true,
    colors: {
      primary: rgb(203, 166, 247),
      secondary: rgb(137, 220, 235),
      accent: rgb(249, 226, 175),
      success: rgb(166, 227, 161),
      warning: rgb(249, 226, 175),
      error: rgb(243, 139, 168),
      info: rgb(137, 220, 235),
      dim: rgb(108, 112, 134),
      text: rgb(205, 214, 244),
      background: bgRgb(30, 30, 46),
      border: rgb(88, 91, 112),
      bold: "\x1b[1m",
      italic: "\x1b[3m",
      reset: "\x1b[0m",
    },
  },

  gruvbox: {
    name: "gruvbox",
    description: "Gruvbox Dark color scheme",
    dark: true,
    colors: {
      primary: rgb(211, 134, 155),
      secondary: rgb(142, 192, 124),
      accent: rgb(250, 189, 47),
      success: rgb(142, 192, 124),
      warning: rgb(250, 189, 47),
      error: rgb(251, 73, 52),
      info: rgb(131, 165, 152),
      dim: rgb(146, 131, 116),
      text: rgb(235, 219, 178),
      background: bgRgb(40, 40, 40),
      border: rgb(80, 73, 69),
      bold: "\x1b[1m",
      italic: "\x1b[3m",
      reset: "\x1b[0m",
    },
  },

  nord: {
    name: "nord",
    description: "Nord arctic color scheme",
    dark: true,
    colors: {
      primary: rgb(136, 192, 208),
      secondary: rgb(129, 161, 193),
      accent: rgb(235, 203, 139),
      success: rgb(163, 190, 140),
      warning: rgb(235, 203, 139),
      error: rgb(191, 97, 106),
      info: rgb(136, 192, 208),
      dim: rgb(76, 86, 106),
      text: rgb(216, 222, 233),
      background: bgRgb(46, 52, 64),
      border: rgb(67, 76, 94),
      bold: "\x1b[1m",
      italic: "\x1b[3m",
      reset: "\x1b[0m",
    },
  },

  everforest: {
    name: "everforest",
    description: "Everforest dark green theme",
    dark: true,
    colors: {
      primary: rgb(167, 192, 128),
      secondary: rgb(131, 165, 152),
      accent: rgb(219, 188, 127),
      success: rgb(167, 192, 128),
      warning: rgb(219, 188, 127),
      error: rgb(230, 126, 128),
      info: rgb(131, 165, 152),
      dim: rgb(121, 116, 108),
      text: rgb(211, 198, 170),
      background: bgRgb(47, 53, 47),
      border: rgb(90, 85, 78),
      bold: "\x1b[1m",
      italic: "\x1b[3m",
      reset: "\x1b[0m",
    },
  },

  kanagawa: {
    name: "kanagawa",
    description: "Kanagawa wave-inspired theme",
    dark: true,
    colors: {
      primary: rgb(126, 156, 216),
      secondary: rgb(122, 172, 194),
      accent: rgb(226, 195, 146),
      success: rgb(152, 190, 101),
      warning: rgb(226, 195, 146),
      error: rgb(195, 64, 67),
      info: rgb(122, 172, 194),
      dim: rgb(84, 88, 108),
      text: rgb(220, 215, 186),
      background: bgRgb(31, 31, 40),
      border: rgb(54, 55, 78),
      bold: "\x1b[1m",
      italic: "\x1b[3m",
      reset: "\x1b[0m",
    },
  },

  onedark: {
    name: "onedark",
    description: "One Dark color scheme",
    dark: true,
    colors: {
      primary: rgb(198, 120, 221),
      secondary: rgb(86, 182, 194),
      accent: rgb(229, 192, 123),
      success: rgb(152, 195, 121),
      warning: rgb(229, 192, 123),
      error: rgb(224, 108, 117),
      info: rgb(86, 182, 194),
      dim: rgb(92, 99, 112),
      text: rgb(171, 178, 191),
      background: bgRgb(40, 44, 52),
      border: rgb(62, 68, 81),
      bold: "\x1b[1m",
      italic: "\x1b[3m",
      reset: "\x1b[0m",
    },
  },

  ayu: {
    name: "ayu",
    description: "Ayu Dark color scheme",
    dark: true,
    colors: {
      primary: rgb(57, 186, 230),
      secondary: rgb(149, 230, 203),
      accent: rgb(255, 180, 84),
      success: rgb(170, 217, 76),
      warning: rgb(255, 180, 84),
      error: rgb(255, 51, 51),
      info: rgb(57, 186, 230),
      dim: rgb(107, 114, 128),
      text: rgb(203, 203, 194),
      background: bgRgb(15, 20, 25),
      border: rgb(60, 63, 72),
      bold: "\x1b[1m",
      italic: "\x1b[3m",
      reset: "\x1b[0m",
    },
  },

  matrix: {
    name: "matrix",
    description: "Matrix green-on-black hacker theme",
    dark: true,
    colors: {
      primary: rgb(0, 255, 0),
      secondary: rgb(0, 220, 0),
      accent: rgb(0, 255, 80),
      success: rgb(0, 255, 0),
      warning: rgb(0, 255, 120),
      error: rgb(255, 0, 0),
      info: rgb(0, 230, 0),
      dim: rgb(0, 100, 0),
      text: rgb(0, 200, 0),
      background: bgRgb(0, 0, 0),
      border: rgb(0, 80, 0),
      bold: "\x1b[1m",
      italic: "\x1b[3m",
      reset: "\x1b[0m",
    },
  },

  minimal: {
    name: "minimal",
    description: "Minimal grayscale theme",
    dark: true,
    colors: {
      primary: rgb(200, 200, 200),
      secondary: rgb(170, 170, 170),
      accent: rgb(220, 220, 220),
      success: rgb(180, 180, 180),
      warning: rgb(190, 190, 190),
      error: rgb(240, 240, 240),
      info: rgb(160, 160, 160),
      dim: rgb(100, 100, 100),
      text: rgb(180, 180, 180),
      background: bgRgb(30, 30, 30),
      border: rgb(70, 70, 70),
      bold: "\x1b[1m",
      italic: "\x1b[3m",
      reset: "\x1b[0m",
    },
  },
};

export class ThemeManager {
  private currentTheme: Theme;
  private customThemes: Map<string, Theme> = new Map();

  constructor(themeName?: string) {
    this.currentTheme =
      BUILT_IN_THEMES[themeName ?? "default"] ?? BUILT_IN_THEMES.default;
  }

  get(): Theme {
    return this.currentTheme;
  }

  colors(): ThemeColors {
    return this.currentTheme.colors;
  }

  switch(name: string): boolean {
    const theme =
      BUILT_IN_THEMES[name] ?? this.customThemes.get(name) ?? null;
    if (!theme) return false;
    this.currentTheme = theme;
    return true;
  }

  list(): string[] {
    return [
      ...Object.keys(BUILT_IN_THEMES),
      ...this.customThemes.keys(),
    ];
  }

  register(theme: Theme): void {
    this.customThemes.set(theme.name, theme);
  }

  async loadFromDir(dir: string): Promise<number> {
    let loaded = 0;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return 0;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const filePath = join(dir, entry);
        const raw = await Bun.file(filePath).text();
        const data = JSON.parse(raw) as {
          name?: string;
          description?: string;
          dark?: boolean;
          colors?: Record<string, string>;
        };

        if (!data.name || !data.colors) continue;

        const colorKeys: (keyof ThemeColors)[] = [
          "primary",
          "secondary",
          "accent",
          "success",
          "warning",
          "error",
          "info",
          "dim",
          "text",
          "background",
          "border",
        ];

        const colors: Partial<ThemeColors> = {
          bold: "\x1b[1m",
          italic: "\x1b[3m",
          reset: "\x1b[0m",
        };

        for (const key of colorKeys) {
          const value = data.colors[key];
          if (typeof value === "string") {
            if (key === "background") {
              const parsed = ThemeManager.parseHexRgb(value);
              if (parsed) {
                colors[key] = bgRgb(parsed.r, parsed.g, parsed.b);
              } else {
                colors[key] = value;
              }
            } else {
              colors[key] = ThemeManager.hexToAnsi(value);
            }
          }
        }

        const theme: Theme = {
          name: data.name,
          description: data.description ?? "",
          dark: data.dark ?? true,
          colors: colors as ThemeColors,
        };

        this.customThemes.set(theme.name, theme);
        loaded++;
      } catch {
        // Skip malformed files
      }
    }
    return loaded;
  }

  static detectBackground(): "dark" | "light" {
    const colorfgbg = process.env.COLORFGBG;
    if (!colorfgbg) return "dark";

    const parts = colorfgbg.split(";");
    const bg = parseInt(parts[parts.length - 1], 10);
    if (Number.isNaN(bg)) return "dark";

    // Standard terminal colors: 0-6 are dark, 7+ are light
    // In 256-color: values below 8 are dark, 8-15 are bright variants
    return bg >= 7 && bg <= 15 ? "light" : "dark";
  }

  static hexToAnsi(hex: string): string {
    const parsed = ThemeManager.parseHexRgb(hex);
    if (!parsed) return hex;
    return rgb(parsed.r, parsed.g, parsed.b);
  }

  private static parseHexRgb(
    hex: string,
  ): { r: number; g: number; b: number } | null {
    const cleaned = hex.replace(/^#/, "");
    if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) return null;
    const r = parseInt(cleaned.slice(0, 2), 16);
    const g = parseInt(cleaned.slice(2, 4), 16);
    const b = parseInt(cleaned.slice(4, 6), 16);
    return { r, g, b };
  }

  formatPreview(theme?: Theme): string {
    const t = theme ?? this.currentTheme;
    const c = t.colors;
    const lines: string[] = [];

    lines.push(
      `${c.bold}Theme: ${t.name}${c.reset} ${c.dim}(${t.description})${c.reset}`,
    );
    lines.push(`${c.dim}${"─".repeat(40)}${c.reset}`);
    lines.push(`${c.primary}primary${c.reset}     Sample text`);
    lines.push(`${c.secondary}secondary${c.reset}   Sample text`);
    lines.push(`${c.accent}accent${c.reset}      Sample text`);
    lines.push(`${c.success}success${c.reset}     Sample text`);
    lines.push(`${c.warning}warning${c.reset}     Sample text`);
    lines.push(`${c.error}error${c.reset}       Sample text`);
    lines.push(`${c.info}info${c.reset}        Sample text`);
    lines.push(`${c.dim}dim${c.reset}         Sample text`);
    lines.push(`${c.text}text${c.reset}        Sample text`);
    lines.push(`${c.border}border${c.reset}      Sample text`);
    lines.push(
      `${c.bold}bold${c.reset}  ${c.italic}italic${c.reset}  ${c.bold}${c.italic}bold+italic${c.reset}`,
    );
    lines.push(`${c.dim}Dark: ${t.dark ? "yes" : "no"}${c.reset}`);

    return lines.join("\n");
  }
}
