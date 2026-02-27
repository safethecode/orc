import type { ComplexityResult } from "../config/types.ts";

const INTEGRATION_PATTERNS: Record<string, RegExp> = {
  database: /\b(sql|database|migration|schema|query|table|index|orm)\b/i,
  auth: /\b(oauth|jwt|auth|login|session|token|password|credential)\b/i,
  api: /\b(api|endpoint|rest|graphql|webhook|route|middleware)\b/i,
  docker: /\b(docker|container|kubernetes|k8s|deploy|ci\/cd|pipeline)\b/i,
  testing: /\b(test|spec|coverage|e2e|integration|unit|mock|fixture)\b/i,
  frontend: /\b(react|vue|angular|svelte|component|css|html|dom|ui)\b/i,
  state: /\b(redux|zustand|store|state|context|provider|reducer)\b/i,
  realtime: /\b(websocket|sse|socket|realtime|push|stream|subscribe)\b/i,
  file: /\b(file|upload|download|stream|buffer|blob|s3|storage)\b/i,
  email: /\b(email|smtp|sendgrid|mailgun|notification|template)\b/i,
  payment: /\b(payment|stripe|billing|subscription|invoice|checkout)\b/i,
  search: /\b(search|elastic|algolia|index|fulltext|query|filter)\b/i,
  cache: /\b(cache|redis|memcached|ttl|invalidat|memoiz)\b/i,
  queue: /\b(queue|worker|job|background|async|bull|rabbitmq|kafka)\b/i,
  monitoring: /\b(monitor|metric|logging|tracing|alert|dashboard|observ)\b/i,
};

export function assessComplexityHeuristic(prompt: string): ComplexityResult {
  const integrations: string[] = [];
  for (const [name, pattern] of Object.entries(INTEGRATION_PATTERNS)) {
    if (pattern.test(prompt)) {
      integrations.push(name);
    }
  }

  // Estimate file count from word count and integration count
  const wordCount = prompt.split(/\s+/).length;
  const estimatedFiles = Math.max(1, Math.min(20, Math.round(wordCount / 30) + integrations.length));

  // Determine complexity level
  let level: "simple" | "standard" | "complex";
  let confidence: number;
  const factors: string[] = [];

  if (integrations.length >= 4 || estimatedFiles >= 10) {
    level = "complex";
    confidence = 0.7;
    factors.push(`${integrations.length} integrations detected`, `~${estimatedFiles} estimated files`);
  } else if (integrations.length >= 2 || estimatedFiles >= 4) {
    level = "standard";
    confidence = 0.75;
    factors.push(`${integrations.length} integrations detected`, `~${estimatedFiles} estimated files`);
  } else {
    level = "simple";
    confidence = 0.8;
    factors.push("Few integrations", `~${estimatedFiles} estimated files`);
  }

  const suggestedPhases = level === "complex"
    ? ["discovery", "requirements", "research", "spec", "critique", "planning", "validation"]
    : level === "standard"
    ? ["discovery", "requirements", "spec", "critique", "planning"]
    : ["discovery", "spec", "planning"];

  return { level, confidence, factors, suggestedPhases, estimatedFiles, integrations };
}

export function buildComplexityPrompt(prompt: string, heuristic: ComplexityResult): string {
  return `Assess the complexity of this task:

Task: ${prompt}

Heuristic analysis suggests:
- Level: ${heuristic.level}
- Integrations: ${heuristic.integrations.join(", ") || "none"}
- Estimated files: ${heuristic.estimatedFiles}

Provide your assessment as JSON:
{
  "level": "simple" | "standard" | "complex",
  "confidence": 0.0-1.0,
  "factors": ["reason1", "reason2"],
  "suggestedPhases": ["phase1", "phase2"],
  "estimatedFiles": number,
  "integrations": ["integration1"]
}`;
}

export function parseComplexityResponse(response: string, fallback: ComplexityResult): ComplexityResult {
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        level: ["simple", "standard", "complex"].includes(parsed.level) ? parsed.level : fallback.level,
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : fallback.confidence,
        factors: Array.isArray(parsed.factors) ? parsed.factors : fallback.factors,
        suggestedPhases: Array.isArray(parsed.suggestedPhases) ? parsed.suggestedPhases : fallback.suggestedPhases,
        estimatedFiles: typeof parsed.estimatedFiles === "number" ? parsed.estimatedFiles : fallback.estimatedFiles,
        integrations: Array.isArray(parsed.integrations) ? parsed.integrations : fallback.integrations,
      };
    }
  } catch {}
  return fallback;
}
