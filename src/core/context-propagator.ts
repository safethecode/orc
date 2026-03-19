import type {
  SubTask,
  DecompositionResult,
  SiblingResult,
  CollectedResult,
  AgentRole,
  WorkerMessageType,
} from "../config/types.ts";
import type { ContextBuilder } from "../memory/context-builder.ts";
import type { ContextCompressor } from "../messaging/context-compressor.ts";
import type { WorkerBus } from "./worker-bus.ts";
import type { ResultCollector } from "./result-collector.ts";
import { eventBus } from "./events.ts";

export class ContextPropagator {
  private maxContextTokens: number;
  private codebaseContext: string = "";
  private languageHint: string | null = null;
  private fullUserPrompt: string = "";

  setFullUserPrompt(prompt: string): void {
    this.fullUserPrompt = prompt;
  }

  constructor(
    private contextBuilder: ContextBuilder,
    private workerBus: WorkerBus,
    private compressor: ContextCompressor,
    options?: { maxContextTokens?: number },
  ) {
    this.maxContextTokens = options?.maxContextTokens ?? 32000;
  }

  setCodebaseContext(context: string): void {
    this.codebaseContext = context;
  }

  setLanguage(lang: string): void {
    this.languageHint = lang;
  }

  async buildWorkerPrompt(
    subtask: SubTask,
    decomposition: DecompositionResult,
    collector: ResultCollector,
    conflictResolutions?: Array<{ resolution: string; chosenApproach: string; corrections: string[] }>,
  ): Promise<string> {
    const original = subtask.prompt;
    const parent = this.buildParentContext(subtask, decomposition);
    const sibling = this.buildSiblingContext(subtask);
    const completed = this.buildCompletedSiblingContext(subtask, collector);
    const knowledge = await this.buildKnowledgeContext(subtask);
    const bus = this.buildBusMessageContext(subtask);
    const protocol = this.buildBusProtocolInstructions();
    const resolutions = this.buildConflictResolutionContext(conflictResolutions);

    const langBlock = this.languageHint && this.languageHint !== "en"
      ? `[LANGUAGE] The user writes in ${this.languageHint}. Always respond in the same language.`
      : "";
    const assembled = this.assemblePrompt(original, parent, sibling, completed, knowledge, bus, protocol, resolutions, langBlock);

    const estimatedTokens = this.estimateTokens(assembled);
    eventBus.publish({
      type: "context:propagate",
      subtaskId: subtask.id,
      contextTokens: estimatedTokens,
      sources: [
        parent ? "parent" : "",
        sibling ? "sibling" : "",
        completed ? "completed" : "",
        knowledge ? "knowledge" : "",
        bus ? "bus" : "",
        protocol ? "protocol" : "",
      ].filter(Boolean),
    });

    return assembled;
  }

  private buildParentContext(subtask: SubTask, decomposition: DecompositionResult): string {
    const strategy = decomposition.executionPlan.strategy;
    const totalSubtasks = decomposition.subtasks.length;
    const currentIndex = decomposition.subtasks.findIndex(s => s.id === subtask.id) + 1;

    return [
      "## Parent Task Context",
      `Strategy: ${strategy} (subtask ${currentIndex}/${totalSubtasks})`,
      `Parent task: ${subtask.parentTaskId}`,
      `Your role: ${subtask.agentRole}`,
      `Dependencies: ${subtask.dependencies.length > 0 ? subtask.dependencies.join(", ") : "none"}`,
    ].join("\n");
  }

  private buildSiblingContext(subtask: SubTask): string {
    const context = this.workerBus.formatSiblingContext(subtask.parentTaskId, undefined);
    if (!context) return "";

    return `## Sibling Workers\n${context}`;
  }

  private buildCompletedSiblingContext(subtask: SubTask, collector: ResultCollector): string {
    const summaries = collector.getSummaryForPropagation();
    if (summaries.length === 0) return "";

    const relevant = summaries.filter(s => {
      // Include results from dependencies
      return subtask.dependencies.includes(s.subtaskId);
    });

    if (relevant.length === 0) {
      // If no direct dependencies, include all completed siblings
      if (summaries.length > 0) {
        const filesShared = summaries.flatMap(s => s.filesChanged);
        eventBus.publish({
          type: "context:sibling_summary",
          subtaskId: subtask.id,
          siblingCount: summaries.length,
          filesShared,
        });
      }
      return this.formatSiblingResults(summaries);
    }

    return this.formatSiblingResults(relevant);
  }

  private formatSiblingResults(results: SiblingResult[]): string {
    if (results.length === 0) return "";

    const sections = results.map(r => {
      const lines = [
        `### ${r.agentName} (${r.role}/${r.domain})`,
        `Summary: ${r.summary}`,
      ];
      if (r.filesChanged.length > 0) {
        lines.push(`Files changed: ${r.filesChanged.join(", ")}`);
      }
      if (r.apisCreated.length > 0) {
        lines.push(`APIs created: ${r.apisCreated.join(", ")}`);
      }
      if (r.schemasCreated.length > 0) {
        lines.push(`Schemas: ${r.schemasCreated.join(", ")}`);
      }
      return lines.join("\n");
    });

    return `## Completed Sibling Results\n${sections.join("\n\n")}`;
  }

  private async buildKnowledgeContext(subtask: SubTask): Promise<string> {
    try {
      const context = await this.contextBuilder.buildContext(subtask.prompt);
      if (!context || context.length === 0) return "";
      return `## Codebase Knowledge\n${context}`;
    } catch {
      return "";
    }
  }

  private buildBusMessageContext(subtask: SubTask): string {
    const messages = this.workerBus.getMessagesByTask(subtask.parentTaskId);
    if (messages.length === 0) return "";

    const formatted = messages.slice(-10).map(m =>
      `[${m.type}] ${m.from} → ${m.to}: ${m.content.slice(0, 200)}`,
    );

    return `## Worker Bus Messages\n${formatted.join("\n")}`;
  }

  private buildConflictResolutionContext(
    resolutions?: Array<{ resolution: string; chosenApproach: string; corrections: string[] }>,
  ): string {
    if (!resolutions || resolutions.length === 0) return "";
    const sections = resolutions.map((r, i) => [
      `### Resolution ${i + 1}`,
      `Chosen approach: ${r.chosenApproach}`,
      `Details: ${r.resolution}`,
      ...(r.corrections.length > 0 ? [`Corrections: ${r.corrections.join("; ")}`] : []),
    ].join("\n"));
    return `## Resolved Conflicts\n${sections.join("\n\n")}`;
  }

  private assemblePrompt(
    original: string,
    parent: string,
    sibling: string,
    completed: string,
    knowledge: string,
    bus: string,
    protocol: string = "",
    resolutions: string = "",
    language: string = "",
  ): string {
    // Priority order: original > lang > codebase > parent > completed > resolutions > sibling > knowledge > bus > protocol
    const fullContext = this.fullUserPrompt && this.fullUserPrompt !== original
      ? `## FULL USER REQUEST (follow ALL requirements below)\n\n${this.fullUserPrompt}\n\n## YOUR SPECIFIC ASSIGNMENT\n\n${original}`
      : original;
    const taskInstruction = `## YOUR TASK — Execute this immediately\n\n${fullContext}\n\n**CRITICAL RULES:**\n- **DO NOT run \`find\`, \`ls\`, \`ls -la\`, or explore directories.** The project structure is already provided below.\n- **DO NOT read files unless you are about to edit them.** Only Read a file right before you Edit it.\n- **Start writing code IMMEDIATELY.** Skip analysis — go straight to creating/editing files.\n- **Never ask clarifying questions.** Make reasonable assumptions and implement.\n- **DO NOT modify shared config files** (package.json, tsconfig.json, .env, next.config.*). Only modify files in your assigned domain. If you need a dependency, note it in your output and a setup step will handle it.`;
    const sections = [
      { text: taskInstruction, priority: 0 },
      { text: language, priority: 1 },
      { text: this.codebaseContext, priority: 2 },
      { text: parent, priority: 3 },
      { text: completed, priority: 4 },
      { text: resolutions, priority: 5 },
      { text: sibling, priority: 6 },
      { text: knowledge, priority: 7 },
      { text: bus, priority: 8 },
      { text: protocol, priority: 9 },
    ].filter(s => s.text.length > 0);

    let result = "";
    let remainingTokens = this.maxContextTokens;

    for (const section of sections) {
      const tokens = this.estimateTokens(section.text);
      if (tokens <= remainingTokens) {
        result += (result ? "\n\n---\n\n" : "") + section.text;
        remainingTokens -= tokens;
      } else if (remainingTokens > 100) {
        // Truncate to fit
        const chars = remainingTokens * 4;
        const truncated = section.text.slice(0, chars) + "\n...(truncated)";
        result += (result ? "\n\n---\n\n" : "") + truncated;
        break;
      } else {
        break;
      }
    }

    return result;
  }

  buildBusProtocolInstructions(): string {
    return [
      "## Worker Bus Protocol",
      "You can communicate with other workers and the supervisor by printing special markers to stdout.",
      "",
      "Format: `[ORC:BUS:{type} to={target}] {content}`",
      "With metadata: `[ORC:BUS:{type} to={target} meta={json}] {content}`",
      "",
      "Types: request, artifact, status, warning, dependency",
      "Targets: `all` (broadcast), `supervisor`, or a specific worker agent name",
      "",
      "Examples:",
      '  [ORC:BUS:request to=all] Need the database schema for users table',
      '  [ORC:BUS:artifact to=all meta={"files":["src/api.ts"]}] Created REST API endpoints',
      '  [ORC:BUS:status to=supervisor] 70% complete, tests passing',
      '  [ORC:BUS:dependency to=worker-abc12345] Waiting for auth module',
    ].join("\n");
  }

  summarizeSiblingResult(result: CollectedResult): SiblingResult {
    return {
      agentName: result.agentName,
      subtaskId: result.subtaskId,
      role: (result as CollectedResult & { role?: AgentRole }).role ?? "coder",
      domain: (result as CollectedResult & { domain?: string }).domain ?? "general",
      summary: result.result,
      filesChanged: result.files,
      apisCreated: [],
      schemasCreated: [],
    };
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
