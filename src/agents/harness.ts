import type { AgentRole, ProviderName } from "../config/types.ts";
import { loadProviderPrompt } from "./prompts/loader.ts";
import { ToolSelector } from "../core/tool-selector.ts";

const toolSelector = new ToolSelector();

export interface HarnessOptions {
  agentName: string;
  role: AgentRole;
  provider: ProviderName;
  parentTaskId: string;
  isWorker: boolean;
}

export interface HarnessResult {
  systemPrompt: string;
  tokenEstimate: number;
}

const ROLE_TITLES: Record<AgentRole, string> = {
  architect: "Software Architect",
  coder: "Software Engineer",
  reviewer: "Code Reviewer",
  tester: "Test Engineer",
  researcher: "Research Analyst",
  "spec-writer": "Specification Writer",
  qa: "Quality Assurance Inspector",
  design: "UI/UX Design Engineer",
  writer: "Technical Writer",
};

const PROTOCOL_BLOCK = `## Output Protocol
Signal progress: [ORC:PROGRESS n%] description
Signal completion: [ORC:DONE]
Report results: [ORC:RESULT files=a.ts,b.ts] summary of changes
Request help: [ORC:BUS:request to=supervisor] what you need
Share artifacts: [ORC:BUS:artifact to=all meta={"files":["f.ts"]}] description
Report issues: [ORC:BUS:warning to=supervisor] problem description`;

const ROLE_CONSTRAINTS: Record<AgentRole, string> = {
  reviewer:
    "MUST NOT modify files. Report issues with file:line format. Categorize each as blocking, warning, or suggestion.",
  researcher:
    "MUST NOT modify files. Cite file paths for all claims. Structure output as summary, evidence, recommendations.",
  "spec-writer":
    "MUST NOT modify code files, only .md files. Include acceptance criteria for every requirement.",
  coder:
    "Produce minimal diffs. Run tests after changes. Follow existing code patterns and conventions. " +
    "When your task is complete, ALWAYS end with a brief text summary of what you changed and why. Never end with just a tool call.",
  tester:
    "Modify test files only. Report pass/fail with counts. MUST NOT modify production code. " +
    "When your task is complete, ALWAYS end with a brief text summary of what you changed and why. Never end with just a tool call.",
  architect:
    "Analyze full scope before proposing changes. Document design decisions. Prioritize backward compatibility. " +
    "When your task is complete, ALWAYS end with a brief text summary of what you changed and why. Never end with just a tool call.",
  qa:
    'Verify ALL claimed work by reading actual files and running commands. Do NOT trust agent summaries. End with [QA:PASS] or [QA:FAIL reason="..."].',
  design:
    "Focus on visual design decisions: color, typography, spacing, layout, and component structure. " +
    "Produce concrete CSS/Tailwind code and design tokens, not abstract advice. " +
    "Always specify exact values (hex colors, px/rem sizes, font weights). " +
    "When recommending layouts, include responsive breakpoints. " +
    "When your task is complete, ALWAYS end with a brief text summary of what you changed and why. Never end with just a tool call.",
  writer:
    "Produce clean, concise documentation. Follow the tone level specified in the task. " +
    "Never use AI-typical filler phrases. Match the document type template. " +
    "Respect character limits from design components when writing UI microcopy. " +
    "When your task is complete, ALWAYS end with a brief text summary of what you changed and why. Never end with just a tool call.",
};

const PROVIDER_HINTS: Partial<Record<ProviderName, string>> = {
  codex: "Prefer writing code directly. Use tool calls for file edits.",
  gemini: "Be concise. Avoid verbose explanations. Lead with the result.",
  kiro: "No tool use. Write all code inline. Follow spec-driven patterns.",
};

export function buildHarness(options: HarnessOptions): HarnessResult {
  const { agentName, role, provider, parentTaskId, isWorker } = options;

  const title = ROLE_TITLES[role] ?? role;
  const kind = isWorker ? "worker" : "assistant";

  // Layer 1 — Identity
  const identity = `You are ${agentName}, a ${title} working as a ${kind} in a multi-agent orchestrator. Task: ${parentTaskId}.`;

  // Layer 2 — Protocol (worker only)
  const protocol = isWorker ? `\n\n${PROTOCOL_BLOCK}` : "";

  // Layer 3 — Constraints
  const constraints = ROLE_CONSTRAINTS[role]
    ? `\n\n## Constraints\n${ROLE_CONSTRAINTS[role]}`
    : "";

  // Layer 4 — Provider guidelines (file-based, with inline fallback)
  const providerPrompt = loadProviderPrompt(provider);
  const providerContent = providerPrompt || PROVIDER_HINTS[provider] || "";
  const providerSection = providerContent ? `\n\n## Provider Guidelines\n${providerContent}` : "";

  // Layer 5 — Tool instructions
  const toolInstructions = toolSelector.formatForPrompt(provider);
  const toolSection = toolInstructions ? `\n\n## Tool Usage\n${toolInstructions}` : "";

  const autonomous = "\n\nIMPORTANT: You are running in autonomous mode. NEVER use AskUserQuestion or ask the user for clarification. Make your best judgment and proceed. If unsure, pick the most reasonable option and execute it. Do not stop to ask — just do it.";

  const systemPrompt = `${identity}${protocol}${constraints}${providerSection}${toolSection}${autonomous}`;

  // Rough token estimate: ~1 token per 4 chars
  const tokenEstimate = Math.ceil(systemPrompt.length / 4);

  return { systemPrompt, tokenEstimate };
}
