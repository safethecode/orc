export interface CommentIssue {
  file: string;
  line: number;
  comment: string;
  reason: string;
}

export interface CommentCheckResult {
  file: string;
  totalComments: number;
  issues: CommentIssue[];
  commentToCodeRatio: number;
  excessive: boolean;
}

const AI_COMMENT_PATTERNS: RegExp[] = [
  /\/\/\s*This (function|method|class|variable|constant) (is used to|handles|manages|creates|returns|takes)/i,
  /\/\/\s*(Initialize|Set up|Configure|Define|Create|Declare) the/i,
  /\/\/\s*Import (necessary|required|needed) (modules|dependencies|packages)/i,
  /\/\/\s*Export the/i,
  /\/\/\s*Handle the case where/i,
  /\/\/\s*Check if the/i,
  /\/\/\s*Loop through/i,
  /\/\/\s*Return the (result|value|output)/i,
  /\/\/\s*TODO: (implement|add|handle|fix) (this|error|the)/i,
  /\/\/\s*This is (a|the) (main|primary|default)/i,
];

const ALLOWED_PATTERNS: RegExp[] = [
  /\/\/\s*(SAFETY|IMPORTANT|WARNING|HACK|FIXME|BUG|NOTE):/i,
  /\/\/\s*@(param|returns|throws|deprecated|see|example)/i,
  /\/\/\s*eslint-disable/i,
  /\/\/\s*@ts-/i,
  /\/\/\s*prettier-ignore/i,
];

interface ParsedComment {
  text: string;
  line: number;
  kind: "single" | "multi";
}

export class CommentChecker {
  private threshold: number;

  constructor(threshold?: number) {
    this.threshold = threshold ?? 0.3;
  }

  check(filePath: string, content: string): CommentCheckResult {
    const lines = content.split("\n");
    const comments = this.extractComments(lines);
    const issues: CommentIssue[] = [];

    for (const comment of comments) {
      if (this.isAllowed(comment.text)) continue;

      const reason = this.matchAIPattern(comment.text);
      if (reason) {
        issues.push({
          file: filePath,
          line: comment.line,
          comment: comment.text.trim(),
          reason,
        });
      }
    }

    const commentLineCount = this.countCommentLines(lines);
    const codeLineCount = this.countCodeLines(lines);
    const ratio = codeLineCount === 0 ? 0 : commentLineCount / codeLineCount;

    return {
      file: filePath,
      totalComments: comments.length,
      issues,
      commentToCodeRatio: Math.round(ratio * 1000) / 1000,
      excessive: ratio > this.threshold,
    };
  }

  checkAll(files: Array<{ path: string; content: string }>): CommentCheckResult[] {
    return files.map((f) => this.check(f.path, f.content));
  }

  formatIssues(result: CommentCheckResult): string {
    if (result.issues.length === 0 && !result.excessive) {
      return `${result.file}: OK (${result.totalComments} comments, ratio ${result.commentToCodeRatio})`;
    }

    const lines: string[] = [];
    lines.push(
      `${result.file}: ${result.issues.length} issue(s), ratio ${result.commentToCodeRatio}${result.excessive ? " [EXCESSIVE]" : ""}`,
    );

    for (const issue of result.issues) {
      lines.push(`  L${issue.line}: [${issue.reason}] ${issue.comment}`);
    }

    return lines.join("\n");
  }

  isExcessive(content: string): boolean {
    const lines = content.split("\n");
    const commentLineCount = this.countCommentLines(lines);
    const codeLineCount = this.countCodeLines(lines);
    const ratio = codeLineCount === 0 ? 0 : commentLineCount / codeLineCount;
    return ratio > this.threshold;
  }

  private extractComments(lines: string[]): ParsedComment[] {
    const comments: ParsedComment[] = [];
    let inMultiLine = false;
    let multiLineStart = 0;
    let multiLineBuffer = "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      if (inMultiLine) {
        const endIdx = line.indexOf("*/");
        if (endIdx !== -1) {
          multiLineBuffer += " " + line.slice(0, endIdx).trim();
          comments.push({
            text: multiLineBuffer.trim(),
            line: multiLineStart,
            kind: "multi",
          });
          inMultiLine = false;
          multiLineBuffer = "";

          // Check for single-line comment after the closing */
          const rest = line.slice(endIdx + 2);
          const singleMatch = rest.match(/\/\/(.*)/);
          if (singleMatch) {
            comments.push({
              text: "//" + singleMatch[1],
              line: lineNum,
              kind: "single",
            });
          }
        } else {
          multiLineBuffer += " " + line.trim();
        }
        continue;
      }

      // Check for multi-line comment start
      const multiStart = line.indexOf("/*");
      if (multiStart !== -1) {
        const multiEnd = line.indexOf("*/", multiStart + 2);
        if (multiEnd !== -1) {
          // Single-line block comment like /* comment */
          const text = line.slice(multiStart, multiEnd + 2);
          comments.push({ text, line: lineNum, kind: "multi" });
        } else {
          inMultiLine = true;
          multiLineStart = lineNum;
          multiLineBuffer = line.slice(multiStart).trim();
        }
        continue;
      }

      // Check for single-line comment
      const singleMatch = line.match(/(\/\/.*)/);
      if (singleMatch) {
        // Make sure it's not inside a string
        const beforeComment = line.slice(0, singleMatch.index);
        if (!this.isInsideString(beforeComment)) {
          comments.push({
            text: singleMatch[1],
            line: lineNum,
            kind: "single",
          });
        }
      }
    }

    return comments;
  }

  private isInsideString(before: string): boolean {
    let singleQuotes = 0;
    let doubleQuotes = 0;
    let backticks = 0;

    for (let i = 0; i < before.length; i++) {
      const c = before[i];
      if (c === "\\" && i + 1 < before.length) {
        i++; // skip escaped char
        continue;
      }
      if (c === "'") singleQuotes++;
      else if (c === '"') doubleQuotes++;
      else if (c === "`") backticks++;
    }

    // If any quote type has an odd count, we're inside a string
    return singleQuotes % 2 !== 0 || doubleQuotes % 2 !== 0 || backticks % 2 !== 0;
  }

  private isAllowed(commentText: string): boolean {
    for (const pattern of ALLOWED_PATTERNS) {
      if (pattern.test(commentText)) return true;
    }
    return false;
  }

  private matchAIPattern(commentText: string): string | null {
    for (const pattern of AI_COMMENT_PATTERNS) {
      if (pattern.test(commentText)) {
        // Determine reason category
        if (/TODO:/i.test(commentText)) return "todo-spam";
        if (/Import|Export/i.test(commentText)) return "obvious";
        if (/Return the (result|value|output)/i.test(commentText)) return "redundant";
        if (/Loop through/i.test(commentText)) return "redundant";
        if (/Check if the/i.test(commentText)) return "redundant";
        return "generic";
      }
    }
    return null;
  }

  private countCommentLines(lines: string[]): number {
    let count = 0;
    let inMultiLine = false;

    for (const line of lines) {
      const trimmed = line.trim();

      if (inMultiLine) {
        count++;
        if (trimmed.includes("*/")) {
          inMultiLine = false;
        }
        continue;
      }

      if (trimmed.startsWith("//")) {
        count++;
      } else if (trimmed.startsWith("/*")) {
        count++;
        if (!trimmed.includes("*/")) {
          inMultiLine = true;
        }
      } else if (trimmed.includes("//")) {
        // Inline comment: count as a partial comment line
        const before = line.slice(0, line.indexOf("//"));
        if (!this.isInsideString(before)) {
          count++;
        }
      }
    }

    return count;
  }

  private countCodeLines(lines: string[]): number {
    let count = 0;
    let inMultiLine = false;

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed) continue; // skip blank lines

      if (inMultiLine) {
        if (trimmed.includes("*/")) {
          inMultiLine = false;
        }
        continue;
      }

      if (trimmed.startsWith("/*")) {
        if (!trimmed.includes("*/")) {
          inMultiLine = true;
        }
        continue;
      }

      if (trimmed.startsWith("//")) continue;

      count++;
    }

    return count;
  }
}
