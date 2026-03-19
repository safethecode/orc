// ── Agent & Provider Types ────────────────────────────────────────────

export type ModelTier = "haiku" | "sonnet" | "opus";

export type { TaskPriority } from "../core/scheduler.ts";

export type AgentStatus =
  | "idle"
  | "running"
  | "paused"
  | "error"
  | "terminated";

export type TaskStatus =
  | "queued"
  | "assigned"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface ProviderCapabilityConfig {
  models: string[];
  strengths: string[];
  weaknesses: string[];
  maxContextTokens: number;
  supportsStreaming: boolean;
  supportsToolUse: boolean;
  costTier: "low" | "medium" | "high";
}

export interface ProviderConfig {
  command: string;
  subcommand?: string;
  defaultModel: ModelTier | null;
  flags: string[];
  capabilities?: ProviderCapabilityConfig;
}

export interface RoutingTier {
  model: ModelTier;
  keywords: string[];
}

export interface RoutingConfig {
  tiers: {
    simple: RoutingTier;
    medium: RoutingTier;
    complex: RoutingTier;
  };
}

export interface BudgetConfig {
  defaultMaxPerTask: number;
}

export interface SupervisorConfig {
  enabled: boolean;
  workerTimeout: number;
  maxRetries: number;
  costAware: boolean;
  preferredProviders: ProviderName[];
  multiTurn?: MultiTurnConfig;
  feedback?: FeedbackLoopConfig;
  workerBus?: { enabled: boolean; broadcastArtifacts: boolean };
  contextPropagation?: { enabled: boolean; includeCodebaseMap: boolean; includeMemory: boolean; maxContextTokens: number; summarizeSiblingResults: boolean };
  qualityAgent?: { enabled: boolean };
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

export interface OrchestratorConfig {
  orchestrator: {
    sessionPrefix: string;
    maxConcurrentAgents: number;
    dataDir: string;
    db: string;
    logDir: string;
    budgetEnabled?: boolean;
  };
  budget: BudgetConfig;
  providers: Record<string, ProviderConfig>;
  routing: RoutingConfig;
  supervisor?: SupervisorConfig;
  mcp?: McpConfig;
  permissions?: import("../core/permissions.ts").PermissionConfig;
  theme?: string;
  categories?: Record<string, { model?: string; tier?: import("./types.ts").ModelTier; temperature?: number; description?: string }>;
  worktree?: GitWorktreeConfig;
  backgroundAgent?: BackgroundAgentConfig;
  fastwork?: FastworkConfig;
  ultrathink?: UltrathinkConfig;
  statistics?: StatisticsConfig;
  recovery?: SessionRecoveryConfig;
  acp?: AcpConfig;
  sdkServer?: SdkServerConfig;
  webInterface?: WebInterfaceConfig;
  refactor?: RefactorConfig;
  toolBranching?: Record<string, { editTool?: string; writeTool?: string; additionalTools?: string[]; guidelines?: string }>;
  doomLoop?: import("../core/doom-loop.ts").DoomLoopConfig;
}

// ── Agent Profile ─────────────────────────────────────────────────────

export interface AgentProfile {
  name: string;
  provider: string;
  model: ModelTier | string;
  role: string;
  maxBudgetUsd: number;
  requires: string[];
  worktree: boolean;
  systemPrompt: string;
  maxTurns?: number;
  skills?: string[];
  mcpServers?: string[];
}

// ── Task Types ────────────────────────────────────────────────────────

export interface Task {
  id: string;
  prompt: string;
  agentName: string | null;
  status: TaskStatus;
  tier: ModelTier;
  parentTaskId: string | null;
  result: string | null;
  tokenUsage: number;
  costUsd: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface TaskAssignment {
  taskId: string;
  agentName: string;
  assignedAt: string;
}

// ── Message Types ─────────────────────────────────────────────────────

export interface AgentMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  taskRef: string | null;
  timestamp: string;
  read: boolean;
}

// ── Session Types ─────────────────────────────────────────────────────

export interface SessionInfo {
  name: string;
  agentName: string;
  pid: number | null;
  createdAt: string;
  status: AgentStatus;
}

// ── Log Types ─────────────────────────────────────────────────────────

export type LogEvent =
  | "start"
  | "output"
  | "complete"
  | "error"
  | "budget_warning"
  | "budget_exceeded"
  | "health_check"
  | "session_created"
  | "session_destroyed";

export interface LogEntry {
  ts: string;
  agent: string;
  task: string;
  event: LogEvent;
  data?: Record<string, unknown>;
  tokens?: number;
  cost?: number;
}

// ── File Lock ─────────────────────────────────────────────────────────

export interface FileLock {
  filePath: string;
  agentName: string;
  taskId: string;
  lockedAt: string;
}

// ── Orchestration Patterns ────────────────────────────────────────────

export interface HandoffOptions {
  waitForCompletion?: boolean;
  timeout?: number;
  context?: Record<string, unknown>;
}

export interface AssignOptions {
  priority?: number;
  timeout?: number;
}

export interface SendMessageOptions {
  taskRef?: string;
}

// ── Health ─────────────────────────────────────────────────────────────

export interface HealthStatus {
  agentName: string;
  sessionAlive: boolean;
  lastHeartbeat: string | null;
  consecutiveFailures: number;
}

// ── File Ownership ────────────────────────────────────────────────────

export interface FileOwnership {
  pattern: string;       // glob pattern like "src/auth/**"
  agentName: string;
  taskId: string;
  permission: "owns" | "reads";
  declaredAt: string;
}

export interface OwnershipDeclaration {
  agentName: string;
  taskId: string;
  owns: string[];        // glob patterns of files agent can write
  reads: string[];       // glob patterns of files agent can only read
}

export interface ConflictCheckResult {
  allowed: boolean;
  conflicts: Array<{
    pattern: string;
    heldBy: string;
    permission: "owns" | "reads";
  }>;
}

// ── Sandbox & Security Types ────────────────────────────────────────

export type SafetyLevel = "safe" | "prompt" | "forbidden";

export type RuleDecision = "allow" | "prompt" | "forbidden";

export interface SandboxConfig {
  environmentPolicy: "all" | "core" | "none";
  excludeEnvPatterns: string[];
  outputMaxBytes: number;
  agentMaxDepth: number;
}

// ── REPL Conversation Types ──────────────────────────────────────────

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  agentName?: string;
  tier?: ModelTier;
  timestamp: string;
}

// ── Self-Critique Quality Gate ──────────────────────────────────────

export interface CritiqueResult {
  passes: boolean;
  issues: string[];
  improvements: string[];
  confidence: "low" | "medium" | "high";
}

export interface CritiqueChecklist {
  patternAdherence: boolean;
  errorHandling: boolean;
  completeness: boolean;
  codeQuality: boolean;
}

// ── Spec Creation Pipeline ──────────────────────────────────────────

export type SpecPhase = "discovery" | "requirements" | "research" | "spec" | "critique" | "planning" | "validation";

export interface SpecConfig {
  phases: SpecPhase[];
  skipResearch?: boolean;
}

export interface SpecResult {
  requirements: string[];
  acceptanceCriteria: string[];
  implementationSteps: string[];
  risks: string[];
  estimatedComplexity: "simple" | "standard" | "complex";
}

// ── QA Validation Loop ──────────────────────────────────────────────

export interface QAConfig {
  maxIterations: number;
  recurringIssueThreshold: number;
}

export interface QAIssue {
  description: string;
  severity: "critical" | "major" | "minor";
  file?: string;
  suggestion?: string;
}

export interface QAResult {
  passed: boolean;
  iterations: number;
  issues: QAIssue[];
  escalated: boolean;
}

// ── Smart Recovery System ───────────────────────────────────────────

export type FailureType = "broken_build" | "verification_failed" | "circular_fix" | "context_exhausted" | "timeout" | "unknown";

export type RecoveryAction = "retry" | "rollback" | "skip" | "escalate" | "change_approach";

export interface RecoveryAttempt {
  taskId: string;
  failureType: FailureType;
  approach: string;
  timestamp: string;
  success: boolean;
}

export interface RecoveryDecision {
  action: RecoveryAction;
  reason: string;
  rollbackTarget?: string;
}

// ── AI Complexity Assessment ────────────────────────────────────────

export interface ComplexityResult {
  level: "simple" | "standard" | "complex";
  confidence: number;
  factors: string[];
  suggestedPhases: string[];
  estimatedFiles: number;
  integrations: string[];
}

// ── Phase-Specific Model Config ─────────────────────────────────────

export type ExecutionPhase = "spec" | "planning" | "coding" | "review" | "qa" | "fix";

export interface PhaseModelConfig {
  model: ModelTier;
  thinkingLevel?: "low" | "medium" | "high";
  maxTokens?: number;
}

// ── Codebase Map ────────────────────────────────────────────────────

export interface FileEntry {
  path: string;
  purpose: string;
  lastAgent?: string;
  lastUpdated: string;
}

// ── Structured Task Logger ──────────────────────────────────────────

export type LogPhase = "spec" | "planning" | "coding" | "review" | "qa" | "fix" | "general";

export interface ToolLogEntry {
  tool: string;
  detail?: string;
  phase: LogPhase;
  startedAt: string;
  endedAt?: string;
  success?: boolean;
  durationMs?: number;
}

// ── Session Insight Extraction ──────────────────────────────────────

export interface SessionInsights {
  subtasksCompleted: string[];
  discoveries: {
    filesUnderstood: Record<string, string>;
    patternsFound: string[];
    gotchasEncountered: string[];
  };
  whatWorked: string[];
  whatFailed: string[];
  recommendations: string[];
}

// ── Dynamic Security Profiles ───────────────────────────────────────

export interface StackProfile {
  name: string;
  detectFiles: string[];
  safeCommands: string[];
  dangerousPatterns: RegExp[];
}

// ── Semantic Merge System ───────────────────────────────────────────

export type MergeDecision = "auto_merged" | "ai_merged" | "direct_copy" | "needs_human_review" | "failed";

export interface MergeConflict {
  file: string;
  baseContent: string;
  oursContent: string;
  theirsContent: string;
  type: "add_add" | "modify_modify" | "delete_modify";
}

export interface MergeResult {
  decision: MergeDecision;
  mergedFiles: string[];
  conflicts: MergeConflict[];
  manualReviewNeeded: string[];
}

// ── Multi-Account Auto-Switch ───────────────────────────────────────

export interface AccountProfile {
  name: string;
  type: "oauth" | "api_key";
  priority: number;
  apiKey?: string;
  usageToday: number;
  dailyLimit: number;
  rateLimitedUntil?: string;
  lastUsed?: string;
}

export interface ScoredAccount {
  account: AccountProfile;
  score: number;
  reason: string;
}

// ── Prediction System ───────────────────────────────────────────────

export interface PredictionResult {
  risks: Array<{ description: string; likelihood: "low" | "medium" | "high"; mitigation: string }>;
  checklist: string[];
  estimatedDuration: string;
  suggestedApproach: string;
}

// ── Ideation System ─────────────────────────────────────────────────

export type IdeationDimension = "improvements" | "quality" | "performance" | "security" | "documentation" | "ux";

export interface Idea {
  dimension: IdeationDimension;
  title: string;
  description: string;
  priority: "low" | "medium" | "high";
  effort: "low" | "medium" | "high";
  files?: string[];
}

export interface IdeationResult {
  ideas: Idea[];
  summary: string;
}

// ── Context Builder ─────────────────────────────────────────────────

export interface ContextChunk {
  source: string;
  content: string;
  relevance: number;
  type: "file" | "memory" | "codebase_map" | "insight";
}

// ── Semantic Prompt Cache ───────────────────────────────────────────

export interface CacheEntry {
  hash: string;
  prompt: string;
  response: string;
  model: ModelTier;
  tokens: number;
  hitCount: number;
  createdAt: string;
  lastHitAt: string;
}

export interface CacheStats {
  totalEntries: number;
  hitRate: number;
  tokensSaved: number;
  costSaved: number;
}

// ── Decision Registry ───────────────────────────────────────────────

export type DecisionStatus = "active" | "superseded" | "revoked";

export interface ArchitecturalDecision {
  id: string;
  title: string;
  decision: string;
  context: string;
  decidedBy: string;
  status: DecisionStatus;
  tags: string[];
  createdAt: string;
  supersededBy?: string;
}

// ── Conflict Watcher ────────────────────────────────────────────────

export type ConflictSeverity = "info" | "warning" | "critical";

export interface LogicalConflict {
  id: string;
  agentA: string;
  agentB: string;
  description: string;
  severity: ConflictSeverity;
  files: string[];
  detectedAt: string;
  resolved: boolean;
}

// ── Port Manager ────────────────────────────────────────────────────

export interface PortAllocation {
  port: number;
  agentName: string;
  taskId: string;
  purpose: string;
  allocatedAt: string;
}

// ── Crash Recovery ──────────────────────────────────────────────────

export interface CleanupEntry {
  id: string;
  type: "process" | "lock" | "worktree" | "port" | "temp_file";
  target: string;
  agentName: string;
  registeredAt: string;
}

// ── Cost Estimator ──────────────────────────────────────────────────

export interface CostEstimate {
  singleAgent: { model: ModelTier; estimatedTokens: number; estimatedCostUsd: number; estimatedDurationMs: number };
  multiAgent: { agents: number; estimatedTokens: number; estimatedCostUsd: number; estimatedDurationMs: number; overheadRatio: number };
  recommendation: "single" | "multi";
  reason: string;
  savingsUsd: number;
}

// ── Checkpoint System ───────────────────────────────────────────────

export interface Checkpoint {
  id: string;
  taskId: string;
  agentName: string;
  sha: string;
  label: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

// ── Provider Capability System ──────────────────────────────────────

export type ProviderName = "claude" | "codex" | "gemini" | "kiro";

export interface ProviderCapability {
  name: ProviderName;
  models: string[];
  strengths: string[];
  weaknesses: string[];
  maxContextTokens: number;
  supportsStreaming: boolean;
  supportsToolUse: boolean;
  costTier: "low" | "medium" | "high";
}

// ── Supervisor Types ────────────────────────────────────────────────

export type AgentRole = "architect" | "coder" | "reviewer" | "tester" | "researcher" | "spec-writer" | "qa" | "design" | "writer";

export interface SubTask {
  id: string;
  prompt: string;
  parentTaskId: string;
  dependencies: string[];
  provider: ProviderName;
  model: string;
  agentRole: AgentRole;
  priority: number;
  status: TaskStatus;
  result: string | null;
  estimatedTokens: number;
  actualTokens: number;
  startedAt: string | null;
  completedAt: string | null;
}

export interface DecompositionResult {
  subtasks: SubTask[];
  executionPlan: ExecutionPlan;
  estimatedTotalCost: number;
}

export interface ExecutionPlan {
  phases: ExecutionPhaseGroup[];
  totalEstimatedDurationMs: number;
  strategy: "sequential" | "parallel" | "pipeline";
}

export interface ExecutionPhaseGroup {
  name: string;
  subtaskIds: string[];
  parallelizable: boolean;
}

// ── Worker Types ────────────────────────────────────────────────────

export type WorkerStatus = "spawning" | "running" | "completed" | "failed" | "timeout" | "cancelled";

export interface WorkerState {
  id: string;
  agentName: string;
  subtaskId: string;
  provider: ProviderName;
  model: string;
  status: WorkerStatus;
  progress: number;
  startedAt: string;
  lastActivityAt: string;
  result: string | null;
  error: string | null;
  tokenUsage: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  currentTurn: number;
  maxTurns: number;
  turnHistory: WorkerTurnProgress[];
  corrections: string[];
  intermediateResults: string[];
  traceContext?: { traceId: string; spanId: string };
}

// ── Result Collection ───────────────────────────────────────────────

export interface CollectedResult {
  subtaskId: string;
  agentName: string;
  provider: ProviderName;
  result: string;
  files: string[];
  tokenUsage: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  role: AgentRole;
  domain: string;
}

export interface FileManifestEntry {
  file: string;
  worker: string;
  action: "created" | "modified";
}

export interface AggregatedResult {
  taskId: string;
  subtaskResults: CollectedResult[];
  mergedOutput: string;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  totalDurationMs: number;
  conflicts: string[];
  files: FileManifestEntry[];
  success: boolean;
}

// ── Multi-Turn Worker Types ─────────────────────────────────
export interface MultiTurnConfig {
  defaultMaxTurns: number;
  simpleMaxTurns: number;
  standardMaxTurns: number;
  complexMaxTurns: number;
  checkpointIntervalTurns: number;
  progressPollIntervalMs: number;
  idleTimeoutMs: number;
}

export interface WorkerTurnProgress {
  workerId: string;
  currentTurn: number;
  maxTurns: number;
  lastToolUse: string | null;
  lastOutput: string | null;
  filesModified: string[];
  testsRun: boolean;
  testsPassed: boolean | null;
  timestamp: string;
}

// ── Worker Bus Types ────────────────────────────────────────
export interface WorkerBusMarker {
  type: WorkerMessageType;
  target: string;
  content: string;
  metadata?: Record<string, unknown>;
  raw: string;
}

export type WorkerMessageType = "artifact" | "request" | "status" | "warning" | "dependency";

export interface WorkerMessage {
  id: string;
  from: string;
  to: string | "all";
  type: WorkerMessageType;
  content: string;
  metadata?: { files?: string[]; apis?: string[]; schemas?: string[]; ports?: number[] };
  taskRef: string;
  subtaskRef: string;
  timestamp: string;
}

export interface WorkerManifest {
  agentName: string;
  subtaskId: string;
  role: AgentRole;
  domain: string;
  prompt: string;
}

// ── Feedback Loop Types ─────────────────────────────────────
export type FeedbackAction = "continue" | "correct" | "checkpoint" | "qa_review"
  | "critique" | "abort" | "retry_with_context" | "recovery";

export interface FeedbackCheckpoint {
  workerId: string;
  subtaskId: string;
  turn: number;
  capturedOutput: string;
  filesModified: string[];
  assessment: FeedbackAction;
  correctionSent: string | null;
  timestamp: string;
}

export interface FeedbackLoopConfig {
  enabled: boolean;
  checkIntervalMs: number;
  maxCorrections: number;
  qualityGateOnComplete: boolean;
  qaLoopOnFail: boolean;
}

export interface SupervisorAssessment {
  action: FeedbackAction;
  reason: string;
  correction?: string;
  confidence: number;
}

// ── Context Propagation Types ───────────────────────────────
export interface WorkerContext {
  parentTask: { id: string; prompt: string; decompositionStrategy: string };
  siblings: WorkerManifest[];
  completedSiblings: SiblingResult[];
  codebaseContext: string;
  memoryContext: string;
  workerBusMessages: WorkerMessage[];
}

export interface SiblingResult {
  agentName: string;
  subtaskId: string;
  role: AgentRole;
  domain: string;
  summary: string;
  filesChanged: string[];
  apisCreated: string[];
  schemasCreated: string[];
}

// ── Git Worktree Isolation ──────────────────────────────────────────
export interface GitWorktreeConfig {
  enabled: boolean;
  baseDir?: string;
  autoCleanup?: boolean;
}

// ── Background Agent ────────────────────────────────────────────────
export interface BackgroundAgentConfig {
  maxConcurrent?: number;
  defaultProvider?: ProviderName;
  defaultModel?: string;
  timeoutMs?: number;
}

// ── Fastwork Mode ───────────────────────────────────────────────────
export interface FastworkConfig {
  enabled?: boolean;
  defaultModel?: string;
  maxTurns?: number;
  forceMultiAgent?: boolean;
  forcePlanning?: boolean;
}

// ── Ultrathink Mode ─────────────────────────────────────────────────
export interface UltrathinkConfig {
  enabled?: boolean;
  defaultModel?: string;
  maxTurns?: number;
  temperature?: number;
  forcePlanning?: boolean;
  forceQA?: boolean;
  forceIdeation?: boolean;
}

// ── Statistics ──────────────────────────────────────────────────────
export interface StatisticsConfig {
  enabled?: boolean;
  persistPath?: string;
  maxEntries?: number;
}

// ── Session Recovery ────────────────────────────────────────────────
export interface SessionRecoveryConfig {
  enabled?: boolean;
  maxAttemptsPerStrategy?: number;
  strategies?: string[];
}

// ── ACP Server ──────────────────────────────────────────────────────
export interface AcpConfig {
  enabled?: boolean;
  maxSessions?: number;
  sessionTimeoutMs?: number;
}

// ── SDK Server ──────────────────────────────────────────────────────
export interface SdkServerConfig {
  enabled?: boolean;
  port?: number;
  host?: string;
  authToken?: string;
}

// ── Web Interface ───────────────────────────────────────────────────
export interface WebInterfaceConfig {
  enabled?: boolean;
  port?: number;
  host?: string;
  authEnabled?: boolean;
}

// ── Refactor Config ─────────────────────────────────────────────────
export interface RefactorConfig {
  testCommand?: string;
  maxExploreAgents?: number;
  abortOnTestFail?: boolean;
}
