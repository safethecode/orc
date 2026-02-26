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
    cmd = [
      "claude",
      "-p",
      options.prompt,
      "--model",
      model,
      "--output-format",
      "stream-json",
      "--max-budget-usd",
      String(budget),
    ];

    if (options.systemPrompt) {
      cmd.push("--system-prompt", options.systemPrompt);
    }
  } else if (provider.command === "codex") {
    cmd = ["codex", "exec", options.prompt, "--full-auto"];
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
