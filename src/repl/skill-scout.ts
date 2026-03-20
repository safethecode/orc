import { spawn } from "node:child_process";
import type { SkillEntry, SkillIndex } from "../agents/skill-index.ts";
import type { SubTask } from "../config/types.ts";

export interface ScoutResult {
  needed: boolean;
  skills: SkillEntry[];
  durationMs: number;
}

const TIMEOUT_MS = 5000;
const MAX_SKILLS = 2;

export async function scoutSkills(
  subtask: SubTask,
  skillIndex: SkillIndex,
  signal?: AbortSignal,
): Promise<ScoutResult> {
  const start = Date.now();
  const catalog = skillIndex.list();

  if (catalog.length === 0) {
    return { needed: false, skills: [], durationMs: Date.now() - start };
  }

  const catalogText = catalog
    .map((s) => `- ${s.name}: ${s.description}`)
    .join("\n");

  const prompt = `You are a skill matcher. Given a subtask and a list of available skills, decide if any skill is relevant.

Subtask role: ${subtask.agentRole}
Subtask prompt: ${subtask.prompt}

Available skills:
${catalogText}

Respond with ONLY a JSON object (no markdown, no explanation):
{"needed": true/false, "skills": ["skill-name"]}

Rules:
- Maximum ${MAX_SKILLS} skills
- Only pick skills clearly relevant to the subtask
- If no skill is relevant, return {"needed": false, "skills": []}`;

  try {
    const text = await runSonnet(prompt, signal);
    const parsed = parseJson(text);

    if (!parsed || !parsed.needed) {
      return { needed: false, skills: [], durationMs: Date.now() - start };
    }

    const names: string[] = Array.isArray(parsed.skills)
      ? parsed.skills.slice(0, MAX_SKILLS)
      : [];
    const entries = names
      .map((n: string) => skillIndex.getByName(n))
      .filter((e): e is SkillEntry => e != null);

    return {
      needed: entries.length > 0,
      skills: entries,
      durationMs: Date.now() - start,
    };
  } catch {
    // Graceful fallback — don't block subtask execution
    return { needed: false, skills: [], durationMs: Date.now() - start };
  }
}

function runSonnet(prompt: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("claude", [
      "-p", prompt,
      "--model", "sonnet",
      "--max-turns", "5",
    ], { stdio: ["ignore", "pipe", "pipe"], signal });

    const chunks: Buffer[] = [];
    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("scout timeout"));
    }, TIMEOUT_MS);

    proc.on("close", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf-8").trim());
    });

    proc.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function parseJson(text: string): { needed: boolean; skills: string[] } | null {
  // Try direct parse first
  try {
    return JSON.parse(text);
  } catch { /* continue */ }

  // Extract JSON from possible markdown wrapping
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch { /* fall through */ }
  }

  return null;
}
