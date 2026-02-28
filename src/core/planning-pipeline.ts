// ── 3-Stage Planning Pipeline ─────────────────────────────────────────
// Inspired by oh-my-opencode's Prometheus/Metis/Momus: Plan → Review → Validate

import { mkdir } from "node:fs/promises";

export interface PlanStep {
  id: string;
  description: string;
  agentRole: string;
  dependencies: string[];
  estimatedComplexity: "low" | "medium" | "high";
  files?: string[];
}

export interface Plan {
  id: string;
  task: string;
  steps: PlanStep[];
  strategy: "sequential" | "parallel" | "pipeline";
  risks: string[];
  assumptions: string[];
  createdAt: string;
  status: "draft" | "reviewed" | "approved" | "rejected";
  reviewNotes: string[];
  validationResult?: { valid: boolean; issues: string[] };
}

export type PipelineStage = "plan" | "review" | "validate";

export interface PipelineResult {
  plan: Plan;
  stages: Array<{ stage: PipelineStage; completed: boolean; output: string; durationMs: number }>;
  approved: boolean;
  finalNotes: string;
}

// ── Keyword → Step templates ──────────────────────────────────────────

interface StepTemplate {
  pattern: RegExp;
  steps: Array<{ description: string; role: string; complexity: "low" | "medium" | "high" }>;
  risks: string[];
}

const STEP_TEMPLATES: StepTemplate[] = [
  {
    pattern: /\b(test|spec|coverage)\b/i,
    steps: [
      { description: "Identify test requirements and edge cases", role: "architect", complexity: "low" },
      { description: "Write unit/integration tests", role: "tester", complexity: "medium" },
      { description: "Verify test coverage meets threshold", role: "reviewer", complexity: "low" },
    ],
    risks: ["Test fixtures may need mock data", "Existing tests may break with new changes"],
  },
  {
    pattern: /\b(api|endpoint|route)\b/i,
    steps: [
      { description: "Design API contract and request/response schemas", role: "architect", complexity: "medium" },
      { description: "Implement API endpoint handlers", role: "coder", complexity: "high" },
      { description: "Add input validation and error responses", role: "coder", complexity: "medium" },
      { description: "Write API integration tests", role: "tester", complexity: "medium" },
    ],
    risks: ["Breaking changes to existing API consumers", "Rate limiting and auth not considered"],
  },
  {
    pattern: /\b(refactor|restructure|reorganize|cleanup)\b/i,
    steps: [
      { description: "Analyze current code structure and identify pain points", role: "architect", complexity: "medium" },
      { description: "Define target architecture and migration path", role: "architect", complexity: "medium" },
      { description: "Perform incremental refactoring", role: "coder", complexity: "high" },
      { description: "Verify all existing tests still pass", role: "tester", complexity: "low" },
      { description: "Review for missed regressions", role: "reviewer", complexity: "medium" },
    ],
    risks: ["Subtle behavioral changes during refactor", "Import path breakage across modules"],
  },
  {
    pattern: /\b(database|schema|migration|table|column)\b/i,
    steps: [
      { description: "Design database schema changes", role: "architect", complexity: "medium" },
      { description: "Write migration scripts", role: "coder", complexity: "medium" },
      { description: "Update ORM models and queries", role: "coder", complexity: "medium" },
      { description: "Test migration rollback safety", role: "tester", complexity: "medium" },
    ],
    risks: ["Data loss during migration", "Downtime during schema changes", "Foreign key constraint issues"],
  },
  {
    pattern: /\b(ui|component|page|layout|style|css|frontend)\b/i,
    steps: [
      { description: "Design component structure and props interface", role: "architect", complexity: "low" },
      { description: "Implement component logic and markup", role: "coder", complexity: "medium" },
      { description: "Add styling and responsive behavior", role: "coder", complexity: "medium" },
      { description: "Write component tests", role: "tester", complexity: "low" },
    ],
    risks: ["Cross-browser compatibility issues", "Accessibility requirements not met"],
  },
];

// Fallback for tasks that don't match any template
const DEFAULT_STEPS: Array<{ description: string; role: string; complexity: "low" | "medium" | "high" }> = [
  { description: "Analyze requirements and identify affected files", role: "architect", complexity: "low" },
  { description: "Implement changes", role: "coder", complexity: "medium" },
  { description: "Review implementation for correctness", role: "reviewer", complexity: "low" },
];

// Valid agent roles for validation
const VALID_ROLES = new Set(["architect", "coder", "reviewer", "tester", "researcher", "spec-writer"]);

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export class PlanningPipeline {
  /** Stage 1: Generate a plan from a task description */
  generatePlan(task: string, context?: { codebaseFiles?: string[]; previousPlans?: Plan[] }): Plan {
    const planId = `plan-${generateId()}`;
    const matchedTemplates: StepTemplate[] = [];
    const allRisks: string[] = [];

    // Match task against keyword templates
    for (const template of STEP_TEMPLATES) {
      if (template.pattern.test(task)) {
        matchedTemplates.push(template);
        allRisks.push(...template.risks);
      }
    }

    // Build steps from matched templates (or fallback)
    const rawSteps = matchedTemplates.length > 0
      ? matchedTemplates.flatMap((t) => t.steps)
      : [...DEFAULT_STEPS];

    // Deduplicate steps by description (multiple templates may add similar steps)
    const seen = new Set<string>();
    const dedupedSteps = rawSteps.filter((s) => {
      const key = s.description.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Convert to PlanSteps with IDs and dependencies
    const steps: PlanStep[] = dedupedSteps.map((s, i) => {
      const step: PlanStep = {
        id: `step-${i + 1}`,
        description: s.description,
        agentRole: s.role,
        dependencies: [],
        estimatedComplexity: s.complexity,
      };
      return step;
    });

    // Build sequential dependencies: each step depends on previous steps with the same or lower index
    // Architect steps come first, then coder, then tester/reviewer
    const roleOrder: Record<string, number> = { architect: 0, "spec-writer": 0, researcher: 0, coder: 1, tester: 2, reviewer: 3 };

    // Sort steps by role order to create a natural flow
    steps.sort((a, b) => (roleOrder[a.agentRole] ?? 1) - (roleOrder[b.agentRole] ?? 1));

    // Re-assign IDs after sort and set dependencies
    for (let i = 0; i < steps.length; i++) {
      steps[i].id = `step-${i + 1}`;
      if (i > 0) {
        // Each step depends on all previous steps in the same role-order tier or the last step of the previous tier
        const prevStep = steps[i - 1];
        const prevTier = roleOrder[prevStep.agentRole] ?? 1;
        const currentTier = roleOrder[steps[i].agentRole] ?? 1;

        if (currentTier > prevTier) {
          // Depends on last step of previous tier
          steps[i].dependencies = [prevStep.id];
        } else if (currentTier === prevTier && i > 0) {
          // Parallel within same tier — share dependency of first step in this tier
          const tierStart = steps.findIndex((s) => (roleOrder[s.agentRole] ?? 1) === currentTier);
          if (tierStart > 0) {
            steps[i].dependencies = [steps[tierStart - 1].id];
          }
        }
      }
    }

    // Assign files from context if provided
    if (context?.codebaseFiles && context.codebaseFiles.length > 0) {
      // Distribute codebase files across coder steps
      const coderSteps = steps.filter((s) => s.agentRole === "coder");
      if (coderSteps.length > 0) {
        const filesPerStep = Math.ceil(context.codebaseFiles.length / coderSteps.length);
        for (let i = 0; i < coderSteps.length; i++) {
          coderSteps[i].files = context.codebaseFiles.slice(i * filesPerStep, (i + 1) * filesPerStep);
        }
      }
    }

    // Build assumptions
    const assumptions: string[] = [
      "Project builds successfully before starting",
      "All dependencies are installed",
    ];
    if (matchedTemplates.some((t) => t.pattern.source.includes("test"))) {
      assumptions.push("Test framework is configured and working");
    }
    if (matchedTemplates.some((t) => t.pattern.source.includes("database"))) {
      assumptions.push("Database connection is available");
    }
    if (context?.previousPlans && context.previousPlans.length > 0) {
      assumptions.push("Previous plan outcomes are incorporated");
    }

    // Determine strategy based on dependency graph
    const strategy = this.inferStrategy(steps);

    // Add risks from previous failed plans
    if (context?.previousPlans) {
      for (const prev of context.previousPlans) {
        if (prev.status === "rejected") {
          allRisks.push(`Previous plan "${prev.task}" was rejected — consider review notes`);
        }
      }
    }

    return {
      id: planId,
      task,
      steps,
      strategy,
      risks: [...new Set(allRisks)],
      assumptions,
      createdAt: new Date().toISOString(),
      status: "draft",
      reviewNotes: [],
    };
  }

  /** Stage 2: Review the plan for gaps and issues */
  reviewPlan(plan: Plan): { approved: boolean; issues: string[]; suggestions: string[] } {
    const issues: string[] = [];
    const suggestions: string[] = [];

    // Check for missing test steps
    const hasTestStep = plan.steps.some((s) =>
      s.agentRole === "tester" || /\btest\b/i.test(s.description),
    );
    const hasCoderStep = plan.steps.some((s) => s.agentRole === "coder");
    if (hasCoderStep && !hasTestStep) {
      issues.push("No testing step found — code changes should be verified");
      suggestions.push("Add a testing step after implementation");
    }

    // Check for missing review steps
    const hasReviewStep = plan.steps.some((s) =>
      s.agentRole === "reviewer" || /\breview\b/i.test(s.description),
    );
    if (hasCoderStep && !hasReviewStep) {
      suggestions.push("Consider adding a review step for code quality");
    }

    // Check for steps without clear acceptance criteria
    for (const step of plan.steps) {
      if (step.description.length < 15) {
        issues.push(`Step "${step.id}" has a vague description: "${step.description}"`);
        suggestions.push(`Expand step ${step.id} with specific acceptance criteria`);
      }
    }

    // Check for circular dependencies
    const circularDeps = this.detectCircularDependencies(plan.steps);
    if (circularDeps.length > 0) {
      issues.push(`Circular dependencies detected: ${circularDeps.join(", ")}`);
    }

    // Check for missing error handling considerations
    const hasErrorHandling = plan.steps.some((s) =>
      /\b(error|exception|validation|fallback)\b/i.test(s.description),
    );
    if (!hasErrorHandling && plan.steps.length >= 3) {
      suggestions.push("Consider adding error handling or validation steps");
    }

    // Check for overly complex single steps that should be split
    for (const step of plan.steps) {
      if (step.estimatedComplexity === "high") {
        const wordCount = step.description.split(/\s+/).length;
        if (wordCount > 15) {
          issues.push(`Step "${step.id}" is high complexity with broad scope — consider splitting`);
          suggestions.push(`Split step ${step.id} into smaller, focused sub-steps`);
        }
      }
    }

    // Check for conflicting steps
    const coderStepFiles = plan.steps
      .filter((s) => s.agentRole === "coder" && s.files)
      .map((s) => ({ id: s.id, files: s.files! }));

    for (let i = 0; i < coderStepFiles.length; i++) {
      for (let j = i + 1; j < coderStepFiles.length; j++) {
        const overlap = coderStepFiles[i].files.filter((f) =>
          coderStepFiles[j].files.includes(f),
        );
        if (overlap.length > 0) {
          const noDep = !plan.steps.find((s) => s.id === coderStepFiles[j].id)
            ?.dependencies.includes(coderStepFiles[i].id);
          if (noDep) {
            issues.push(
              `Steps ${coderStepFiles[i].id} and ${coderStepFiles[j].id} modify overlapping files without dependency: ${overlap.join(", ")}`,
            );
          }
        }
      }
    }

    // Empty plan check
    if (plan.steps.length === 0) {
      issues.push("Plan has no steps");
    }

    const approved = issues.length === 0;
    return { approved, issues, suggestions };
  }

  /** Stage 3: Validate the plan is feasible */
  validatePlan(plan: Plan): { valid: boolean; issues: string[]; warnings: string[] } {
    const issues: string[] = [];
    const warnings: string[] = [];
    const stepIds = new Set(plan.steps.map((s) => s.id));

    // All dependencies reference valid step IDs
    for (const step of plan.steps) {
      for (const dep of step.dependencies) {
        if (!stepIds.has(dep)) {
          issues.push(`Step "${step.id}" depends on non-existent step "${dep}"`);
        }
      }
    }

    // No self-dependencies
    for (const step of plan.steps) {
      if (step.dependencies.includes(step.id)) {
        issues.push(`Step "${step.id}" depends on itself`);
      }
    }

    // Check for orphan steps (steps that nothing depends on AND that depend on nothing, besides the first)
    if (plan.steps.length > 1) {
      const depTargets = new Set(plan.steps.flatMap((s) => s.dependencies));
      const hasDeps = new Set(plan.steps.filter((s) => s.dependencies.length > 0).map((s) => s.id));

      for (const step of plan.steps) {
        const isDepOf = depTargets.has(step.id);
        const hasDep = hasDeps.has(step.id);
        if (!isDepOf && !hasDep) {
          warnings.push(`Step "${step.id}" is disconnected from the dependency graph`);
        }
      }
    }

    // Agent roles are valid
    for (const step of plan.steps) {
      if (!VALID_ROLES.has(step.agentRole)) {
        issues.push(`Step "${step.id}" has invalid agent role: "${step.agentRole}"`);
      }
    }

    // Strategy matches dependency graph
    if (plan.strategy === "parallel") {
      const hasDeps = plan.steps.some((s) => s.dependencies.length > 0);
      if (hasDeps) {
        warnings.push("Strategy is \"parallel\" but some steps have dependencies — consider \"pipeline\"");
      }
    }

    if (plan.strategy === "sequential") {
      // Check if some steps could run in parallel
      const tierGroups = new Map<string, PlanStep[]>();
      for (const step of plan.steps) {
        const deps = step.dependencies.join(",") || "root";
        const group = tierGroups.get(deps) ?? [];
        group.push(step);
        tierGroups.set(deps, group);
      }
      const parallelizable = [...tierGroups.values()].some((g) => g.length > 1);
      if (parallelizable) {
        warnings.push("Strategy is \"sequential\" but some steps could run in parallel");
      }
    }

    // Estimated complexity is reasonable
    const highComplexityCount = plan.steps.filter((s) => s.estimatedComplexity === "high").length;
    if (highComplexityCount > plan.steps.length * 0.7 && plan.steps.length >= 3) {
      warnings.push("Most steps are high complexity — plan may be underspecified");
    }

    // Check for duplicate step IDs
    if (stepIds.size !== plan.steps.length) {
      issues.push("Duplicate step IDs detected");
    }

    const valid = issues.length === 0;
    return { valid, issues, warnings };
  }

  /** Run the full pipeline: plan -> review -> validate */
  async runPipeline(task: string, context?: { codebaseFiles?: string[] }): Promise<PipelineResult> {
    const stages: PipelineResult["stages"] = [];

    // Stage 1: Generate
    const genStart = Date.now();
    let plan = this.generatePlan(task, context);
    stages.push({
      stage: "plan",
      completed: true,
      output: `Generated plan with ${plan.steps.length} steps (strategy: ${plan.strategy})`,
      durationMs: Date.now() - genStart,
    });

    // Stage 2: Review
    const reviewStart = Date.now();
    const review = this.reviewPlan(plan);
    stages.push({
      stage: "review",
      completed: true,
      output: review.approved
        ? "Plan approved by review"
        : `Review found ${review.issues.length} issue(s): ${review.issues.join("; ")}`,
      durationMs: Date.now() - reviewStart,
    });

    // Auto-fix: add missing test step if review flagged it
    if (!review.approved) {
      plan.reviewNotes.push(...review.issues, ...review.suggestions);

      const missingTests = review.issues.some((i) => /no testing step/i.test(i));
      if (missingTests) {
        const lastCoder = [...plan.steps].reverse().find((s) => s.agentRole === "coder");
        const testStep: PlanStep = {
          id: `step-${plan.steps.length + 1}`,
          description: "Write tests to verify implementation correctness",
          agentRole: "tester",
          dependencies: lastCoder ? [lastCoder.id] : [],
          estimatedComplexity: "medium",
        };
        plan.steps.push(testStep);
      }

      const missingReview = review.suggestions.some((s) => /adding a review step/i.test(s));
      if (missingReview) {
        const lastStep = plan.steps[plan.steps.length - 1];
        const reviewStep: PlanStep = {
          id: `step-${plan.steps.length + 1}`,
          description: "Review implementation for correctness and code quality",
          agentRole: "reviewer",
          dependencies: lastStep ? [lastStep.id] : [],
          estimatedComplexity: "low",
        };
        plan.steps.push(reviewStep);
      }

      // Recalculate strategy after auto-fix
      plan.strategy = this.inferStrategy(plan.steps);
      plan.status = "reviewed";
    } else {
      plan.status = "reviewed";
    }

    // Stage 3: Validate
    const valStart = Date.now();
    const validation = this.validatePlan(plan);
    plan.validationResult = { valid: validation.valid, issues: [...validation.issues, ...validation.warnings] };
    stages.push({
      stage: "validate",
      completed: true,
      output: validation.valid
        ? "Plan passed validation"
        : `Validation found ${validation.issues.length} issue(s), ${validation.warnings.length} warning(s)`,
      durationMs: Date.now() - valStart,
    });

    const approved = validation.valid;
    plan.status = approved ? "approved" : "rejected";

    const notesParts: string[] = [];
    if (review.issues.length > 0) notesParts.push(`Review: ${review.issues.join("; ")}`);
    if (review.suggestions.length > 0) notesParts.push(`Suggestions: ${review.suggestions.join("; ")}`);
    if (validation.warnings.length > 0) notesParts.push(`Warnings: ${validation.warnings.join("; ")}`);
    if (validation.issues.length > 0) notesParts.push(`Issues: ${validation.issues.join("; ")}`);

    return {
      plan,
      stages,
      approved,
      finalNotes: notesParts.length > 0 ? notesParts.join("\n") : "Plan approved with no issues",
    };
  }

  /** Format plan for display */
  formatPlan(plan: Plan): string {
    const lines: string[] = [];

    lines.push(`## Plan: ${plan.task}`);
    lines.push(`Strategy: ${plan.strategy} | Steps: ${plan.steps.length} | Status: ${plan.status}`);
    lines.push("");

    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      const deps = step.dependencies.length > 0
        ? step.dependencies.map((d) => `#${d.replace("step-", "")}`).join(", ")
        : "none";
      lines.push(`${i + 1}. [${step.agentRole}] ${step.description} (deps: ${deps}, complexity: ${step.estimatedComplexity})`);
      if (step.files && step.files.length > 0) {
        lines.push(`   Files: ${step.files.join(", ")}`);
      }
    }

    if (plan.risks.length > 0) {
      lines.push("");
      lines.push("Risks:");
      for (const risk of plan.risks) {
        lines.push(`  - ${risk}`);
      }
    }

    if (plan.assumptions.length > 0) {
      lines.push("");
      lines.push("Assumptions:");
      for (const assumption of plan.assumptions) {
        lines.push(`  - ${assumption}`);
      }
    }

    if (plan.reviewNotes.length > 0) {
      lines.push("");
      lines.push("Review Notes:");
      for (const note of plan.reviewNotes) {
        lines.push(`  - ${note}`);
      }
    }

    if (plan.validationResult) {
      lines.push("");
      lines.push(`Validation: ${plan.validationResult.valid ? "PASSED" : "FAILED"}`);
      for (const issue of plan.validationResult.issues) {
        lines.push(`  - ${issue}`);
      }
    }

    return lines.join("\n");
  }

  /** Save plan to file */
  async savePlan(plan: Plan, dir: string): Promise<string> {
    const planDir = `${dir}/.orchestrator/plans`;
    await mkdir(planDir, { recursive: true });

    const filePath = `${planDir}/${plan.id}.md`;
    const content = this.formatPlan(plan);
    await Bun.write(filePath, content);
    return filePath;
  }

  /** Load plan from file */
  async loadPlan(filePath: string): Promise<Plan | null> {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return null;

    const content = await file.text();
    return this.parsePlanMarkdown(content);
  }

  // ── Private helpers ─────────────────────────────────────────────────

  private inferStrategy(steps: PlanStep[]): "sequential" | "parallel" | "pipeline" {
    if (steps.length <= 1) return "sequential";

    const hasDeps = steps.some((s) => s.dependencies.length > 0);
    if (!hasDeps) return "parallel";

    // Check if it's a pure chain (sequential) or has parallel branches (pipeline)
    const depCounts = steps.map((s) => s.dependencies.length);
    const maxDeps = Math.max(...depCounts);
    const stepsWithDeps = steps.filter((s) => s.dependencies.length > 0).length;

    // If every step except the first has exactly one dependency, it's sequential
    if (stepsWithDeps === steps.length - 1 && maxDeps === 1) {
      // Verify it's a single chain, not parallel branches sharing a dep
      const depTargets = new Map<string, number>();
      for (const step of steps) {
        for (const dep of step.dependencies) {
          depTargets.set(dep, (depTargets.get(dep) ?? 0) + 1);
        }
      }
      const hasParallelBranches = [...depTargets.values()].some((count) => count > 1);
      return hasParallelBranches ? "pipeline" : "sequential";
    }

    return "pipeline";
  }

  private detectCircularDependencies(steps: PlanStep[]): string[] {
    const cycles: string[] = [];
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const stepMap = new Map(steps.map((s) => [s.id, s]));

    const dfs = (id: string, path: string[]): boolean => {
      if (inStack.has(id)) {
        const cycleStart = path.indexOf(id);
        cycles.push(path.slice(cycleStart).join(" → ") + ` → ${id}`);
        return true;
      }
      if (visited.has(id)) return false;

      visited.add(id);
      inStack.add(id);
      path.push(id);

      const step = stepMap.get(id);
      if (step) {
        for (const dep of step.dependencies) {
          dfs(dep, [...path]);
        }
      }

      inStack.delete(id);
      return false;
    };

    for (const step of steps) {
      if (!visited.has(step.id)) {
        dfs(step.id, []);
      }
    }

    return cycles;
  }

  private parsePlanMarkdown(content: string): Plan | null {
    const lines = content.split("\n");
    if (lines.length < 2) return null;

    // Parse header: ## Plan: {task}
    const taskMatch = lines[0]?.match(/^## Plan:\s*(.+)$/);
    if (!taskMatch) return null;
    const task = taskMatch[1];

    // Parse metadata: Strategy: {strategy} | Steps: {count} | Status: {status}
    const metaMatch = lines[1]?.match(
      /Strategy:\s*(\w+)\s*\|\s*Steps:\s*(\d+)\s*\|\s*Status:\s*(\w+)/,
    );
    const strategy = (metaMatch?.[1] ?? "sequential") as Plan["strategy"];
    const status = (metaMatch?.[3] ?? "draft") as Plan["status"];

    // Parse steps
    const steps: PlanStep[] = [];
    const risks: string[] = [];
    const assumptions: string[] = [];
    const reviewNotes: string[] = [];
    let validationValid = true;
    const validationIssues: string[] = [];

    let section: "steps" | "risks" | "assumptions" | "review" | "validation" | "" = "steps";

    for (let i = 2; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line.trim() === "") continue;

      if (line.startsWith("Risks:")) { section = "risks"; continue; }
      if (line.startsWith("Assumptions:")) { section = "assumptions"; continue; }
      if (line.startsWith("Review Notes:")) { section = "review"; continue; }
      if (line.startsWith("Validation:")) {
        section = "validation";
        validationValid = /PASSED/.test(line);
        continue;
      }

      if (section === "steps") {
        const stepMatch = line.match(
          /^\d+\.\s*\[(\w[\w-]*)\]\s*(.+?)\s*\(deps:\s*([^,)]+(?:,\s*[^)]+)?),\s*complexity:\s*(\w+)\)/,
        );
        if (stepMatch) {
          const depsStr = stepMatch[3].trim();
          const deps = depsStr === "none"
            ? []
            : depsStr.split(",").map((d) => `step-${d.trim().replace("#", "")}`);
          const step: PlanStep = {
            id: `step-${steps.length + 1}`,
            description: stepMatch[2].trim(),
            agentRole: stepMatch[1],
            dependencies: deps,
            estimatedComplexity: stepMatch[4] as PlanStep["estimatedComplexity"],
          };

          // Check next line for files
          const nextLine = lines[i + 1];
          if (nextLine && /^\s+Files:/.test(nextLine)) {
            step.files = nextLine.replace(/^\s+Files:\s*/, "").split(",").map((f) => f.trim());
            i++;
          }

          steps.push(step);
        }
      } else if (section === "risks") {
        const item = line.replace(/^\s+-\s*/, "").trim();
        if (item) risks.push(item);
      } else if (section === "assumptions") {
        const item = line.replace(/^\s+-\s*/, "").trim();
        if (item) assumptions.push(item);
      } else if (section === "review") {
        const item = line.replace(/^\s+-\s*/, "").trim();
        if (item) reviewNotes.push(item);
      } else if (section === "validation") {
        const item = line.replace(/^\s+-\s*/, "").trim();
        if (item) validationIssues.push(item);
      }
    }

    return {
      id: `plan-${generateId()}`,
      task,
      steps,
      strategy,
      risks,
      assumptions,
      createdAt: new Date().toISOString(),
      status,
      reviewNotes,
      validationResult: validationIssues.length > 0 || !validationValid
        ? { valid: validationValid, issues: validationIssues }
        : undefined,
    };
  }
}
