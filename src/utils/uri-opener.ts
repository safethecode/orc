export type EditorType = "vscode" | "cursor" | "windsurf" | "default";

export function detectEditor(): EditorType {
  const term = process.env.TERM_PROGRAM?.toLowerCase() ?? "";
  const visual = process.env.VISUAL?.toLowerCase() ?? "";

  if (term.includes("cursor") || visual.includes("cursor")) return "cursor";
  if (term.includes("vscode") || visual.includes("code")) return "vscode";
  if (term.includes("windsurf") || visual.includes("windsurf"))
    return "windsurf";

  return "default";
}

export function fileUri(
  filePath: string,
  line?: number,
  editor?: EditorType,
): string {
  const ed = editor ?? detectEditor();
  const suffix = line ? `:${line}` : "";

  switch (ed) {
    case "vscode":
      return `vscode://file${filePath}${suffix}`;
    case "cursor":
      return `cursor://file${filePath}${suffix}`;
    case "windsurf":
      return `windsurf://file${filePath}${suffix}`;
    default:
      return `file://${filePath}`;
  }
}

export function hyperlink(text: string, uri: string): string {
  return `\x1b]8;;${uri}\x07${text}\x1b]8;;\x07`;
}
