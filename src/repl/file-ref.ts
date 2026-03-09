import { resolve, relative, basename, extname } from "node:path";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp", ".tiff", ".avif"]);
const BINARY_EXTS = new Set([".pdf", ".zip", ".tar", ".gz", ".wasm", ".exe", ".dll", ".so", ".dylib", ".bin", ".dat", ".db", ".sqlite"]);

function isImageFile(filePath: string): boolean {
  return IMAGE_EXTS.has(extname(filePath).toLowerCase());
}

function isBinaryFile(filePath: string): boolean {
  return BINARY_EXTS.has(extname(filePath).toLowerCase());
}

export interface FileMatch {
  path: string;
  absolutePath: string;
  score: number;
  preview: string;
}

export interface FileRefResult {
  query: string;
  matches: FileMatch[];
  selectedFile?: FileMatch;
  lineRange?: { start: number; end: number };
}

export class FileRefResolver {
  private projectDir: string;
  private fileCache: string[] = [];
  private lastCacheTime = 0;
  private cacheTtlMs = 30_000;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
  }

  parseRef(input: string): { ref: string; lineRange?: { start: number; end: number } } | null {
    const match = input.match(/@([\w.\/\-]+)(#L(\d+)(-(\d+))?)?/);
    if (!match) return null;

    const ref = match[1];
    const lineStart = match[3] ? parseInt(match[3], 10) : undefined;
    const lineEnd = match[5] ? parseInt(match[5], 10) : undefined;

    if (lineStart !== undefined) {
      return { ref, lineRange: { start: lineStart, end: lineEnd ?? lineStart } };
    }
    return { ref };
  }

  async warmCache(): Promise<void> {
    await this.refreshCache();
  }

  searchSync(query: string, maxResults = 5): FileMatch[] {
    if (this.fileCache.length === 0 || query.length === 0) return [];

    const scored: FileMatch[] = [];
    const queryLower = query.toLowerCase();

    for (const filePath of this.fileCache) {
      const score = this.fuzzyScore(queryLower, filePath.toLowerCase());
      if (score >= 0.3) {
        scored.push({
          path: filePath,
          absolutePath: resolve(this.projectDir, filePath),
          score,
          preview: "",
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxResults);
  }

  async search(query: string, maxResults = 10): Promise<FileMatch[]> {
    await this.refreshCache();

    const scored: FileMatch[] = [];
    const queryLower = query.toLowerCase();

    for (const filePath of this.fileCache) {
      const score = this.fuzzyScore(queryLower, filePath.toLowerCase());
      if (score > 0) {
        scored.push({
          path: filePath,
          absolutePath: resolve(this.projectDir, filePath),
          score,
          preview: "",
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const topResults = scored.slice(0, maxResults);

    // Load previews for top results
    await Promise.all(
      topResults.map(async (result) => {
        result.preview = await this.getPreview(result.absolutePath, 3);
      }),
    );

    return topResults;
  }

  private fuzzyScore(query: string, target: string): number {
    // Exact full-path match
    if (query === target) return 1.0;

    // Basename exact match
    const targetBase = basename(target);
    if (query === targetBase) return 0.9;

    // Basename without extension match
    const targetBaseStem = targetBase.replace(/\.[^.]+$/, "");
    if (query === targetBaseStem) return 0.85;

    // Target contains the full query as a substring
    if (target.includes(query)) {
      // Bonus for matching nearer the end (filename portion)
      const position = target.lastIndexOf(query);
      const positionBonus = position / target.length * 0.1;
      return 0.7 + positionBonus;
    }

    // Fuzzy character-by-character matching
    let queryIdx = 0;
    let matchCount = 0;
    let boundaryBonus = 0;
    const boundaryChars = new Set(["/", "-", "_", "."]);

    for (let i = 0; i < target.length && queryIdx < query.length; i++) {
      if (target[i] === query[queryIdx]) {
        matchCount++;
        // Bonus for matching at word boundaries
        if (i === 0 || boundaryChars.has(target[i - 1])) {
          boundaryBonus += 0.1;
        }
        queryIdx++;
      }
    }

    // All characters in query must be found in order
    if (queryIdx < query.length) return 0;

    const baseScore = matchCount / query.length;
    const lengthPenalty = Math.min(1, query.length / target.length);
    const normalizedBoundary = Math.min(boundaryBonus, 0.3);

    return Math.min(0.65, baseScore * 0.35 * lengthPenalty + normalizedBoundary);
  }

  private async refreshCache(): Promise<void> {
    if (Date.now() - this.lastCacheTime < this.cacheTtlMs && this.fileCache.length > 0) {
      return;
    }

    const excludeDirs = new Set(["node_modules", ".git", "dist", "build"]);
    const excludeExts = new Set([".lock"]);

    try {
      // Try git ls-files first (respects .gitignore)
      const proc = Bun.spawn(["git", "ls-files", "--cached", "--others", "--exclude-standard"], {
        cwd: this.projectDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      if (exitCode === 0 && output.trim().length > 0) {
        this.fileCache = output
          .trim()
          .split("\n")
          .filter((f) => {
            const parts = f.split("/");
            for (const part of parts.slice(0, -1)) {
              if (excludeDirs.has(part)) return false;
            }
            const ext = extname(f);
            if (excludeExts.has(ext)) return false;
            return true;
          });
        this.lastCacheTime = Date.now();
        return;
      }
    } catch {
      // Not a git repo or git not available, fall through to glob
    }

    // Fallback: use Bun.Glob
    const glob = new Bun.Glob("**/*");
    const files: string[] = [];

    for await (const entry of glob.scan({ cwd: this.projectDir, dot: false })) {
      const parts = entry.split("/");
      let skip = false;
      for (const part of parts.slice(0, -1)) {
        if (excludeDirs.has(part)) {
          skip = true;
          break;
        }
      }
      if (skip) continue;
      if (excludeExts.has(extname(entry))) continue;
      files.push(entry);
    }

    this.fileCache = files;
    this.lastCacheTime = Date.now();
  }

  async getContent(filePath: string, lineRange?: { start: number; end: number }): Promise<string> {
    const absPath = filePath.startsWith("/") ? filePath : resolve(this.projectDir, filePath);
    const file = Bun.file(absPath);

    if (!(await file.exists())) {
      throw new Error(`File not found: ${absPath}`);
    }

    const text = await file.text();

    if (!lineRange) return text;

    const lines = text.split("\n");
    const start = Math.max(0, lineRange.start - 1); // Convert to 0-indexed
    const end = Math.min(lines.length, lineRange.end);
    return lines.slice(start, end).join("\n");
  }

  async resolve(input: string): Promise<{ resolvedInput: string; filesIncluded: string[] }> {
    const refPattern = /@([\w.\/\-]+)(#L(\d+)(-(\d+))?)?/g;
    const refs: Array<{
      fullMatch: string;
      ref: string;
      lineRange?: { start: number; end: number };
    }> = [];

    let match: RegExpExecArray | null;
    while ((match = refPattern.exec(input)) !== null) {
      const ref = match[1];
      const lineStart = match[3] ? parseInt(match[3], 10) : undefined;
      const lineEnd = match[5] ? parseInt(match[5], 10) : undefined;

      refs.push({
        fullMatch: match[0],
        ref,
        lineRange: lineStart !== undefined ? { start: lineStart, end: lineEnd ?? lineStart } : undefined,
      });
    }

    if (refs.length === 0) {
      return { resolvedInput: input, filesIncluded: [] };
    }

    let resolvedInput = input;
    const filesIncluded: string[] = [];

    for (const refInfo of refs) {
      // Skip simple words without path characters (dots, slashes) —
      // these are likely @agent mentions, not file references
      if (/^[a-zA-Z][\w-]*$/.test(refInfo.ref)) continue;

      const matches = await this.search(refInfo.ref, 1);
      if (matches.length === 0) continue;

      const topMatch = matches[0];
      filesIncluded.push(topMatch.path);

      try {
        if (isImageFile(topMatch.absolutePath)) {
          // Images: provide absolute path so the agent's Read tool can view it
          const replacement = `\n[Image file: ${topMatch.absolutePath}]\nThis is an image file. Use the Read tool to view it: Read("${topMatch.absolutePath}")\n`;
          resolvedInput = resolvedInput.replace(refInfo.fullMatch, replacement);
        } else if (isBinaryFile(topMatch.absolutePath)) {
          // Binary: just note it exists
          const replacement = `\n[Binary file: ${topMatch.path} — cannot display inline]\n`;
          resolvedInput = resolvedInput.replace(refInfo.fullMatch, replacement);
        } else {
          const content = await this.getContent(topMatch.absolutePath, refInfo.lineRange);
          const lineInfo = refInfo.lineRange
            ? ` (lines ${refInfo.lineRange.start}-${refInfo.lineRange.end})`
            : "";
          const replacement = `\n[File: ${topMatch.path}${lineInfo}]\n\`\`\`\n${content}\n\`\`\`\n`;
          resolvedInput = resolvedInput.replace(refInfo.fullMatch, replacement);
        }
      } catch {
        // If we can't read the file, leave the reference as-is
      }
    }

    return { resolvedInput, filesIncluded };
  }

  private async getPreview(filePath: string, lines = 3): Promise<string> {
    try {
      const file = Bun.file(filePath);
      if (!(await file.exists())) return "";

      const text = await file.text();
      return text.split("\n").slice(0, lines).join("\n");
    } catch {
      return "";
    }
  }
}
