import type {
  ProviderConfig,
  AgentProfile,
  ModelTier,
} from "../config/types.ts";

export interface CommandOptions {
  prompt: string;
  model?: ModelTier;
  maxBudgetUsd?: number;
  systemPrompt?: string;
  workdir?: string;
  useStdin?: boolean;
}

export function buildCommand(
  provider: ProviderConfig,
  profile: AgentProfile,
  options: CommandOptions,
): string[] {
  const model = options.model ?? profile.model;
  const budget = options.maxBudgetUsd ?? profile.maxBudgetUsd;

  let cmd: string[];

  if (provider.command === "claude") {
    if (options.useStdin) {
      cmd = [
        "claude",
        "-p", "-",
        "--model", model,
        "--output-format", "stream-json",
        "--verbose",
        "--max-turns", "1",
        "--max-budget-usd", String(budget),
      ];
    } else {
      cmd = [
        "claude",
        "-p", options.prompt,
        "--model", model,
        "--output-format", "stream-json",
        "--verbose",
        "--max-turns", "1",
        "--max-budget-usd", String(budget),
      ];
    }

    if (options.systemPrompt) {
      cmd.push("--system-prompt", options.systemPrompt);
    }
  } else if (provider.command === "codex") {
    cmd = ["codex", "exec", options.prompt, "--full-auto"];
  } else if (provider.command === "gemini") {
    cmd = ["gemini", "-p", options.prompt];
    if (options.model) {
      cmd.push("--model", options.model);
    }
    if (options.systemPrompt) {
      cmd.push("--system-prompt", options.systemPrompt);
    }
  } else if (provider.command === "kiro") {
    cmd = ["kiro", "cli", options.prompt];
    if (options.systemPrompt) {
      cmd.push("--system-prompt", options.systemPrompt);
    }
  } else {
    cmd = [provider.command];
    if (provider.subcommand) {
      cmd.push(provider.subcommand);
    }
    cmd.push(...provider.flags, options.prompt);
  }

  if (options.workdir) {
    cmd = ["sh", "-c", `cd ${options.workdir} && ${cmd.join(" ")}`];
  }

  return cmd;
}
