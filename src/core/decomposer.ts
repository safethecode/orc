import type { SubTask, DecompositionResult, ExecutionPlan, ExecutionPhaseGroup, AgentRole, TaskStatus } from "../config/types.ts";
import { assessComplexityHeuristic } from "./complexity.ts";
import { eventBus } from "./events.ts";

// Domain detection patterns — identifies what domains a prompt touches
const DOMAIN_PATTERNS: Record<string, RegExp> = {
  frontend: /\b(react|vue|angular|css|html|ui|component|page|layout|style|responsive|tailwind|dom)\b/i,
  backend: /\b(api|endpoint|server|route|controller|middleware|express|fastify|rest|graphql)\b/i,
  database: /\b(database|sql|migration|schema|query|model|orm|postgres|mysql|mongo|redis)\b/i,
  auth: /\b(auth|login|signup|session|jwt|oauth|token|permission|rbac|password)\b/i,
  testing: /\b(test|spec|coverage|e2e|integration|unit|jest|vitest|playwright|cypress)\b/i,
  devops: /\b(docker|ci|cd|deploy|kubernetes|k8s|pipeline|terraform|nginx|cloud)\b/i,
  docs: /\b(document|readme|api.?doc|jsdoc|swagger|openapi|changelog)\b/i,
  security: /\b(security|vulnerability|xss|csrf|injection|sanitize|encrypt|ssl|tls)\b/i,
};

// Role mapping by domain
const DOMAIN_ROLE_MAP: Record<string, AgentRole> = {
  frontend: "coder",
  backend: "coder",
  database: "coder",
  auth: "coder",
  testing: "tester",
  devops: "coder",
  docs: "spec-writer",
  security: "reviewer",
};

// Dependency rules: if task A is in domainA and task B is in domainB, B depends on A
const DEPENDENCY_RULES: Array<{ before: string; after: string }> = [
  { before: "database", after: "backend" },
  { before: "backend", after: "frontend" },
  { before: "auth", after: "backend" },
  { before: "auth", after: "frontend" },
  { before: "database", after: "auth" },
  { before: "frontend", after: "testing" },
  { before: "backend", after: "testing" },
  { before: "testing", after: "docs" },
];

export function detectDomains(prompt: string): string[] {
  const domains: string[] = [];
  for (const [domain, pattern] of Object.entries(DOMAIN_PATTERNS)) {
    if (pattern.test(prompt)) {
      domains.push(domain);
    }
  }
  return domains.length > 0 ? domains : ["backend"]; // default to backend
}

export function inferRole(domains: string[]): AgentRole {
  // Multi-domain = architect, single domain = domain-specific role
  if (domains.length >= 3) return "architect";
  return DOMAIN_ROLE_MAP[domains[0]] ?? "coder";
}

export function splitByDomain(prompt: string, domains: string[]): Array<{ domain: string; prompt: string }> {
  if (domains.length <= 1) {
    return [{ domain: domains[0] ?? "backend", prompt }];
  }

  // Try sentence splitting first
  const sentences = prompt
    .split(/[.!?\n]+/)
    .map(s => s.trim())
    .filter(s => s.length > 10);

  if (sentences.length <= 1) {
    // Can't meaningfully split — treat as single task per domain
    return domains.map(domain => ({
      domain,
      prompt: `[${domain}] ${prompt}`,
    }));
  }

  // Group sentences by domain
  const domainSentences: Record<string, string[]> = {};
  const unmatched: string[] = [];

  for (const sentence of sentences) {
    const matchedDomains = domains.filter(d => DOMAIN_PATTERNS[d]?.test(sentence));
    if (matchedDomains.length > 0) {
      for (const d of matchedDomains) {
        (domainSentences[d] ??= []).push(sentence);
      }
    } else {
      unmatched.push(sentence);
    }
  }

  // Assign unmatched to first domain
  if (unmatched.length > 0) {
    const firstDomain = domains[0];
    (domainSentences[firstDomain] ??= []).push(...unmatched);
  }

  return Object.entries(domainSentences).map(([domain, sents]) => ({
    domain,
    prompt: sents.join(". "),
  }));
}

export function buildDependencyGraph(
  subtasks: Array<{ id: string; domain: string }>
): Map<string, string[]> {
  const deps = new Map<string, string[]>();
  const domainToId = new Map<string, string>();

  for (const st of subtasks) {
    domainToId.set(st.domain, st.id);
    deps.set(st.id, []);
  }

  for (const rule of DEPENDENCY_RULES) {
    const beforeId = domainToId.get(rule.before);
    const afterId = domainToId.get(rule.after);
    if (beforeId && afterId && beforeId !== afterId) {
      deps.get(afterId)!.push(beforeId);
    }
  }

  return deps;
}

export function buildExecutionPlan(
  subtasks: SubTask[],
  deps: Map<string, string[]>,
): ExecutionPlan {
  // Topological sort into phases (waves)
  const phases: ExecutionPhaseGroup[] = [];
  const completed = new Set<string>();
  let remaining = [...subtasks];

  let phaseIndex = 0;
  while (remaining.length > 0) {
    const ready = remaining.filter(st =>
      (deps.get(st.id) ?? []).every(dep => completed.has(dep))
    );

    if (ready.length === 0) {
      // Circular dependency — break by forcing remaining into one phase
      ready.push(...remaining);
      remaining = [];
    }

    phases.push({
      name: `phase-${phaseIndex++}`,
      subtaskIds: ready.map(st => st.id),
      parallelizable: ready.length > 1,
    });

    for (const st of ready) {
      completed.add(st.id);
    }

    remaining = remaining.filter(st => !completed.has(st.id));
  }

  const strategy = phases.length === 1 ? "parallel" :
    phases.every(p => p.subtaskIds.length === 1) ? "sequential" : "pipeline";

  return {
    phases,
    totalEstimatedDurationMs: subtasks.reduce((sum, st) => sum + (st.estimatedTokens / 50) * 1000, 0),
    strategy,
  };
}

const INITIAL_STATUS: TaskStatus = "queued";

export function decompose(
  prompt: string,
  parentTaskId: string,
): DecompositionResult {
  const complexity = assessComplexityHeuristic(prompt);
  const domains = detectDomains(prompt);

  // Simple tasks don't decompose
  if (complexity.level === "simple" || domains.length <= 1) {
    const id = `st-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const subtask: SubTask = {
      id,
      prompt,
      parentTaskId,
      dependencies: [],
      provider: "claude", // placeholder — provider-selector overrides
      model: complexity.level === "simple" ? "haiku" : "sonnet", // placeholder — provider-selector overrides
      agentRole: inferRole(domains),
      priority: 1,
      status: INITIAL_STATUS,
      result: null,
      estimatedTokens: complexity.level === "simple" ? 4000 : 15000,
      actualTokens: 0,
      startedAt: null,
      completedAt: null,
    };

    const plan = buildExecutionPlan([subtask], new Map([[id, []]]));

    eventBus.publish({
      type: "supervisor:decompose",
      taskId: parentTaskId,
      subtaskCount: 1,
      strategy: plan.strategy,
    });

    return { subtasks: [subtask], executionPlan: plan, estimatedTotalCost: 0 };
  }

  // Multi-domain decomposition
  const domainTasks = splitByDomain(prompt, domains);
  const subtaskMeta: Array<{ id: string; domain: string }> = [];
  const subtasks: SubTask[] = [];

  for (let i = 0; i < domainTasks.length; i++) {
    const dt = domainTasks[i];
    const id = `st-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}-${i}`;

    subtaskMeta.push({ id, domain: dt.domain });

    const role = DOMAIN_ROLE_MAP[dt.domain] ?? "coder";
    const estimatedTokens = complexity.level === "complex" ? 50000 : 15000;

    subtasks.push({
      id,
      prompt: dt.prompt,
      parentTaskId,
      dependencies: [], // filled below
      provider: "claude", // placeholder — provider-selector overrides
      model: complexity.level === "complex" ? "opus" : "sonnet", // placeholder — provider-selector overrides
      agentRole: role,
      priority: i + 1,
      status: INITIAL_STATUS,
      result: null,
      estimatedTokens,
      actualTokens: 0,
      startedAt: null,
      completedAt: null,
    });
  }

  // Build dependency graph
  const deps = buildDependencyGraph(subtaskMeta);
  for (const st of subtasks) {
    st.dependencies = deps.get(st.id) ?? [];
  }

  const plan = buildExecutionPlan(subtasks, deps);

  eventBus.publish({
    type: "supervisor:decompose",
    taskId: parentTaskId,
    subtaskCount: subtasks.length,
    strategy: plan.strategy,
  });

  return { subtasks, executionPlan: plan, estimatedTotalCost: 0 };
}
