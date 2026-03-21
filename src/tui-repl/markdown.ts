/**
 * Convert markdown text to ANSI-escaped string for terminal display.
 * Supports themes for customizable colors.
 */

export interface MarkdownTheme {
  bold: string;
  dim: string;
  italic: string;
  reset: string;
  heading: string;
  headingSub: string;
  inlineCode: string;
  codeBlockBg: string;
  codeBlockLabel: string;
  bullet: string;
  checkbox: string;
  checkboxDone: string;
  tableDelim: string;
  rule: string;
}

const THEMES: Record<string, MarkdownTheme> = {
  tokyo: {
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    italic: "\x1b[3m",
    reset: "\x1b[0m",
    heading: "\x1b[1;97m",        // bold white
    headingSub: "\x1b[1m",        // bold
    inlineCode: "\x1b[36m",       // cyan
    codeBlockBg: "\x1b[48;5;236m",
    codeBlockLabel: "\x1b[2;33m", // dim yellow
    bullet: "\x1b[2m",
    checkbox: "\x1b[2m",
    checkboxDone: "\x1b[32m",     // green
    tableDelim: "\x1b[2m",
    rule: "\x1b[2m",
  },
  github: {
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    italic: "\x1b[3m",
    reset: "\x1b[0m",
    heading: "\x1b[1;34m",        // bold blue
    headingSub: "\x1b[1;34m",
    inlineCode: "\x1b[38;5;203m", // salmon
    codeBlockBg: "\x1b[48;5;235m",
    codeBlockLabel: "\x1b[2;36m",
    bullet: "\x1b[33m",           // yellow
    checkbox: "\x1b[2m",
    checkboxDone: "\x1b[32m",
    tableDelim: "\x1b[2m",
    rule: "\x1b[2m",
  },
  monokai: {
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    italic: "\x1b[3m",
    reset: "\x1b[0m",
    heading: "\x1b[1;38;5;208m",  // bold orange
    headingSub: "\x1b[1;38;5;148m", // bold green
    inlineCode: "\x1b[38;5;141m", // purple
    codeBlockBg: "\x1b[48;5;237m",
    codeBlockLabel: "\x1b[38;5;75m",
    bullet: "\x1b[38;5;208m",
    checkbox: "\x1b[2m",
    checkboxDone: "\x1b[38;5;148m",
    tableDelim: "\x1b[2m",
    rule: "\x1b[38;5;242m",
  },
  catppuccin: {
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    italic: "\x1b[3m",
    reset: "\x1b[0m",
    heading: "\x1b[1;38;5;183m",  // bold lavender
    headingSub: "\x1b[1;38;5;117m", // bold sky
    inlineCode: "\x1b[38;5;180m", // peach
    codeBlockBg: "\x1b[48;5;235m",
    codeBlockLabel: "\x1b[38;5;152m",
    bullet: "\x1b[38;5;183m",
    checkbox: "\x1b[38;5;245m",
    checkboxDone: "\x1b[38;5;114m", // green
    tableDelim: "\x1b[38;5;245m",
    rule: "\x1b[38;5;240m",
  },
};

let currentTheme: MarkdownTheme = THEMES.tokyo;

export function setMarkdownTheme(name: string): boolean {
  const theme = THEMES[name];
  if (!theme) return false;
  currentTheme = theme;
  return true;
}

export function getMarkdownThemes(): string[] {
  return Object.keys(THEMES);
}

export function renderMarkdown(text: string): string {
  const t = currentTheme;
  const lines = text.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        const lang = line.trimStart().slice(3).trim();
        const label = lang ? ` ${lang} ` : "";
        result.push(`${t.codeBlockLabel}${label}${"─".repeat(Math.max(0, 60 - label.length))}${t.reset}`);
      } else {
        inCodeBlock = false;
        result.push(`${t.rule}${"─".repeat(60)}${t.reset}`);
      }
      continue;
    }

    if (inCodeBlock) { result.push(`${t.codeBlockBg} ${line} ${t.reset}`); continue; }
    if (!line.trim()) { result.push(""); continue; }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      result.push(`${t.rule}${"─".repeat(60)}${t.reset}`);
      continue;
    }

    const h3 = line.match(/^### (.+)/);
    if (h3) { result.push(`${t.headingSub}${h3[1]}${t.reset}`); continue; }
    const h2 = line.match(/^## (.+)/);
    if (h2) { result.push(`\n${t.headingSub}${h2[1]}${t.reset}`); continue; }
    const h1 = line.match(/^# (.+)/);
    if (h1) { result.push(`\n${t.heading}${h1[1]}${t.reset}\n`); continue; }

    if (line.trimStart().startsWith("|") && line.trimEnd().endsWith("|")) {
      if (/^\|[\s-:|]+\|$/.test(line.trim())) {
        result.push(`${t.tableDelim}${"─".repeat(60)}${t.reset}`);
        continue;
      }
      const cells = line.split("|").filter(Boolean).map(c => c.trim());
      const rendered = cells.map((cell, i) => {
        let c = cell;
        c = c.replace(/\*\*(.+?)\*\*/g, `${t.bold}$1${t.reset}`);
        c = c.replace(/`(.+?)`/g, `${t.inlineCode}$1${t.reset}`);
        return i === 0 ? `${t.bold}${c}${t.reset}` : c;
      });
      result.push(`  ${rendered.join(`${t.tableDelim} │ ${t.reset}`)}`);
      continue;
    }

    let p = line;
    p = p.replace(/^(\s*)- \[x\] /i, `$1${t.checkboxDone}✓${t.reset} `);
    p = p.replace(/^(\s*)- \[ \] /, `$1${t.checkbox}○${t.reset} `);
    p = p.replace(/^(\s*)[-*] /, `$1${t.bullet}•${t.reset} `);
    p = p.replace(/^(\s*)(\d+)\. /, `$1${t.dim}$2.${t.reset} `);
    p = p.replace(/\*\*(.+?)\*\*/g, `${t.bold}$1${t.reset}`);
    p = p.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, `${t.italic}$1${t.reset}`);
    p = p.replace(/`(.+?)`/g, `${t.inlineCode}$1${t.reset}`);
    result.push(p);
  }

  return result.join("\n");
}
