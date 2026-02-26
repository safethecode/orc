import type { BudgetConfig } from "../config/types.ts";
import { Store } from "../db/store.ts";

export interface BudgetCheck {
  allowed: boolean;
  remaining: number;
  used: number;
  limit: number;
  warning: boolean;
  message?: string;
}

export class BudgetController {
  constructor(
    private store: Store,
    private config: BudgetConfig,
  ) {}

  checkAgentBudget(agentName: string, agentLimit: number): BudgetCheck {
    const usage = this.store.getAgentUsage(agentName);
    const used = usage.totalCost;
    const remaining = agentLimit - used;
    const allowed = remaining > 0;
    const warning = used / agentLimit >= this.config.warningThreshold;

    return {
      allowed,
      remaining: Math.max(0, remaining),
      used,
      limit: agentLimit,
      warning,
      message: !allowed
        ? `Agent "${agentName}" has exceeded its budget limit of $${agentLimit}`
        : warning
          ? `Agent "${agentName}" has used $${used.toFixed(4)} of $${agentLimit} (${((used / agentLimit) * 100).toFixed(1)}%)`
          : undefined,
    };
  }

  checkGlobalBudget(): BudgetCheck {
    const usage = this.store.getDailyUsage();
    const used = usage.totalCost;
    const limit = this.config.globalDailyLimit;
    const remaining = limit - used;
    const allowed = remaining > 0;
    const warning = used / limit >= this.config.warningThreshold;

    return {
      allowed,
      remaining: Math.max(0, remaining),
      used,
      limit,
      warning,
      message: !allowed
        ? `Global daily budget limit of $${limit} has been exceeded`
        : warning
          ? `Global daily usage at $${used.toFixed(4)} of $${limit} (${((used / limit) * 100).toFixed(1)}%)`
          : undefined,
    };
  }

  canProceed(
    agentName: string,
    agentLimit: number,
  ): { allowed: boolean; reason?: string } {
    const agentCheck = this.checkAgentBudget(agentName, agentLimit);
    if (!agentCheck.allowed) {
      return { allowed: false, reason: agentCheck.message };
    }

    const globalCheck = this.checkGlobalBudget();
    if (!globalCheck.allowed) {
      return { allowed: false, reason: globalCheck.message };
    }

    if (agentCheck.warning || globalCheck.warning) {
      return {
        allowed: true,
        reason: agentCheck.warning
          ? agentCheck.message
          : globalCheck.message,
      };
    }

    return { allowed: true };
  }

  recordUsage(
    agentName: string,
    taskId: string | null,
    tokens: number,
    cost: number,
  ): void {
    this.store.recordTokenUsage(agentName, taskId, tokens, cost);
  }
}
