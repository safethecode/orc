import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface OAuthConfig {
  clientId?: string;
  clientSecret?: string;
  authorizationUrl: string;
  tokenUrl: string;
  redirectUri?: string;
  scopes?: string[];
}

export interface OAuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  tokenType: string;
  scope?: string;
}

export interface OAuthStore {
  tokens: Record<string, OAuthToken>;
}

export class OAuthMcpAuth {
  private store: OAuthStore = { tokens: {} };
  private storePath: string;

  constructor(dataDir?: string) {
    this.storePath = `${dataDir ?? `${process.env.HOME}/.orchestrator`}/mcp-auth.json`;
  }

  private generatePKCE(): { verifier: string; challenge: string } {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    return { verifier, challenge };
  }

  async authorize(
    serverName: string,
    config: OAuthConfig,
  ): Promise<{ url: string; token: Promise<OAuthToken> }> {
    await this.loadStore();

    const { verifier, challenge } = this.generatePKCE();
    const state = randomBytes(16).toString("base64url");

    let resolveToken: (token: OAuthToken) => void;
    let rejectToken: (err: Error) => void;
    const tokenPromise = new Promise<OAuthToken>((resolve, reject) => {
      resolveToken = resolve;
      rejectToken = reject;
    });

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (!req.url?.startsWith("/callback")) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      const url = new URL(req.url, `http://localhost`);
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(
          `<html><body><h2>Authorization failed</h2><p>${error}</p><p>You can close this window.</p></body></html>`,
        );
        server.close();
        rejectToken!(new Error(`OAuth error: ${error}`));
        return;
      }

      if (!code || returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(
          `<html><body><h2>Invalid callback</h2><p>Missing code or state mismatch.</p></body></html>`,
        );
        server.close();
        rejectToken!(new Error("Invalid callback: missing code or state mismatch"));
        return;
      }

      try {
        const redirectUri = config.redirectUri ?? `http://localhost:${(server.address() as { port: number }).port}/callback`;
        const token = await this.exchangeCode(code, { ...config, redirectUri }, verifier);
        this.store.tokens[serverName] = token;
        await this.saveStore();

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          `<html><body><h2>Authorization successful</h2><p>You can close this window and return to the terminal.</p></body></html>`,
        );
        server.close();
        resolveToken!(token);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(
          `<html><body><h2>Token exchange failed</h2><p>${err instanceof Error ? err.message : String(err)}</p></body></html>`,
        );
        server.close();
        rejectToken!(err instanceof Error ? err : new Error(String(err)));
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const port = (server.address() as { port: number }).port;
    const redirectUri = config.redirectUri ?? `http://localhost:${port}/callback`;

    const params = new URLSearchParams();
    params.set("response_type", "code");
    if (config.clientId) params.set("client_id", config.clientId);
    params.set("redirect_uri", redirectUri);
    params.set("code_challenge", challenge);
    params.set("code_challenge_method", "S256");
    params.set("state", state);
    if (config.scopes?.length) params.set("scope", config.scopes.join(" "));

    const authUrl = `${config.authorizationUrl}?${params.toString()}`;

    // Auto-close server after 5 minutes if no callback received
    const timeout = setTimeout(() => {
      server.close();
      rejectToken!(new Error("Authorization timed out after 5 minutes"));
    }, 5 * 60 * 1000);

    tokenPromise.finally(() => clearTimeout(timeout));

    return { url: authUrl, token: tokenPromise };
  }

  private async exchangeCode(
    code: string,
    config: OAuthConfig,
    verifier: string,
  ): Promise<OAuthToken> {
    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("code", code);
    if (config.redirectUri) body.set("redirect_uri", config.redirectUri);
    body.set("code_verifier", verifier);
    if (config.clientId) body.set("client_id", config.clientId);
    if (config.clientSecret) body.set("client_secret", config.clientSecret);

    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token exchange failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
      scope?: string;
    };

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
      tokenType: data.token_type ?? "Bearer",
      scope: data.scope,
    };
  }

  async refresh(serverName: string, config: OAuthConfig): Promise<OAuthToken | null> {
    await this.loadStore();
    const existing = this.store.tokens[serverName];
    if (!existing?.refreshToken) return null;

    const body = new URLSearchParams();
    body.set("grant_type", "refresh_token");
    body.set("refresh_token", existing.refreshToken);
    if (config.clientId) body.set("client_id", config.clientId);
    if (config.clientSecret) body.set("client_secret", config.clientSecret);

    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
      scope?: string;
    };

    const token: OAuthToken = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? existing.refreshToken,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
      tokenType: data.token_type ?? "Bearer",
      scope: data.scope ?? existing.scope,
    };

    this.store.tokens[serverName] = token;
    await this.saveStore();
    return token;
  }

  async getToken(serverName: string, config?: OAuthConfig): Promise<OAuthToken | null> {
    await this.loadStore();
    const token = this.store.tokens[serverName];
    if (!token) return null;

    // Token is still valid (with 60s buffer)
    if (token.expiresAt > Date.now() + 60_000) return token;

    // Try to refresh if we have a refresh token and config
    if (token.refreshToken && config) {
      const refreshed = await this.refresh(serverName, config);
      if (refreshed) return refreshed;
    }

    return null;
  }

  hasValidToken(serverName: string): boolean {
    const token = this.store.tokens[serverName];
    if (!token) return false;
    return token.expiresAt > Date.now() + 60_000;
  }

  logout(serverName: string): void {
    delete this.store.tokens[serverName];
    this.saveStore().catch(() => {});
  }

  private async saveStore(): Promise<void> {
    const dir = dirname(this.storePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    await Bun.write(this.storePath, JSON.stringify(this.store, null, 2));
  }

  private async loadStore(): Promise<void> {
    try {
      const file = Bun.file(this.storePath);
      if (await file.exists()) {
        this.store = (await file.json()) as OAuthStore;
      }
    } catch {
      this.store = { tokens: {} };
    }
  }

  listAuthenticated(): string[] {
    return Object.keys(this.store.tokens).filter((name) => this.hasValidToken(name));
  }
}
