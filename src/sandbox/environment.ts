export interface EnvPolicy {
  mode: "all" | "core" | "none";
  excludePatterns: string[];
  include: string[];
  overrides: Record<string, string>;
}

export const DEFAULT_ENV_POLICY: EnvPolicy = {
  mode: "core",
  excludePatterns: [
    "*KEY*",
    "*SECRET*",
    "*TOKEN*",
    "*PASSWORD*",
    "*CREDENTIAL*",
    "*AUTH*",
    "AWS_*",
    "OPENAI_*",
    "ANTHROPIC_*",
    "GITHUB_TOKEN",
    "NPM_TOKEN",
    "DOCKER_*",
    "KUBECONFIG",
  ],
  include: [
    "PATH",
    "HOME",
    "USER",
    "SHELL",
    "TERM",
    "LANG",
    "LC_ALL",
    "EDITOR",
    "VISUAL",
    "NODE_ENV",
    "BUN_ENV",
    "TMPDIR",
    "XDG_*",
  ],
  overrides: {},
};

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function matchesAny(key: string, patterns: string[]): boolean {
  return patterns.some((p) => globToRegex(p).test(key));
}

export function buildSafeEnv(policy?: Partial<EnvPolicy>): Record<string, string> {
  const merged: EnvPolicy = { ...DEFAULT_ENV_POLICY, ...policy };
  const result: Record<string, string> = {};

  if (merged.mode === "none") {
    return { ...merged.overrides };
  }

  const env = process.env as Record<string, string | undefined>;

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;

    if (merged.mode === "core") {
      if (!matchesAny(key, merged.include)) continue;
    }

    if (matchesAny(key, merged.excludePatterns)) {
      // Explicit includes override excludes
      if (!matchesAny(key, merged.include)) continue;
    }

    result[key] = value;
  }

  // Apply overrides last
  for (const [key, value] of Object.entries(merged.overrides)) {
    result[key] = value;
  }

  return result;
}
