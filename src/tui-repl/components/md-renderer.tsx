/** @jsxImportSource @opentui/react */
import { getCurrentMdTheme, getMarkdownSyntaxStyle } from "../md-theme.ts";

// Theme color palettes
const PALETTES: Record<string, { heading: string; headingSub: string; bold: string; italic: string; code: string; codeBg: string; link: string; quote: string; quoteBorder: string; bullet: string; dim: string; text: string; hr: string }> = {
  tokyo:      { heading: "#c0caf5", headingSub: "#7aa2f7", bold: "#c0caf5", italic: "#bb9af7", code: "#7dcfff", codeBg: "#1a1b26", link: "#7aa2f7", quote: "#9aa5ce", quoteBorder: "#3d59a1", bullet: "#e0af68", dim: "#565f89", text: "#a9b1d6", hr: "#3d4262" },
  github:     { heading: "#0969da", headingSub: "#0969da", bold: "#1f2328", italic: "#1f2328", code: "#cf222e", codeBg: "#f6f8fa", link: "#0969da", quote: "#656d76", quoteBorder: "#d0d7de", bullet: "#e16f24", dim: "#656d76", text: "#1f2328", hr: "#d0d7de" },
  monokai:    { heading: "#f92672", headingSub: "#a6e22e", bold: "#f8f8f2", italic: "#e6db74", code: "#ae81ff", codeBg: "#3e3d32", link: "#66d9ef", quote: "#75715e", quoteBorder: "#75715e", bullet: "#f92672", dim: "#75715e", text: "#f8f8f2", hr: "#75715e" },
  catppuccin: { heading: "#cba6f7", headingSub: "#89b4fa", bold: "#cdd6f4", italic: "#f5c2e7", code: "#fab387", codeBg: "#1e1e2e", link: "#89b4fa", quote: "#a6adc8", quoteBorder: "#585b70", bullet: "#cba6f7", dim: "#6c7086", text: "#cdd6f4", hr: "#585b70" },
};

function getPalette() {
  return PALETTES[getCurrentMdTheme()] ?? PALETTES.tokyo;
}

interface MdProps {
  content: string;
}

interface ParsedBlock {
  type: "heading" | "paragraph" | "code" | "quote" | "list" | "hr" | "table";
  level?: number;
  lang?: string;
  lines: string[];
  ordered?: boolean;
}

function parseBlocks(text: string): ParsedBlock[] {
  const lines = text.split("\n");
  const blocks: ParsedBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.trimStart().startsWith("```")) {
      const lang = line.trimStart().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: "code", lang, lines: codeLines });
      i++;
      continue;
    }

    // Heading
    const hMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (hMatch) {
      blocks.push({ type: "heading", level: hMatch[1].length, lines: [hMatch[2]] });
      i++;
      continue;
    }

    // HR
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      blocks.push({ type: "hr", lines: [] });
      i++;
      continue;
    }

    // Blockquote
    if (line.trimStart().startsWith("> ")) {
      const quoteLines: string[] = [];
      while (i < lines.length && (lines[i].trimStart().startsWith("> ") || lines[i].trimStart().startsWith(">"))) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "quote", lines: quoteLines });
      continue;
    }

    // Table
    if (line.includes("|") && i + 1 < lines.length && /^\|[\s-:|]+\|$/.test(lines[i + 1]?.trim() ?? "")) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].includes("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: "table", lines: tableLines });
      continue;
    }

    // List (bullet or numbered)
    if (/^\s*[-*]\s/.test(line) || /^\s*\d+\.\s/.test(line)) {
      const listLines: string[] = [];
      const ordered = /^\s*\d+\.\s/.test(line);
      while (i < lines.length && (/^\s*[-*]\s/.test(lines[i]) || /^\s*\d+\.\s/.test(lines[i]) || /^\s{2,}/.test(lines[i]))) {
        listLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: "list", ordered, lines: listLines });
      continue;
    }

    // Empty line
    if (!line.trim()) { i++; continue; }

    // Paragraph
    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trim() && !lines[i].startsWith("#") && !lines[i].startsWith("```") && !lines[i].startsWith("> ") && !/^(-{3,}|\*{3,})$/.test(lines[i].trim())) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push({ type: "paragraph", lines: paraLines });
    }
  }
  return blocks;
}

function InlineText({ text }: { text: string }) {
  const p = getPalette();
  // Split into segments: bold, italic, code, link, plain
  const segments: Array<{ type: string; content: string; url?: string }> = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Bold
    const boldMatch = remaining.match(/\*\*(.+?)\*\*/);
    // Inline code
    const codeMatch = remaining.match(/`(.+?)`/);
    // Italic
    const italicMatch = remaining.match(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/);
    // Link
    const linkMatch = remaining.match(/\[(.+?)\]\((.+?)\)/);

    // Find earliest match
    const matches = [
      boldMatch && { idx: boldMatch.index!, len: boldMatch[0].length, type: "bold", content: boldMatch[1] },
      codeMatch && { idx: codeMatch.index!, len: codeMatch[0].length, type: "code", content: codeMatch[1] },
      italicMatch && { idx: italicMatch.index!, len: italicMatch[0].length, type: "italic", content: italicMatch[1] },
      linkMatch && { idx: linkMatch.index!, len: linkMatch[0].length, type: "link", content: linkMatch[1], url: linkMatch[2] },
    ].filter(Boolean).sort((a, b) => a!.idx - b!.idx);

    if (matches.length === 0) {
      segments.push({ type: "plain", content: remaining });
      break;
    }

    const first = matches[0]!;
    if (first.idx > 0) {
      segments.push({ type: "plain", content: remaining.slice(0, first.idx) });
    }
    segments.push({ type: first.type, content: first.content, url: (first as any).url });
    remaining = remaining.slice(first.idx + first.len);
  }

  return (
    <box flexDirection="row" flexWrap="wrap">
      {segments.map((seg, i) => {
        switch (seg.type) {
          case "bold": return <text key={i} bold fg={p.bold}>{seg.content}</text>;
          case "italic": return <text key={i} italic fg={p.italic}>{seg.content}</text>;
          case "code": return <text key={i} fg={p.code} bg={p.codeBg}>{` ${seg.content} `}</text>;
          case "link": return <text key={i} fg={p.link} underline>{seg.content}</text>;
          default: return <text key={i} fg={p.text}>{seg.content}</text>;
        }
      })}
    </box>
  );
}

export function MarkdownContent({ content }: MdProps) {
  const p = getPalette();
  const blocks = parseBlocks(content);

  return (
    <box flexDirection="column">
      {blocks.map((block, i) => {
        switch (block.type) {
          case "heading":
            return (
              <box key={i} paddingBottom={block.level === 1 ? 1 : 0}>
                <text bold fg={block.level === 1 ? p.heading : p.headingSub}>
                  {block.lines[0]}
                </text>
              </box>
            );

          case "paragraph":
            return (
              <box key={i} paddingBottom={1}>
                <InlineText text={block.lines.join(" ")} />
              </box>
            );

          case "code":
            return (
              <box key={i} paddingBottom={1} flexDirection="column">
                {block.lang && <text fg={p.dim} italic>{` ${block.lang}`}</text>}
                <box border borderColor={p.hr} borderStyle="single" padding={1} bg={p.codeBg}>
                  <code content={block.lines.join("\n")} filetype={block.lang || "text"} syntaxStyle={getMarkdownSyntaxStyle()} />
                </box>
              </box>
            );

          case "quote":
            return (
              <box key={i} paddingBottom={1} flexDirection="row">
                <text fg={p.quoteBorder}>{"┃ "}</text>
                <box flexDirection="column">
                  {block.lines.map((l, j) => (
                    <text key={j} fg={p.quote} italic>{l}</text>
                  ))}
                </box>
              </box>
            );

          case "hr":
            return (
              <box key={i} paddingTop={1} paddingBottom={1}>
                <text fg={p.hr}>{"─".repeat(60)}</text>
              </box>
            );

          case "list":
            return (
              <box key={i} paddingBottom={1} flexDirection="column">
                {block.lines.map((l, j) => {
                  const indent = l.match(/^(\s*)/)?.[1]?.length ?? 0;
                  const cleaned = l.replace(/^\s*[-*]\s/, "").replace(/^\s*\d+\.\s/, "");
                  const marker = block.ordered ? `${j + 1}.` : "•";
                  return (
                    <box key={j} flexDirection="row" paddingLeft={indent}>
                      <text fg={p.bullet}>{`${marker} `}</text>
                      <InlineText text={cleaned} />
                    </box>
                  );
                })}
              </box>
            );

          case "table":
            return (
              <box key={i} paddingBottom={1}>
                <markdown
                  content={block.lines.join("\n")}
                  syntaxStyle={getMarkdownSyntaxStyle()}
                  conceal
                />
              </box>
            );

          default:
            return <text key={i} fg={p.text}>{block.lines.join("\n")}</text>;
        }
      })}
    </box>
  );
}
