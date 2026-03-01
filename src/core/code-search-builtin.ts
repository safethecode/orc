export interface CodeSearchResult {
  file: string;
  line?: number;
  content: string;
  repo?: string;
}

export interface CodeSearchBackend {
  name: string;
  isAvailable(): boolean;
  search(query: string, maxResults?: number): Promise<CodeSearchResult[]>;
}

class GrepAppBackend implements CodeSearchBackend {
  name = "grep.app";

  isAvailable(): boolean {
    return true;
  }

  async search(query: string, maxResults = 10): Promise<CodeSearchResult[]> {
    try {
      const encoded = encodeURIComponent(query);
      const res = await fetch(
        `https://grep.app/api/search?q=${encoded}&regexp=false`,
        {
          headers: {
            Accept: "application/json",
          },
        },
      );

      if (!res.ok) return [];

      const data = (await res.json()) as {
        hits?: {
          hits?: Array<{
            _source?: {
              path?: string;
              repo?: { raw?: string };
              content?: { snippet?: string };
            };
          }>;
        };
      };

      const hits = data.hits?.hits ?? [];
      const results: CodeSearchResult[] = [];

      for (const hit of hits.slice(0, maxResults)) {
        const source = hit._source;
        if (!source) continue;

        const snippet = source.content?.snippet ?? "";
        // Strip HTML tags from snippet
        const cleanSnippet = snippet.replace(/<[^>]*>/g, "").trim();

        results.push({
          file: source.path ?? "",
          content: cleanSnippet,
          repo: source.repo?.raw ?? "",
        });
      }

      return results;
    } catch {
      return [];
    }
  }
}

class LocalRipgrepBackend implements CodeSearchBackend {
  name = "ripgrep";

  isAvailable(): boolean {
    return true;
  }

  async search(query: string, maxResults = 20): Promise<CodeSearchResult[]> {
    try {
      const proc = Bun.spawn(
        ["rg", "--json", "-m", "1", "--max-count", "1", "-l", query],
        {
          cwd: process.cwd(),
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      const output = await new Response(proc.stdout).text();
      await proc.exited;

      const results: CodeSearchResult[] = [];
      const lines = output.split("\n").filter((l) => l.trim());

      for (const line of lines) {
        if (results.length >= maxResults) break;
        try {
          const parsed = JSON.parse(line) as {
            type: string;
            data?: {
              path?: { text?: string };
              lines?: { text?: string };
              line_number?: number;
              submatches?: Array<{ match?: { text?: string } }>;
            };
          };

          if (parsed.type === "match" && parsed.data) {
            results.push({
              file: parsed.data.path?.text ?? "",
              line: parsed.data.line_number,
              content: (parsed.data.lines?.text ?? "").trim(),
            });
          }
        } catch {
          // Skip malformed JSON lines
        }
      }

      // If --json with match didn't work (rg -l only gives summary), fall back
      if (results.length === 0) {
        const proc2 = Bun.spawn(
          ["rg", "--json", query],
          {
            cwd: process.cwd(),
            stdout: "pipe",
            stderr: "pipe",
          },
        );

        const output2 = await new Response(proc2.stdout).text();
        await proc2.exited;

        const lines2 = output2.split("\n").filter((l) => l.trim());
        for (const line of lines2) {
          if (results.length >= maxResults) break;
          try {
            const parsed = JSON.parse(line) as {
              type: string;
              data?: {
                path?: { text?: string };
                lines?: { text?: string };
                line_number?: number;
              };
            };

            if (parsed.type === "match" && parsed.data) {
              results.push({
                file: parsed.data.path?.text ?? "",
                line: parsed.data.line_number,
                content: (parsed.data.lines?.text ?? "").trim(),
              });
            }
          } catch {
            // Skip malformed JSON lines
          }
        }
      }

      return results;
    } catch {
      return [];
    }
  }
}

export class BuiltinCodeSearch {
  private backends: CodeSearchBackend[] = [];

  constructor() {
    this.backends.push(new GrepAppBackend());
    this.backends.push(new LocalRipgrepBackend());
  }

  getAvailableBackends(): string[] {
    return this.backends.filter((b) => b.isAvailable()).map((b) => b.name);
  }

  async search(
    query: string,
    opts?: { backend?: string; maxResults?: number; local?: boolean },
  ): Promise<CodeSearchResult[]> {
    const maxResults = opts?.maxResults ?? 10;

    // If local is explicitly requested, use ripgrep
    if (opts?.local) {
      const rg = this.backends.find((b) => b.name === "ripgrep");
      if (rg?.isAvailable()) return rg.search(query, maxResults);
      return [];
    }

    // If a specific backend is requested
    if (opts?.backend) {
      const backend = this.backends.find(
        (b) => b.name === opts.backend && b.isAvailable(),
      );
      if (!backend) return [];
      return backend.search(query, maxResults);
    }

    // Default: try grep.app for remote code search
    const grepApp = this.backends.find((b) => b.name === "grep.app");
    if (grepApp?.isAvailable()) {
      try {
        const results = await grepApp.search(query, maxResults);
        if (results.length > 0) return results;
      } catch {
        // fall through
      }
    }

    return [];
  }
}
