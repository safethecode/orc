import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export type RuleDecision = "allow" | "prompt" | "forbidden";

export interface ExecRule {
  pattern: string;
  decision: RuleDecision;
  reason?: string;
}

export interface ExecPolicy {
  rules: ExecRule[];
}

const TRUST_FILE = join(homedir(), ".orchestrator", "trusted-projects.json");

const BANNED_AUTO_ALLOW = ["python", "node", "bash", "sh", "ruby", "perl", "bun", "deno"];

async function loadRulesFromDir(dir: string): Promise<ExecRule[]> {
  const rules: ExecRule[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir).then((e) => e.filter((f) => f.endsWith(".json")));
  } catch {
    return rules;
  }
  for (const file of entries) {
    try {
      const data = await readFile(join(dir, file), "utf-8");
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) rules.push(...parsed);
    } catch {
      // skip malformed files
    }
  }
  return rules;
}

export async function loadExecPolicy(projectDir?: string): Promise<ExecPolicy> {
  const userDir = join(homedir(), ".orchestrator", "rules");
  const userRules = await loadRulesFromDir(userDir);

  let projectRules: ExecRule[] = [];
  if (projectDir) {
    const projDir = join(projectDir, ".orc", "rules");
    projectRules = await loadRulesFromDir(projDir);
  }

  // Merge: project rules cannot weaken user "forbidden" to "allow"
  const userForbidden = new Set(
    userRules.filter((r) => r.decision === "forbidden").map((r) => r.pattern),
  );

  const merged = [...userRules];
  for (const rule of projectRules) {
    if (userForbidden.has(rule.pattern) && rule.decision === "allow") {
      continue; // project can't override user "forbidden" to "allow"
    }
    merged.push(rule);
  }

  return { rules: merged };
}

export function evaluateCommand(
  command: string,
  policy: ExecPolicy,
): { decision: RuleDecision; reason?: string } | null {
  const trimmed = command.trim();
  for (const rule of policy.rules) {
    if (trimmed === rule.pattern || trimmed.startsWith(rule.pattern + " ")) {
      return { decision: rule.decision, reason: rule.reason };
    }
  }
  return null;
}

async function readTrustFile(): Promise<string[]> {
  try {
    const data = await readFile(TRUST_FILE, "utf-8");
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function isProjectTrusted(projectDir: string): Promise<boolean> {
  const trusted = await readTrustFile();
  return trusted.includes(projectDir);
}

export async function trustProject(projectDir: string): Promise<void> {
  const trusted = await readTrustFile();
  if (trusted.includes(projectDir)) return;

  trusted.push(projectDir);
  await mkdir(join(homedir(), ".orchestrator"), { recursive: true });
  await writeFile(TRUST_FILE, JSON.stringify(trusted, null, 2) + "\n");
}

export function canSuggestAutoAllow(command: string): boolean {
  const first = command.trim().split(/\s+/)[0];
  return !BANNED_AUTO_ALLOW.includes(first);
}
