import { SyntaxStyle, type ThemeTokenStyle } from "@opentui/core";

/**
 * Markdown syntax themes for OpenTUI's <markdown> component.
 * Each theme defines colors for headings, bold, italic, code, links, etc.
 */

const THEMES: Record<string, ThemeTokenStyle[]> = {
  tokyo: [
    // Markdown
    { scope: ["heading", "markup.heading"], style: { foreground: "#c0caf5", bold: true } },
    { scope: ["markup.bold", "strong"], style: { foreground: "#c0caf5", bold: true } },
    { scope: ["markup.italic", "emphasis"], style: { foreground: "#bb9af7", italic: true } },
    { scope: ["markup.inline.raw", "markup.raw", "code"], style: { foreground: "#7dcfff" } },
    { scope: ["markup.fenced_code", "fenced_code"], style: { foreground: "#a9b1d6" } },
    { scope: ["markup.link", "link"], style: { foreground: "#7aa2f7", underline: true } },
    { scope: ["markup.list", "list"], style: { foreground: "#e0af68" } },
    { scope: ["markup.quote", "blockquote"], style: { foreground: "#565f89", italic: true } },
    { scope: ["punctuation", "markup.punctuation"], style: { foreground: "#565f89", dim: true } },
    // Code — tree-sitter scope names
    { scope: ["string", "string.special"], style: { foreground: "#9ece6a" } },
    { scope: ["keyword", "keyword.return", "keyword.function", "keyword.import", "keyword.type", "keyword.modifier", "keyword.operator", "keyword.conditional", "keyword.repeat", "keyword.exception"], style: { foreground: "#bb9af7" } },
    { scope: ["variable", "variable.member", "variable.parameter"], style: { foreground: "#c0caf5" } },
    { scope: ["function", "function.call", "function.method", "function.method.call", "function.builtin"], style: { foreground: "#7aa2f7" } },
    { scope: ["comment", "comment.documentation"], style: { foreground: "#565f89", italic: true } },
    { scope: ["number", "constant", "constant.builtin", "boolean"], style: { foreground: "#ff9e64" } },
    { scope: ["type", "type.builtin", "constructor"], style: { foreground: "#2ac3de" } },
    { scope: ["operator", "punctuation.bracket", "punctuation.delimiter"], style: { foreground: "#89ddff" } },
    { scope: ["attribute", "label", "module"], style: { foreground: "#7aa2f7" } },
    { scope: ["character.special"], style: { foreground: "#ff9e64" } },
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
    { scope: ["punctuation", "punctuation.bracket", "punctuation.delimiter"], style: { foreground: "#656d76" } },
    { scope: ["string", "string.special"], style: { foreground: "#0a3069" } },
    { scope: ["keyword", "keyword.return", "keyword.function", "keyword.import", "keyword.type", "keyword.modifier", "keyword.operator", "keyword.conditional", "keyword.repeat"], style: { foreground: "#cf222e" } },
    { scope: ["variable", "variable.member", "variable.parameter"], style: { foreground: "#953800" } },
    { scope: ["function", "function.call", "function.method", "function.method.call", "function.builtin"], style: { foreground: "#8250df" } },
    { scope: ["comment", "comment.documentation"], style: { foreground: "#656d76", italic: true } },
    { scope: ["number", "constant", "constant.builtin", "boolean"], style: { foreground: "#0550ae" } },
    { scope: ["type", "type.builtin", "constructor"], style: { foreground: "#0550ae" } },
    { scope: ["operator"], style: { foreground: "#cf222e" } },
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
    { scope: ["punctuation", "punctuation.bracket", "punctuation.delimiter"], style: { foreground: "#75715e" } },
    { scope: ["string", "string.special"], style: { foreground: "#e6db74" } },
    { scope: ["keyword", "keyword.return", "keyword.function", "keyword.import", "keyword.type", "keyword.modifier", "keyword.operator", "keyword.conditional", "keyword.repeat"], style: { foreground: "#f92672" } },
    { scope: ["variable", "variable.member", "variable.parameter"], style: { foreground: "#f8f8f2" } },
    { scope: ["function", "function.call", "function.method", "function.method.call", "function.builtin"], style: { foreground: "#a6e22e" } },
    { scope: ["comment", "comment.documentation"], style: { foreground: "#75715e", italic: true } },
    { scope: ["number", "constant", "constant.builtin", "boolean"], style: { foreground: "#ae81ff" } },
    { scope: ["type", "type.builtin", "constructor"], style: { foreground: "#66d9ef", italic: true } },
    { scope: ["operator"], style: { foreground: "#f92672" } },
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
    { scope: ["punctuation", "punctuation.bracket", "punctuation.delimiter"], style: { foreground: "#6c7086" } },
    { scope: ["string", "string.special"], style: { foreground: "#a6e3a1" } },
    { scope: ["keyword", "keyword.return", "keyword.function", "keyword.import", "keyword.type", "keyword.modifier", "keyword.operator", "keyword.conditional", "keyword.repeat"], style: { foreground: "#cba6f7" } },
    { scope: ["variable", "variable.member", "variable.parameter"], style: { foreground: "#cdd6f4" } },
    { scope: ["function", "function.call", "function.method", "function.method.call", "function.builtin"], style: { foreground: "#89b4fa" } },
    { scope: ["comment", "comment.documentation"], style: { foreground: "#6c7086", italic: true } },
    { scope: ["number", "constant", "constant.builtin", "boolean"], style: { foreground: "#fab387" } },
    { scope: ["type", "type.builtin", "constructor"], style: { foreground: "#89dceb" } },
    { scope: ["operator"], style: { foreground: "#94e2d5" } },
  ],
};

let currentStyle: SyntaxStyle | null = null;
let currentThemeName = "tokyo";

export function getMarkdownSyntaxStyle(): SyntaxStyle {
  if (!currentStyle) {
    const theme = THEMES[currentThemeName] ?? THEMES.tokyo;
    currentStyle = SyntaxStyle.fromTheme(theme);

    // Register markdown-specific conceal scopes that OpenTUI's parser expects
    const concealScopes = [
      "markup.heading.marker",
      "markup.list.marker",
      "markup.bold.delimiter",
      "markup.italic.delimiter",
      "markup.raw.delimiter",
      "markup.link.delimiter",
      "markup.quote.marker",
    ];
    for (const scope of concealScopes) {
      if (!currentStyle.getStyle(scope)) {
        currentStyle.registerStyle(scope, { dim: true });
      }
    }
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
