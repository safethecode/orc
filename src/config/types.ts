// ── Agent & Provider Types ────────────────────────────────────────────

export type ModelTier = "haiku" | "sonnet" | "opus";

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

export interface ProviderConfig {
  command: string;
  subcommand?: string;
  defaultModel: ModelTier | null;
  flags: string[];
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
  globalDailyLimit: number;
  warningThreshold: number;
}

export interface OrchestratorConfig {
  orchestrator: {
    sessionPrefix: string;
    maxConcurrentAgents: number;
    dataDir: string;
    db: string;
    logDir: string;
  };
  budget: BudgetConfig;
  providers: Record<string, ProviderConfig>;
  routing: RoutingConfig;
}

// ── Agent Profile ─────────────────────────────────────────────────────

export interface AgentProfile {
  name: string;
  provider: string;
  model: ModelTier;
  role: string;
  maxBudgetUsd: number;
  requires: string[];
  worktree: boolean;
  systemPrompt: string;
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
