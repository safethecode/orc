/**
 * Convert markdown text to ANSI-escaped string for terminal display.
 * Handles: headers, bold, italic, inline code, code blocks, tables,
 * bullet lists, numbered lists, horizontal rules.
 */

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const WHITE = "\x1b[97m";
const BG_DIM = "\x1b[48;5;236m";

export function renderMarkdown(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = "";

  for (const line of lines) {
    // Code block toggle
    if (line.trimStart().startsWith("```")) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLang = line.trimStart().slice(3).trim();
        const label = codeBlockLang ? ` ${codeBlockLang} ` : "";
        result.push(`${DIM}${label}${"─".repeat(Math.max(0, 60 - label.length))}${RESET}`);
      } else {
        inCodeBlock = false;
        codeBlockLang = "";
        result.push(`${DIM}${"─".repeat(60)}${RESET}`);
      }
      continue;
    }

    // Inside code block — dim, no processing
    if (inCodeBlock) {
      result.push(`${BG_DIM} ${line} ${RESET}`);
      continue;
    }

    // Empty line
    if (!line.trim()) {
      result.push("");
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      result.push(`${DIM}${"─".repeat(60)}${RESET}`);
      continue;
    }

    // Headers
    const h3 = line.match(/^### (.+)/);
    if (h3) { result.push(`${BOLD}${h3[1]}${RESET}`); continue; }

    const h2 = line.match(/^## (.+)/);
    if (h2) { result.push(`\n${BOLD}${h2[1]}${RESET}`); continue; }

    const h1 = line.match(/^# (.+)/);
    if (h1) { result.push(`\n${BOLD}${WHITE}${h1[1]}${RESET}\n`); continue; }

    // Table row
    if (line.trimStart().startsWith("|") && line.trimEnd().endsWith("|")) {
      if (/^\|[\s-:|]+\|$/.test(line.trim())) {
        result.push(`${DIM}${"─".repeat(60)}${RESET}`);
        continue;
      }
      const cells = line.split("|").filter(Boolean).map(c => c.trim());
      const rendered = cells.map((cell, i) => {
        let c = cell;
        c = c.replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${RESET}`);
        c = c.replace(/`(.+?)`/g, `${CYAN}$1${RESET}`);
        return i === 0 ? `${BOLD}${c}${RESET}` : c;
      });
      result.push(`  ${rendered.join(`${DIM} │ ${RESET}`)}`);
      continue;
    }

    // Process inline formatting
    let processed = line;

    // Bullet list
    processed = processed.replace(/^(\s*)- /, `$1${DIM}•${RESET} `);
    processed = processed.replace(/^(\s*)\* /, `$1${DIM}•${RESET} `);

    // Numbered list
    processed = processed.replace(/^(\s*)(\d+)\. /, `$1${DIM}$2.${RESET} `);

    // Checkbox
    processed = processed.replace(/^(\s*)- \[x\] /i, `$1${GREEN}✓${RESET} `);
    processed = processed.replace(/^(\s*)- \[ \] /, `$1${DIM}○${RESET} `);

    // Bold
    processed = processed.replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${RESET}`);

    // Italic
    processed = processed.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, `${ITALIC}$1${RESET}`);

    // Inline code
    processed = processed.replace(/`(.+?)`/g, `${CYAN}$1${RESET}`);

    result.push(processed);
  }

  return result.join("\n");
}
