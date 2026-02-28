import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface AuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string; // ISO timestamp
  provider: "copilot" | "codex";
  scopes?: string[];
}

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export interface CopilotAuthConfig {
  tokenStorePath?: string; // default ~/.orchestrator/auth/
  clientId?: string; // GitHub OAuth app client ID
  codexClientId?: string; // OpenAI OAuth client ID
}

type RequiredConfig = Required<CopilotAuthConfig>;

const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const OPENAI_AUTH_URL = "https://auth0.openai.com/authorize";
const OPENAI_TOKEN_URL = "https://auth0.openai.com/oauth/token";

const DEFAULT_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const DEFAULT_CODEX_CLIENT_ID = "";

export class CopilotAuth {
  private config: RequiredConfig;
  private tokens: Map<string, AuthToken> = new Map();

  constructor(config?: CopilotAuthConfig) {
    this.config = {
      tokenStorePath: config?.tokenStorePath ?? `${process.env.HOME}/.orchestrator/auth`,
      clientId: config?.clientId ?? DEFAULT_CLIENT_ID,
      codexClientId: config?.codexClientId ?? DEFAULT_CODEX_CLIENT_ID,
    };
  }

  // ---------- GitHub Copilot — Device Code Flow ----------

  async authorizeCopilot(): Promise<{
    token: AuthToken;
    userCode: string;
    verificationUri: string;
  }> {
    await this.loadTokens();

    const params = new URLSearchParams();
    params.set("client_id", this.config.clientId);
    params.set("scope", "read:user");

    const deviceRes = await fetch(GITHUB_DEVICE_CODE_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!deviceRes.ok) {
      const text = await deviceRes.text();
      throw new Error(`Device code request failed (${deviceRes.status}): ${text}`);
    }

    const deviceData = (await deviceRes.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    };

    const deviceCode: DeviceCodeResponse = {
      deviceCode: deviceData.device_code,
      userCode: deviceData.user_code,
      verificationUri: deviceData.verification_uri,
      expiresIn: deviceData.expires_in,
      interval: deviceData.interval,
    };

    const token = await this.pollForToken(
      deviceCode.deviceCode,
      deviceCode.interval,
      deviceCode.expiresIn,
    );

    this.tokens.set("copilot", token);
    await this.saveTokens();

    return {
      token,
      userCode: deviceCode.userCode,
      verificationUri: deviceCode.verificationUri,
    };
  }

  // ---------- OpenAI Codex — PKCE OAuth Flow ----------

  async authorizeCodex(): Promise<{ token: AuthToken; authUrl: string }> {
    await this.loadTokens();

    if (!this.config.codexClientId) {
      throw new Error(
        "OpenAI client ID is not configured. Set codexClientId in CopilotAuthConfig.",
      );
    }

    const verifier = this.generateCodeVerifier();
    const challenge = await this.generateCodeChallenge(verifier);
    const state = randomBytes(16).toString("base64url");

    let resolveToken: (token: AuthToken) => void;
    let rejectToken: (err: Error) => void;
    const tokenPromise = new Promise<AuthToken>((resolve, reject) => {
      resolveToken = resolve;
      rejectToken = reject;
    });

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (!req.url?.startsWith("/callback")) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      const url = new URL(req.url, "http://localhost");
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      const errorDesc = url.searchParams.get("error_description");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(
          `<html><body><h2>Authorization failed</h2><p>${error}: ${errorDesc ?? ""}</p><p>You can close this window.</p></body></html>`,
        );
        server.close();
        rejectToken!(new Error(`OAuth error: ${error} — ${errorDesc ?? ""}`));
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
        const port = (server.address() as { port: number }).port;
        const redirectUri = `http://localhost:${port}/callback`;
        const token = await this.exchangeCodexCode(code, redirectUri, verifier);

        this.tokens.set("codex", token);
        await this.saveTokens();

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
    const redirectUri = `http://localhost:${port}/callback`;

    const authParams = new URLSearchParams();
    authParams.set("response_type", "code");
    authParams.set("client_id", this.config.codexClientId);
    authParams.set("redirect_uri", redirectUri);
    authParams.set("code_challenge", challenge);
    authParams.set("code_challenge_method", "S256");
    authParams.set("state", state);
    authParams.set("scope", "openid profile email offline_access");
    authParams.set("audience", "https://api.openai.com/v1");

    const authUrl = `${OPENAI_AUTH_URL}?${authParams.toString()}`;

    // Auto-close after 5 minutes
    const timeout = setTimeout(() => {
      server.close();
      rejectToken!(new Error("Authorization timed out after 5 minutes"));
    }, 5 * 60 * 1000);

    tokenPromise.finally(() => clearTimeout(timeout));

    const token = await tokenPromise;
    return { token, authUrl };
  }

  // ---------- Get stored token (auto-refresh if expired) ----------

  async getToken(provider: "copilot" | "codex"): Promise<AuthToken | null> {
    await this.loadTokens();
    const token = this.tokens.get(provider);
    if (!token) return null;

    const expiresAt = new Date(token.expiresAt).getTime();
    // Still valid with 60s buffer
    if (expiresAt > Date.now() + 60_000) return token;

    // Try to refresh
    if (token.refreshToken) {
      try {
        const refreshed = await this.refreshToken(token);
        return refreshed;
      } catch {
        // Refresh failed — token is expired
        return null;
      }
    }

    return null;
  }

  // ---------- Refresh an expired token ----------

  async refreshToken(token: AuthToken): Promise<AuthToken> {
    if (!token.refreshToken) {
      throw new Error(`No refresh token available for ${token.provider}`);
    }

    if (token.provider === "copilot") {
      return this.refreshCopilotToken(token);
    }
    return this.refreshCodexToken(token);
  }

  private async refreshCopilotToken(token: AuthToken): Promise<AuthToken> {
    const body = new URLSearchParams();
    body.set("client_id", this.config.clientId);
    body.set("grant_type", "refresh_token");
    body.set("refresh_token", token.refreshToken!);

    const res = await fetch(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Copilot token refresh failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      error?: string;
      error_description?: string;
    };

    if (data.error) {
      throw new Error(`Copilot refresh error: ${data.error} — ${data.error_description ?? ""}`);
    }

    const refreshed: AuthToken = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? token.refreshToken,
      expiresAt: new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString(),
      provider: "copilot",
      scopes: data.scope ? data.scope.split(",") : token.scopes,
    };

    this.tokens.set("copilot", refreshed);
    await this.saveTokens();
    return refreshed;
  }

  private async refreshCodexToken(token: AuthToken): Promise<AuthToken> {
    const body = new URLSearchParams();
    body.set("grant_type", "refresh_token");
    body.set("client_id", this.config.codexClientId);
    body.set("refresh_token", token.refreshToken!);

    const res = await fetch(OPENAI_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Codex token refresh failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };

    const refreshed: AuthToken = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? token.refreshToken,
      expiresAt: new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString(),
      provider: "codex",
      scopes: data.scope ? data.scope.split(" ") : token.scopes,
    };

    this.tokens.set("codex", refreshed);
    await this.saveTokens();
    return refreshed;
  }

  // ---------- Revoke a token ----------

  async revokeToken(provider: "copilot" | "codex"): Promise<void> {
    await this.loadTokens();
    const token = this.tokens.get(provider);

    if (token && provider === "copilot") {
      // GitHub token deletion via API (best-effort)
      try {
        await fetch(`https://api.github.com/applications/${this.config.clientId}/token`, {
          method: "DELETE",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token.accessToken}`,
          },
        });
      } catch {
        // Revocation is best-effort; token is removed locally regardless
      }
    }

    if (token && provider === "codex") {
      // OpenAI revocation endpoint (best-effort)
      try {
        const body = new URLSearchParams();
        body.set("client_id", this.config.codexClientId);
        body.set("token", token.accessToken);
        await fetch("https://auth0.openai.com/oauth/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        });
      } catch {
        // Best-effort
      }
    }

    this.tokens.delete(provider);
    await this.saveTokens();
  }

  // ---------- Check if authenticated ----------

  isAuthenticated(provider: "copilot" | "codex"): boolean {
    const token = this.tokens.get(provider);
    if (!token) return false;
    return new Date(token.expiresAt).getTime() > Date.now() + 60_000;
  }

  // ---------- Persistence ----------

  private async loadTokens(): Promise<void> {
    try {
      const filePath = `${this.config.tokenStorePath}/tokens.json`;
      const file = Bun.file(filePath);
      if (await file.exists()) {
        const data = (await file.json()) as Record<string, AuthToken>;
        this.tokens = new Map(Object.entries(data));
      }
    } catch {
      this.tokens = new Map();
    }
  }

  private async saveTokens(): Promise<void> {
    const dir = this.config.tokenStorePath;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const filePath = `${dir}/tokens.json`;
    const obj: Record<string, AuthToken> = {};
    for (const [key, value] of this.tokens) {
      obj[key] = value;
    }
    await Bun.write(filePath, JSON.stringify(obj, null, 2));
  }

  // ---------- PKCE helpers ----------

  private generateCodeVerifier(): string {
    return randomBytes(32).toString("base64url");
  }

  private async generateCodeChallenge(verifier: string): Promise<string> {
    const encoded = new TextEncoder().encode(verifier);
    const digest = await crypto.subtle.digest("SHA-256", encoded);
    // base64url encode the digest
    const bytes = new Uint8Array(digest);
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  // ---------- Device code polling ----------

  private async pollForToken(
    deviceCode: string,
    interval: number,
    expiresIn: number,
  ): Promise<AuthToken> {
    const deadline = Date.now() + expiresIn * 1000;
    let pollInterval = interval;

    while (Date.now() < deadline) {
      await this.sleep(pollInterval * 1000);

      const body = new URLSearchParams();
      body.set("client_id", this.config.clientId);
      body.set("device_code", deviceCode);
      body.set("grant_type", "urn:ietf:params:oauth:grant-type:device_code");

      const res = await fetch(GITHUB_TOKEN_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });

      const data = (await res.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
        error?: string;
        error_description?: string;
      };

      if (data.access_token) {
        return {
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresAt: new Date(
            Date.now() + (data.expires_in ?? 28800) * 1000,
          ).toISOString(),
          provider: "copilot",
          scopes: data.scope ? data.scope.split(",") : undefined,
        };
      }

      switch (data.error) {
        case "authorization_pending":
          // User hasn't entered the code yet — keep polling
          break;

        case "slow_down":
          // Server asks us to increase interval by 5 seconds
          pollInterval += 5;
          break;

        case "expired_token":
          throw new Error(
            "Device code expired. Please restart the authorization flow.",
          );

        case "access_denied":
          throw new Error(
            "Authorization denied by user.",
          );

        default:
          if (data.error) {
            throw new Error(
              `Device code poll error: ${data.error} — ${data.error_description ?? ""}`,
            );
          }
          break;
      }
    }

    throw new Error("Device code authorization timed out.");
  }

  // ---------- Codex token exchange ----------

  private async exchangeCodexCode(
    code: string,
    redirectUri: string,
    verifier: string,
  ): Promise<AuthToken> {
    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("client_id", this.config.codexClientId);
    body.set("code", code);
    body.set("redirect_uri", redirectUri);
    body.set("code_verifier", verifier);

    const res = await fetch(OPENAI_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Codex token exchange failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      token_type?: string;
    };

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString(),
      provider: "codex",
      scopes: data.scope ? data.scope.split(" ") : undefined,
    };
  }

  // ---------- Util ----------

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
