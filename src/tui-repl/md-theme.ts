import { SyntaxStyle, type ThemeTokenStyle } from "@opentui/core";

/**
 * Markdown syntax themes for OpenTUI's <markdown> component.
 * Each theme defines colors for headings, bold, italic, code, links, etc.
 */

const THEMES: Record<string, ThemeTokenStyle[]> = {
  tokyo: [
    { scope: ["heading", "markup.heading"], style: { foreground: "#c0caf5", bold: true } },
    { scope: ["markup.bold", "strong"], style: { foreground: "#c0caf5", bold: true } },
    { scope: ["markup.italic", "emphasis"], style: { foreground: "#bb9af7", italic: true } },
    { scope: ["markup.inline.raw", "markup.raw", "code"], style: { foreground: "#7dcfff" } },
    { scope: ["markup.fenced_code", "fenced_code"], style: { foreground: "#a9b1d6" } },
    { scope: ["markup.link", "link"], style: { foreground: "#7aa2f7", underline: true } },
    { scope: ["markup.list", "list"], style: { foreground: "#e0af68" } },
    { scope: ["markup.quote", "blockquote"], style: { foreground: "#565f89", italic: true } },
    { scope: ["punctuation", "markup.punctuation"], style: { foreground: "#565f89", dim: true } },
    { scope: ["string"], style: { foreground: "#9ece6a" } },
    { scope: ["keyword"], style: { foreground: "#bb9af7" } },
    { scope: ["variable"], style: { foreground: "#c0caf5" } },
    { scope: ["function"], style: { foreground: "#7aa2f7" } },
    { scope: ["comment"], style: { foreground: "#565f89", italic: true } },
    { scope: ["number", "constant"], style: { foreground: "#ff9e64" } },
    { scope: ["type"], style: { foreground: "#2ac3de" } },
  ],
  github: [
    { scope: ["heading", "markup.heading"], style: { foreground: "#0969da", bold: true } },
    { scope: ["markup.bold", "strong"], style: { foreground: "#1f2328", bold: true } },
    { scope: ["markup.italic", "emphasis"], style: { foreground: "#1f2328", italic: true } },
    { scope: ["markup.inline.raw", "markup.raw", "code"], style: { foreground: "#cf222e" } },
    { scope: ["markup.fenced_code", "fenced_code"], style: { foreground: "#1f2328" } },
    { scope: ["markup.link", "link"], style: { foreground: "#0969da", underline: true } },
    { scope: ["markup.list", "list"], style: { foreground: "#e16f24" } },
    { scope: ["markup.quote", "blockquote"], style: { foreground: "#656d76", italic: true } },
    { scope: ["punctuation"], style: { foreground: "#656d76" } },
    { scope: ["string"], style: { foreground: "#0a3069" } },
    { scope: ["keyword"], style: { foreground: "#cf222e" } },
    { scope: ["variable"], style: { foreground: "#953800" } },
    { scope: ["function"], style: { foreground: "#8250df" } },
    { scope: ["comment"], style: { foreground: "#656d76", italic: true } },
    { scope: ["number", "constant"], style: { foreground: "#0550ae" } },
    { scope: ["type"], style: { foreground: "#0550ae" } },
  ],
  monokai: [
    { scope: ["heading", "markup.heading"], style: { foreground: "#f92672", bold: true } },
    { scope: ["markup.bold", "strong"], style: { foreground: "#f8f8f2", bold: true } },
    { scope: ["markup.italic", "emphasis"], style: { foreground: "#e6db74", italic: true } },
    { scope: ["markup.inline.raw", "markup.raw", "code"], style: { foreground: "#ae81ff" } },
    { scope: ["markup.fenced_code", "fenced_code"], style: { foreground: "#f8f8f2" } },
    { scope: ["markup.link", "link"], style: { foreground: "#66d9ef", underline: true } },
    { scope: ["markup.list", "list"], style: { foreground: "#f92672" } },
    { scope: ["markup.quote", "blockquote"], style: { foreground: "#75715e", italic: true } },
    { scope: ["punctuation"], style: { foreground: "#75715e" } },
    { scope: ["string"], style: { foreground: "#e6db74" } },
    { scope: ["keyword"], style: { foreground: "#f92672" } },
    { scope: ["variable"], style: { foreground: "#f8f8f2" } },
    { scope: ["function"], style: { foreground: "#a6e22e" } },
    { scope: ["comment"], style: { foreground: "#75715e", italic: true } },
    { scope: ["number", "constant"], style: { foreground: "#ae81ff" } },
    { scope: ["type"], style: { foreground: "#66d9ef", italic: true } },
  ],
  catppuccin: [
    { scope: ["heading", "markup.heading"], style: { foreground: "#cba6f7", bold: true } },
    { scope: ["markup.bold", "strong"], style: { foreground: "#cdd6f4", bold: true } },
    { scope: ["markup.italic", "emphasis"], style: { foreground: "#f5c2e7", italic: true } },
    { scope: ["markup.inline.raw", "markup.raw", "code"], style: { foreground: "#fab387" } },
    { scope: ["markup.fenced_code", "fenced_code"], style: { foreground: "#cdd6f4" } },
    { scope: ["markup.link", "link"], style: { foreground: "#89b4fa", underline: true } },
    { scope: ["markup.list", "list"], style: { foreground: "#cba6f7" } },
    { scope: ["markup.quote", "blockquote"], style: { foreground: "#6c7086", italic: true } },
    { scope: ["punctuation"], style: { foreground: "#6c7086" } },
    { scope: ["string"], style: { foreground: "#a6e3a1" } },
    { scope: ["keyword"], style: { foreground: "#cba6f7" } },
    { scope: ["variable"], style: { foreground: "#cdd6f4" } },
    { scope: ["function"], style: { foreground: "#89b4fa" } },
    { scope: ["comment"], style: { foreground: "#6c7086", italic: true } },
    { scope: ["number", "constant"], style: { foreground: "#fab387" } },
    { scope: ["type"], style: { foreground: "#89dceb" } },
  ],
};

let currentStyle: SyntaxStyle | null = null;
let currentThemeName = "tokyo";

export function getMarkdownSyntaxStyle(): SyntaxStyle {
  if (!currentStyle) {
    currentStyle = SyntaxStyle.fromTheme(THEMES[currentThemeName] ?? THEMES.tokyo);
  }
  return currentStyle;
}

export function setMdTheme(name: string): boolean {
  if (!THEMES[name]) return false;
  currentThemeName = name;
  if (currentStyle) {
    currentStyle.destroy();
    currentStyle = null;
  }
  return true;
}

export function getMdThemes(): string[] {
  return Object.keys(THEMES);
}

export function getCurrentMdTheme(): string {
  return currentThemeName;
}
