export interface SearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

export interface SearchOptions {
  numResults?: number;
  maxTokens?: number;
  livecrawl?: "fallback" | "preferred";
  type?: "auto" | "fast" | "deep";
}

interface ExaSearchResponse {
  results: Array<{
    title: string;
    url: string;
    text?: string;
    score: number;
  }>;
}

export class CodeSearchEngine {
  private apiKey: string | null;
  private baseUrl = "https://api.exa.ai";

  constructor() {
    this.apiKey = process.env.EXA_API_KEY ?? null;
  }

  isAvailable(): boolean {
    return this.apiKey !== null;
  }

  async search(query: string, opts?: SearchOptions): Promise<SearchResult[]> {
    if (!this.apiKey) return [];

    const numResults = opts?.numResults ?? 8;
    const maxTokens = opts?.maxTokens ?? 10_000;

    const body: Record<string, unknown> = {
      query,
      numResults,
      contents: {
        text: { maxCharacters: maxTokens * 4 },
      },
    };

    if (opts?.livecrawl) body.livecrawl = opts.livecrawl;
    if (opts?.type) body.type = opts.type;

    try {
      const res = await fetch(`${this.baseUrl}/search`, {
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) return [];

      const data = (await res.json()) as ExaSearchResponse;

      return (data.results ?? []).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        content: r.text ?? "",
        score: r.score ?? 0,
      }));
    } catch {
      return [];
    }
  }

  formatForPrompt(results: SearchResult[], maxLength = 12_000): string {
    if (results.length === 0) return "";

    const lines: string[] = ["External Documentation:"];
    let length = lines[0].length;

    for (const r of results) {
      const snippet = r.content.length > 500
        ? r.content.slice(0, 500) + "..."
        : r.content;
      const line = `- [${r.title}](${r.url}): ${snippet}`;

      if (length + line.length > maxLength) break;
      lines.push(line);
      length += line.length;
    }

    return lines.join("\n");
  }

  async searchAndFormat(query: string, opts?: SearchOptions): Promise<string> {
    const results = await this.search(query, opts);
    return this.formatForPrompt(results);
  }
}
