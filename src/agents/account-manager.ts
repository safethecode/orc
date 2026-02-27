import type { AccountProfile, ScoredAccount } from "../config/types.ts";

export class AccountManager {
  private accounts: AccountProfile[] = [];
  private proactiveThreshold = 0.8;

  register(account: AccountProfile): void {
    const idx = this.accounts.findIndex((a) => a.name === account.name);
    if (idx >= 0) {
      this.accounts[idx] = account;
    } else {
      this.accounts.push(account);
    }
  }

  remove(name: string): void {
    this.accounts = this.accounts.filter((a) => a.name !== name);
  }

  score(account: AccountProfile): ScoredAccount {
    // Rate limited → score 0
    if (account.rateLimitedUntil) {
      const resetTime = new Date(account.rateLimitedUntil).getTime();
      if (Date.now() < resetTime) {
        return { account, score: 0, reason: `Rate limited until ${account.rateLimitedUntil}` };
      }
    }

    let score = 100;
    const reasons: string[] = [];

    // Usage ratio penalty
    if (account.dailyLimit > 0) {
      const usageRatio = account.usageToday / account.dailyLimit;
      if (usageRatio > this.proactiveThreshold) {
        score -= (usageRatio - this.proactiveThreshold) * 200;
        reasons.push(`Usage at ${Math.round(usageRatio * 100)}%`);
      }
    }

    // API key type bonus (usually unlimited)
    if (account.type === "api_key") {
      score += 20;
      reasons.push("API key (higher limit)");
    }

    // Priority bonus
    score += (10 - account.priority) * 5;
    reasons.push(`Priority ${account.priority}`);

    return { account, score: Math.max(0, score), reason: reasons.join(", ") };
  }

  selectBest(): AccountProfile {
    if (this.accounts.length === 0) {
      throw new Error("No accounts registered");
    }

    const scored = this.accounts.map((a) => this.score(a));
    scored.sort((a, b) => b.score - a.score);

    // If all scored 0, pick "least bad" (earliest rate limit reset)
    if (scored[0].score === 0) {
      const withReset = scored.filter((s) => s.account.rateLimitedUntil);
      if (withReset.length > 0) {
        withReset.sort((a, b) =>
          new Date(a.account.rateLimitedUntil!).getTime() -
          new Date(b.account.rateLimitedUntil!).getTime()
        );
        return withReset[0].account;
      }
    }

    return scored[0].account;
  }

  recordUsage(name: string, tokens: number, _costUsd: number): void {
    const account = this.accounts.find((a) => a.name === name);
    if (account) {
      account.usageToday += tokens;
      account.lastUsed = new Date().toISOString();
    }
  }

  markRateLimited(name: string, resetAt: string): void {
    const account = this.accounts.find((a) => a.name === name);
    if (account) {
      account.rateLimitedUntil = resetAt;
    }
  }

  shouldSwitch(currentName: string): boolean {
    const current = this.accounts.find((a) => a.name === currentName);
    if (!current) return false;
    if (current.dailyLimit <= 0) return false;
    return current.usageToday / current.dailyLimit > this.proactiveThreshold;
  }

  listAccounts(): ScoredAccount[] {
    return this.accounts.map((a) => this.score(a));
  }
}
