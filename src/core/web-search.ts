export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchBackend {
  name: string;
  isAvailable(): boolean;
  search(query: string, maxResults?: number): Promise<WebSearchResult[]>;
}

class ExaBackend implements WebSearchBackend {
  name = "exa";
  private apiKey: string | null;
  private baseUrl = "https://api.exa.ai";

  constructor() {
    this.apiKey = process.env.EXA_API_KEY ?? null;
  }

  isAvailable(): boolean {
    return this.apiKey !== null;
  }

  async search(query: string, maxResults = 8): Promise<WebSearchResult[]> {
    if (!this.apiKey) return [];

    try {
      const res = await fetch(`${this.baseUrl}/search`, {
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          numResults: maxResults,
          contents: { text: { maxCharacters: 1000 } },
        }),
      });

      if (!res.ok) return [];

      const data = (await res.json()) as {
        results: Array<{ title: string; url: string; text?: string }>;
      };

      return (data.results ?? []).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: (r.text ?? "").slice(0, 300),
      }));
    } catch {
      return [];
    }
  }
}

class DuckDuckGoBackend implements WebSearchBackend {
  name = "duckduckgo";

  isAvailable(): boolean {
    return true;
  }

  async search(query: string, maxResults = 8): Promise<WebSearchResult[]> {
    try {
      const encoded = encodeURIComponent(query);
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${encoded}`, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; OrcBot/1.0)",
        },
      });

      if (!res.ok) return [];

      const html = await res.text();
      const results: WebSearchResult[] = [];

      // Parse titles and URLs from result links
      const titleRegex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
      const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

      const titles: Array<{ url: string; title: string }> = [];
      let match: RegExpExecArray | null;

      while ((match = titleRegex.exec(html)) !== null) {
        const rawUrl = match[1];
        const rawTitle = match[2].replace(/<[^>]*>/g, "").trim();
        // DuckDuckGo wraps URLs in a redirect; extract the actual URL
        let url = rawUrl;
        const uddgMatch = rawUrl.match(/[?&]uddg=([^&]+)/);
        if (uddgMatch) {
          url = decodeURIComponent(uddgMatch[1]);
        }
        titles.push({ url, title: rawTitle });
      }

      const snippets: string[] = [];
      while ((match = snippetRegex.exec(html)) !== null) {
        const rawSnippet = match[1].replace(/<[^>]*>/g, "").trim();
        snippets.push(rawSnippet);
      }

      for (let i = 0; i < Math.min(titles.length, maxResults); i++) {
        results.push({
          title: titles[i].title,
          url: titles[i].url,
          snippet: snippets[i] ?? "",
        });
      }

      return results;
    } catch {
      return [];
    }
  }
}

export class WebSearchEngine {
  private backends: WebSearchBackend[] = [];

  constructor() {
    if (process.env.EXA_API_KEY) this.backends.push(new ExaBackend());
    this.backends.push(new DuckDuckGoBackend());
  }

  getAvailableBackends(): string[] {
    return this.backends.filter((b) => b.isAvailable()).map((b) => b.name);
  }

  async search(
    query: string,
    opts?: { backend?: string; maxResults?: number },
  ): Promise<WebSearchResult[]> {
    const maxResults = opts?.maxResults ?? 8;

    if (opts?.backend) {
      const backend = this.backends.find(
        (b) => b.name === opts.backend && b.isAvailable(),
      );
      if (!backend) return [];
      return backend.search(query, maxResults);
    }

    // Try backends in order, return first successful result
    for (const backend of this.backends) {
      if (!backend.isAvailable()) continue;
      try {
        const results = await backend.search(query, maxResults);
        if (results.length > 0) return results;
      } catch {
        continue;
      }
    }

    return [];
  }
}
