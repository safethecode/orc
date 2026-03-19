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
    const preloaded = await this.preReadRelevantFiles(subtask.prompt);

    const langBlock = this.languageHint && this.languageHint !== "en"
      ? `[LANGUAGE] The user writes in ${this.languageHint}. Always respond in the same language.`
      : "";
    const assembled = this.assemblePrompt(original, parent, sibling, completed, knowledge, bus, protocol, resolutions, langBlock, preloaded);

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
    preloaded: string = "",
  ): string {
    // Priority order: original > lang > codebase > preloaded > parent > completed > resolutions > sibling > knowledge > bus > protocol
    const fullContext = this.fullUserPrompt && this.fullUserPrompt !== original
      ? `## FULL USER REQUEST (follow ALL requirements below)\n\n${this.fullUserPrompt}\n\n## YOUR SPECIFIC ASSIGNMENT\n\n${original}`
      : original;
    const taskInstruction = `## YOUR TASK — Execute this immediately\n\n${fullContext}\n\n**CRITICAL RULES:**\n- **DO NOT run \`find\`, \`ls\`, \`ls -la\`, or explore directories.** The project structure is already provided below.\n- **DO NOT read files unless you are about to edit them.** Only Read a file right before you Edit it.\n- **Start writing code IMMEDIATELY.** Skip analysis — go straight to creating/editing files.\n- **Never ask clarifying questions.** Make reasonable assumptions and implement.\n- **DO NOT modify shared config files** (package.json, tsconfig.json, .env, next.config.*). Only modify files in your assigned domain. If you need a dependency, note it in your output and a setup step will handle it.`;
    const sections = [
      { text: taskInstruction, priority: 0 },
      { text: language, priority: 1 },
      { text: this.codebaseContext, priority: 2 },
      { text: preloaded, priority: 3 },
      { text: parent, priority: 4 },
      { text: completed, priority: 5 },
      { text: resolutions, priority: 6 },
      { text: sibling, priority: 7 },
      { text: knowledge, priority: 8 },
      { text: bus, priority: 9 },
      { text: protocol, priority: 10 },
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

  /** Common words to skip when extracting keywords from a prompt. */
  private static STOP_WORDS = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "shall",
    "should", "may", "might", "must", "can", "could", "to", "of", "in",
    "for", "on", "with", "at", "by", "from", "as", "into", "through",
    "and", "but", "or", "nor", "not", "so", "yet", "both", "either",
    "this", "that", "these", "those", "it", "its", "i", "me", "my",
    "we", "our", "you", "your", "he", "she", "they", "them", "their",
    "what", "which", "who", "whom", "how", "when", "where", "why",
    "all", "each", "every", "any", "few", "more", "most", "some",
    "such", "no", "only", "same", "than", "too", "very", "just",
    "about", "above", "after", "before", "between", "under", "again",
    "then", "once", "here", "there", "also", "new", "make", "use",
    "add", "create", "update", "fix", "implement", "write", "build",
    "need", "please", "file", "files", "code", "function", "class",
  ]);

  /**
   * Pre-read files likely relevant to the subtask prompt.
   * Extracts keywords, matches against the file tree in codebaseContext,
   * reads the top matches, and formats their contents.
   */
  async preReadRelevantFiles(prompt: string): Promise<string> {
    if (!this.codebaseContext) return "";

    // Extract significant keywords from the prompt
    const keywords = prompt
      .toLowerCase()
      .replace(/[^a-z0-9\s\-_./]/g, " ")
      .split(/\s+/)
      .filter(w => w.length >= 3 && !ContextPropagator.STOP_WORDS.has(w));
    if (keywords.length === 0) return "";

    // Parse file paths from codebaseContext (lines starting with ./ or containing file extensions)
    const filePaths: string[] = [];
    for (const line of this.codebaseContext.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("./") && !trimmed.includes(" ")) {
        filePaths.push(trimmed);
      }
    }
    if (filePaths.length === 0) return "";

    // Score each file path by keyword matches
    const scored: Array<{ path: string; score: number }> = [];
    for (const fp of filePaths) {
      const lower = fp.toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        if (lower.includes(kw)) score++;
      }
      if (score > 0) scored.push({ path: fp, score });
    }

    // Sort by score descending, take top 8
    scored.sort((a, b) => b.score - a.score);
    const topFiles = scored.slice(0, 8);
    if (topFiles.length === 0) return "";

    // Read file contents
    const maxLinesPerFile = 500;
    const sections: string[] = [];

    for (const { path: filePath } of topFiles) {
      // Resolve relative path (./foo) to absolute using cwd
      const absPath = filePath.startsWith("./")
        ? `${process.cwd()}/${filePath.slice(2)}`
        : filePath;

      try {
        const content = await Bun.file(absPath).text();
        const lines = content.split("\n");
        const truncated = lines.length > maxLinesPerFile
          ? lines.slice(0, maxLinesPerFile).join("\n") + "\n...(truncated)"
          : content;

        // Infer language from extension for code fence
        const ext = absPath.split(".").pop() ?? "";
        const langMap: Record<string, string> = {
          ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", py: "python",
          rs: "rust", go: "go", json: "json", yaml: "yaml", yml: "yaml",
          md: "md", css: "css", html: "html", sql: "sql", sh: "bash",
        };
        const lang = langMap[ext] ?? "";

        sections.push(`### ${filePath}\n\`\`\`${lang}\n${truncated}\n\`\`\``);
      } catch {
        // File unreadable — skip silently
      }
    }

    if (sections.length === 0) return "";
    return `## Pre-loaded Files (no need to Read these)\n${sections.join("\n\n")}`;
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
