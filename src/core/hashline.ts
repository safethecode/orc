// 2-char hash dictionary (256 entries)
const HASH_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

export interface HashLine {
  lineNumber: number;
  hash: string;       // 2-char hash
  content: string;
}

export interface HashEdit {
  operation: "replace" | "insert_after" | "insert_before" | "delete";
  anchor: string;      // "LINE#HASH" format, e.g. "15#VK"
  endAnchor?: string;  // for range operations, e.g. "20#XJ"
  newContent?: string; // for replace/insert operations
}

export interface HashEditResult {
  success: boolean;
  file: string;
  linesChanged: number;
  error?: string;      // e.g. "Hash mismatch at line 15: expected VK, got AB"
}

// Fallback hash for non-Bun environments
function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash;
}

export class HashlineEditor {
  /**
   * Compute hash for a line. Uses xxHash32 (via Bun.hash) on whitespace-stripped content.
   * For blank/trivial lines, seed with line number to ensure uniqueness.
   */
  static computeHash(content: string, lineNumber: number): string {
    const stripped = content.replace(/\s+/g, "");
    // Use line number as seed for empty/trivial lines
    const input = stripped.length > 0 ? stripped : `__blank_${lineNumber}`;
    // Bun.hash returns a number
    const hashNum = typeof Bun !== "undefined"
      ? Number(Bun.hash(input))
      : simpleHash(input);
    const idx1 = Math.abs(hashNum) % HASH_CHARS.length;
    const idx2 = Math.abs(Math.floor(hashNum / HASH_CHARS.length)) % HASH_CHARS.length;
    return HASH_CHARS[idx1] + HASH_CHARS[idx2];
  }

  /**
   * Annotate file content with LINE#HASH markers.
   * Returns array of HashLine objects.
   */
  static annotate(content: string): HashLine[] {
    const rawLines = content.split("\n");
    const result: HashLine[] = [];

    for (let i = 0; i < rawLines.length; i++) {
      const lineNumber = i + 1;
      const hash = HashlineEditor.computeHash(rawLines[i], lineNumber);
      result.push({ lineNumber, hash, content: rawLines[i] });
    }

    return result;
  }

  /**
   * Format annotated content for display.
   * Produces "LINE#HASH| content" format with padded line numbers.
   * Example: " 11#VK| function hello() {"
   */
  static formatAnnotated(lines: HashLine[]): string {
    if (lines.length === 0) return "";

    const maxLineNum = lines[lines.length - 1].lineNumber;
    const padWidth = String(maxLineNum).length;

    return lines
      .map((l) => {
        const paddedNum = String(l.lineNumber).padStart(padWidth, " ");
        return `${paddedNum}#${l.hash}| ${l.content}`;
      })
      .join("\n");
  }

  /**
   * Parse an anchor string "LINE#HASH" into { line, hash }.
   * Returns null if the format is invalid.
   */
  static parseAnchor(anchor: string): { line: number; hash: string } | null {
    const match = anchor.match(/^(\d+)#([A-Za-z0-9]{2})$/);
    if (!match) return null;
    return { line: parseInt(match[1], 10), hash: match[2] };
  }

  /**
   * Validate that a hash matches the current file content at that line.
   * Returns { valid: true } if matching, or { valid: false, expected, actual } on mismatch.
   */
  static validateAnchor(
    anchor: string,
    content: string,
  ): { valid: boolean; expected?: string; actual?: string } {
    const parsed = HashlineEditor.parseAnchor(anchor);
    if (!parsed) {
      return { valid: false, expected: undefined, actual: undefined };
    }

    const lines = content.split("\n");
    const lineIndex = parsed.line - 1;

    if (lineIndex < 0 || lineIndex >= lines.length) {
      return { valid: false, expected: parsed.hash, actual: undefined };
    }

    const actualHash = HashlineEditor.computeHash(lines[lineIndex], parsed.line);

    if (actualHash === parsed.hash) {
      return { valid: true };
    }

    return { valid: false, expected: parsed.hash, actual: actualHash };
  }

  /**
   * Apply a hash-anchored edit to file content.
   * Validates hashes before applying. Returns error if hash mismatch.
   */
  static applyEdit(
    content: string,
    edit: HashEdit,
  ): { result: string; linesChanged: number } | { error: string } {
    const lines = content.split("\n");

    // Validate primary anchor
    const startParsed = HashlineEditor.parseAnchor(edit.anchor);
    if (!startParsed) {
      return { error: `Invalid anchor format: ${edit.anchor}` };
    }

    const startValidation = HashlineEditor.validateAnchor(edit.anchor, content);
    if (!startValidation.valid) {
      if (startValidation.actual === undefined) {
        return { error: `Line ${startParsed.line} is out of range (file has ${lines.length} lines)` };
      }
      return {
        error: `Hash mismatch at line ${startParsed.line}: expected ${startValidation.expected}, got ${startValidation.actual}`,
      };
    }

    // Validate end anchor if present (for range operations)
    let endLine = startParsed.line;
    if (edit.endAnchor) {
      const endParsed = HashlineEditor.parseAnchor(edit.endAnchor);
      if (!endParsed) {
        return { error: `Invalid end anchor format: ${edit.endAnchor}` };
      }

      const endValidation = HashlineEditor.validateAnchor(edit.endAnchor, content);
      if (!endValidation.valid) {
        if (endValidation.actual === undefined) {
          return { error: `Line ${endParsed.line} is out of range (file has ${lines.length} lines)` };
        }
        return {
          error: `Hash mismatch at line ${endParsed.line}: expected ${endValidation.expected}, got ${endValidation.actual}`,
        };
      }

      endLine = endParsed.line;

      if (endLine < startParsed.line) {
        return { error: `End anchor line ${endLine} is before start anchor line ${startParsed.line}` };
      }
    }

    const startIndex = startParsed.line - 1;
    const endIndex = endLine - 1;

    switch (edit.operation) {
      case "replace": {
        if (edit.newContent === undefined) {
          return { error: "Replace operation requires newContent" };
        }
        const newLines = edit.newContent.split("\n");
        const removedCount = endIndex - startIndex + 1;
        lines.splice(startIndex, removedCount, ...newLines);
        return {
          result: lines.join("\n"),
          linesChanged: Math.abs(newLines.length - removedCount) + Math.min(newLines.length, removedCount),
        };
      }

      case "insert_after": {
        if (edit.newContent === undefined) {
          return { error: "Insert operation requires newContent" };
        }
        const newLines = edit.newContent.split("\n");
        lines.splice(endIndex + 1, 0, ...newLines);
        return { result: lines.join("\n"), linesChanged: newLines.length };
      }

      case "insert_before": {
        if (edit.newContent === undefined) {
          return { error: "Insert operation requires newContent" };
        }
        const newLines = edit.newContent.split("\n");
        lines.splice(startIndex, 0, ...newLines);
        return { result: lines.join("\n"), linesChanged: newLines.length };
      }

      case "delete": {
        const removedCount = endIndex - startIndex + 1;
        lines.splice(startIndex, removedCount);
        return { result: lines.join("\n"), linesChanged: removedCount };
      }

      default:
        return { error: `Unknown operation: ${(edit as HashEdit).operation}` };
    }
  }

  /**
   * Apply multiple edits (sorted by line number, applied bottom-up to preserve line numbers).
   * Validates all hashes before applying any edits.
   */
  static applyEdits(content: string, edits: HashEdit[], file: string = ""): HashEditResult {
    if (edits.length === 0) {
      return { success: true, file, linesChanged: 0 };
    }

    // Pre-validate all anchors before applying any edits
    for (const edit of edits) {
      const startParsed = HashlineEditor.parseAnchor(edit.anchor);
      if (!startParsed) {
        return { success: false, file, linesChanged: 0, error: `Invalid anchor format: ${edit.anchor}` };
      }

      const startValidation = HashlineEditor.validateAnchor(edit.anchor, content);
      if (!startValidation.valid) {
        const lines = content.split("\n");
        if (startValidation.actual === undefined) {
          return {
            success: false,
            file,
            linesChanged: 0,
            error: `Line ${startParsed.line} is out of range (file has ${lines.length} lines)`,
          };
        }
        return {
          success: false,
          file,
          linesChanged: 0,
          error: `Hash mismatch at line ${startParsed.line}: expected ${startValidation.expected}, got ${startValidation.actual}`,
        };
      }

      if (edit.endAnchor) {
        const endParsed = HashlineEditor.parseAnchor(edit.endAnchor);
        if (!endParsed) {
          return { success: false, file, linesChanged: 0, error: `Invalid end anchor format: ${edit.endAnchor}` };
        }

        const endValidation = HashlineEditor.validateAnchor(edit.endAnchor, content);
        if (!endValidation.valid) {
          const lines = content.split("\n");
          if (endValidation.actual === undefined) {
            return {
              success: false,
              file,
              linesChanged: 0,
              error: `Line ${endParsed.line} is out of range (file has ${lines.length} lines)`,
            };
          }
          return {
            success: false,
            file,
            linesChanged: 0,
            error: `Hash mismatch at line ${endParsed.line}: expected ${endValidation.expected}, got ${endValidation.actual}`,
          };
        }
      }
    }

    // Sort edits by start line number descending (bottom-up) to preserve line numbers
    const sorted = [...edits].sort((a, b) => {
      const aLine = HashlineEditor.parseAnchor(a.anchor)!.line;
      const bLine = HashlineEditor.parseAnchor(b.anchor)!.line;
      return bLine - aLine;
    });

    // Apply edits bottom-up
    let currentContent = content;
    let totalLinesChanged = 0;

    for (const edit of sorted) {
      const result = HashlineEditor.applyEdit(currentContent, edit);

      if ("error" in result) {
        return { success: false, file, linesChanged: totalLinesChanged, error: result.error };
      }

      currentContent = result.result;
      totalLinesChanged += result.linesChanged;
    }

    return { success: true, file, linesChanged: totalLinesChanged };
  }

  /**
   * Enhance a file read result with hashline annotations.
   * Input: raw file content. Output: annotated string for agent consumption.
   */
  static enhanceRead(filePath: string, content: string): string {
    const annotated = HashlineEditor.annotate(content);
    const formatted = HashlineEditor.formatAnnotated(annotated);
    const lineCount = annotated.length;

    return `--- ${filePath} (${lineCount} lines, hashline-annotated) ---\n${formatted}\n--- end ${filePath} ---`;
  }
}
