import { describe, it, expect } from "bun:test";
import { buildHarness } from "../src/agents/harness.ts";
import type { AgentRole, ProviderName } from "../src/config/types.ts";

const ROLES: AgentRole[] = ["architect", "coder", "reviewer", "tester", "researcher", "spec-writer"];
const PROVIDERS: ProviderName[] = ["claude", "codex", "gemini", "kiro"];

describe("buildHarness", () => {
  // ── Layer 1: Identity ──────────────────────────────────────────────

  it("identity includes agentName, role title, kind, and taskId", () => {
    const { systemPrompt } = buildHarness({
      agentName: "worker-abc12345",
      role: "coder",
      provider: "claude",
      parentTaskId: "task-xyz",
      isWorker: true,
    });
    expect(systemPrompt).toContain("worker-abc12345");
    expect(systemPrompt).toContain("Software Engineer");
    expect(systemPrompt).toContain("worker");
    expect(systemPrompt).toContain("task-xyz");
  });

  it("assistant kind when isWorker=false", () => {
    const { systemPrompt } = buildHarness({
      agentName: "repl-agent",
      role: "coder",
      provider: "claude",
      parentTaskId: "repl",
      isWorker: false,
    });
    expect(systemPrompt).toContain("as a assistant");
  });

  it("maps all roles to human-readable titles", () => {
    const expected: Record<AgentRole, string> = {
      architect: "Software Architect",
      coder: "Software Engineer",
      reviewer: "Code Reviewer",
      tester: "Test Engineer",
      researcher: "Research Analyst",
      "spec-writer": "Specification Writer",
    };
    for (const role of ROLES) {
      const { systemPrompt } = buildHarness({
        agentName: "w",
        role,
        provider: "claude",
        parentTaskId: "t",
        isWorker: true,
      });
      expect(systemPrompt).toContain(expected[role]);
    }
  });

  // ── Layer 2: Protocol ──────────────────────────────────────────────

  it("includes protocol block for workers", () => {
    const { systemPrompt } = buildHarness({
      agentName: "w",
      role: "coder",
      provider: "claude",
      parentTaskId: "t",
      isWorker: true,
    });
    expect(systemPrompt).toContain("## Output Protocol");
    expect(systemPrompt).toContain("[ORC:DONE]");
    expect(systemPrompt).toContain("[ORC:PROGRESS");
    expect(systemPrompt).toContain("[ORC:RESULT");
    expect(systemPrompt).toContain("[ORC:BUS:");
  });

  it("omits protocol block for non-workers", () => {
    const { systemPrompt } = buildHarness({
      agentName: "a",
      role: "coder",
      provider: "claude",
      parentTaskId: "t",
      isWorker: false,
    });
    expect(systemPrompt).not.toContain("## Output Protocol");
    expect(systemPrompt).not.toContain("[ORC:DONE]");
  });

  // ── Layer 3: Constraints ───────────────────────────────────────────

  it("includes constraints section for every role", () => {
    for (const role of ROLES) {
      const { systemPrompt } = buildHarness({
        agentName: "w",
        role,
        provider: "claude",
        parentTaskId: "t",
        isWorker: true,
      });
      expect(systemPrompt).toContain("## Constraints");
    }
  });

  it("reviewer constraints forbid file modification", () => {
    const { systemPrompt } = buildHarness({
      agentName: "w",
      role: "reviewer",
      provider: "claude",
      parentTaskId: "t",
      isWorker: true,
    });
    expect(systemPrompt).toContain("MUST NOT modify files");
    expect(systemPrompt).toContain("file:line");
  });

  it("tester constraints forbid production code modification", () => {
    const { systemPrompt } = buildHarness({
      agentName: "w",
      role: "tester",
      provider: "claude",
      parentTaskId: "t",
      isWorker: true,
    });
    expect(systemPrompt).toContain("MUST NOT modify production code");
  });

  it("spec-writer constraints restrict to .md files", () => {
    const { systemPrompt } = buildHarness({
      agentName: "w",
      role: "spec-writer",
      provider: "claude",
      parentTaskId: "t",
      isWorker: true,
    });
    expect(systemPrompt).toContain("only .md files");
    expect(systemPrompt).toContain("acceptance criteria");
  });

  // ── Layer 4: Provider Hints ────────────────────────────────────────

  it("claude provider has no hints section", () => {
    const { systemPrompt } = buildHarness({
      agentName: "w",
      role: "coder",
      provider: "claude",
      parentTaskId: "t",
      isWorker: true,
    });
    expect(systemPrompt).not.toContain("## Provider");
  });

  it("codex provider includes tool call hint", () => {
    const { systemPrompt } = buildHarness({
      agentName: "w",
      role: "coder",
      provider: "codex",
      parentTaskId: "t",
      isWorker: true,
    });
    expect(systemPrompt).toContain("## Provider");
    expect(systemPrompt).toContain("tool calls for file edits");
  });

  it("gemini provider includes conciseness hint", () => {
    const { systemPrompt } = buildHarness({
      agentName: "w",
      role: "coder",
      provider: "gemini",
      parentTaskId: "t",
      isWorker: true,
    });
    expect(systemPrompt).toContain("Be concise");
  });

  it("kiro provider includes inline code hint", () => {
    const { systemPrompt } = buildHarness({
      agentName: "w",
      role: "coder",
      provider: "kiro",
      parentTaskId: "t",
      isWorker: true,
    });
    expect(systemPrompt).toContain("No tool use");
    expect(systemPrompt).toContain("spec-driven");
  });

  // ── Token estimate ─────────────────────────────────────────────────

  it("tokenEstimate is positive and roughly proportional to prompt length", () => {
    const { systemPrompt, tokenEstimate } = buildHarness({
      agentName: "w",
      role: "coder",
      provider: "claude",
      parentTaskId: "t",
      isWorker: true,
    });
    expect(tokenEstimate).toBeGreaterThan(0);
    expect(tokenEstimate).toBe(Math.ceil(systemPrompt.length / 4));
  });

  it("worker prompt is longer than assistant prompt (protocol adds tokens)", () => {
    const base = { agentName: "w", role: "coder" as AgentRole, provider: "claude" as ProviderName, parentTaskId: "t" };
    const worker = buildHarness({ ...base, isWorker: true });
    const assistant = buildHarness({ ...base, isWorker: false });
    expect(worker.tokenEstimate).toBeGreaterThan(assistant.tokenEstimate);
  });

  // ── Layer composition ──────────────────────────────────────────────

  it("all four layers present for a codex worker", () => {
    const { systemPrompt } = buildHarness({
      agentName: "worker-full",
      role: "architect",
      provider: "codex",
      parentTaskId: "task-1",
      isWorker: true,
    });
    // Layer 1 — Identity
    expect(systemPrompt).toContain("worker-full");
    expect(systemPrompt).toContain("Software Architect");
    // Layer 2 — Protocol
    expect(systemPrompt).toContain("## Output Protocol");
    // Layer 3 — Constraints
    expect(systemPrompt).toContain("## Constraints");
    expect(systemPrompt).toContain("backward compatibility");
    // Layer 4 — Provider
    expect(systemPrompt).toContain("## Provider");
  });

  it("non-worker claude has only identity + constraints (2 layers)", () => {
    const { systemPrompt } = buildHarness({
      agentName: "repl",
      role: "researcher",
      provider: "claude",
      parentTaskId: "repl",
      isWorker: false,
    });
    expect(systemPrompt).toContain("Research Analyst");
    expect(systemPrompt).toContain("## Constraints");
    expect(systemPrompt).not.toContain("## Output Protocol");
    expect(systemPrompt).not.toContain("## Provider");
  });

  // ── Cross-matrix: every role × every provider compiles ─────────────

  it("produces valid output for all role × provider combinations", () => {
    for (const role of ROLES) {
      for (const provider of PROVIDERS) {
        const result = buildHarness({
          agentName: `w-${role}-${provider}`,
          role,
          provider,
          parentTaskId: "t",
          isWorker: true,
        });
        expect(result.systemPrompt.length).toBeGreaterThan(0);
        expect(result.tokenEstimate).toBeGreaterThan(0);
      }
    }
  });
});
