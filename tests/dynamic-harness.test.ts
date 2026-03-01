import { describe, it, expect } from "bun:test";
import { buildDynamicHarness, getProjectFingerprint, getTaskType } from "../src/agents/dynamic-harness.ts";

describe("DynamicHarness", () => {
  const baseOpts = {
    agentName: "test-agent",
    role: "coder" as const,
    provider: "claude" as const,
    parentTaskId: "task-123",
    isWorker: false,
    projectDir: process.cwd(),
    prompt: "Fix the authentication bug in login.ts",
  };

  describe("buildDynamicHarness", () => {
    it("includes static harness layers", () => {
      const result = buildDynamicHarness(baseOpts);
      expect(result.systemPrompt).toContain("test-agent");
      expect(result.systemPrompt).toContain("Software Engineer");
    });

    it("includes project context (Layer 6)", () => {
      const result = buildDynamicHarness(baseOpts);
      expect(result.systemPrompt).toContain("Project Context");
      // Our project uses TypeScript + Bun
      expect(result.systemPrompt).toContain("typescript");
      expect(result.systemPrompt).toContain("bun");
    });

    it("includes task strategy (Layer 7)", () => {
      const result = buildDynamicHarness(baseOpts);
      // "Fix the authentication bug" should trigger bug_fix strategy
      expect(result.systemPrompt).toContain("Strategy: Bug Fix");
      expect(result.systemPrompt).toContain("REPRODUCE");
      expect(result.systemPrompt).toContain("ISOLATE");
    });

    it("includes quality requirements", () => {
      const result = buildDynamicHarness(baseOpts);
      expect(result.systemPrompt).toContain("Quality Requirements");
      expect(result.systemPrompt).toContain("ZERO TOLERANCE");
    });

    it("includes recovery protocol (Layer 8)", () => {
      const result = buildDynamicHarness(baseOpts);
      expect(result.systemPrompt).toContain("Recovery Protocol");
      expect(result.systemPrompt).toContain("re-read the file");
    });

    it("injects previous failures context", () => {
      const result = buildDynamicHarness({
        ...baseOpts,
        previousFailures: [
          "Tried modifying auth.ts line 42 but edit didn't match",
          "Test suite failed: missing import in login.test.ts",
        ],
      });
      expect(result.systemPrompt).toContain("PREVIOUS ATTEMPTS THAT FAILED");
      expect(result.systemPrompt).toContain("different approach");
    });

    it("includes git status when provided", () => {
      const result = buildDynamicHarness({
        ...baseOpts,
        gitStatus: "M src/auth.ts\nM src/login.ts",
      });
      expect(result.systemPrompt).toContain("Git status");
      expect(result.systemPrompt).toContain("src/auth.ts");
    });

    it("includes relevant files when provided", () => {
      const result = buildDynamicHarness({
        ...baseOpts,
        relevantFiles: ["/proj/src/auth.ts", "/proj/src/login.ts"],
      });
      expect(result.systemPrompt).toContain("Relevant files");
    });

    it("includes worker coordination for workers", () => {
      const result = buildDynamicHarness({
        ...baseOpts,
        isWorker: true,
        turnBudget: 5,
        siblingContext: "worker-a: handling auth.ts\nworker-b: handling db.ts",
      });
      expect(result.systemPrompt).toContain("Worker Coordination");
      expect(result.systemPrompt).toContain("worker-a");
      expect(result.systemPrompt).toContain("Turn budget: 5");
      expect(result.systemPrompt).toContain("LOW BUDGET");
    });

    it("estimates tokens correctly", () => {
      const result = buildDynamicHarness(baseOpts);
      expect(result.tokenEstimate).toBeGreaterThan(0);
      // Dynamic harness should be larger than static
      expect(result.tokenEstimate).toBeGreaterThan(200);
    });
  });

  describe("getProjectFingerprint", () => {
    it("detects current project correctly", () => {
      const fp = getProjectFingerprint(process.cwd());
      expect(fp.language).toBe("typescript");
      expect(fp.packageManager).toBe("bun");
      expect(fp.keyDirs).toContain("src");
    });
  });

  describe("getTaskType", () => {
    it("classifies bug fix prompts", () => {
      expect(getTaskType("Fix the login error")).toBe("bug_fix");
      expect(getTaskType("The API crashes on null input")).toBe("bug_fix");
      expect(getTaskType("인증 버그 수정")).toBe("bug_fix");
    });

    it("classifies feature prompts", () => {
      expect(getTaskType("Add a new user registration endpoint")).toBe("feature");
      expect(getTaskType("Implement dark mode")).toBe("feature");
      expect(getTaskType("새로운 기능 구현")).toBe("feature");
    });

    it("classifies refactor prompts", () => {
      expect(getTaskType("Refactor the authentication module")).toBe("refactor");
      expect(getTaskType("Rename all occurrences of oldName")).toBe("refactor");
    });

    it("classifies test prompts", () => {
      expect(getTaskType("Write unit tests for the auth service")).toBe("test_write");
      expect(getTaskType("Add test coverage for login")).toBe("test_write");
    });

    it("classifies review prompts", () => {
      expect(getTaskType("Review the recent changes to auth.ts")).toBe("review");
      expect(getTaskType("코드 리뷰해줘")).toBe("review");
    });

    it("classifies debug prompts", () => {
      expect(getTaskType("Debug why the server hangs on startup")).toBe("debug");
      expect(getTaskType("Investigate the root cause of timeouts")).toBe("debug");
    });

    it("falls back to generic", () => {
      expect(getTaskType("hello")).toBe("generic");
      expect(getTaskType("도와줘")).toBe("generic");
    });
  });

  describe("strategy selection matches task type", () => {
    it("bug fix prompt gets bug fix strategy", () => {
      const result = buildDynamicHarness({ ...baseOpts, prompt: "Fix the broken API endpoint" });
      expect(result.systemPrompt).toContain("Strategy: Bug Fix");
    });

    it("feature prompt gets feature strategy", () => {
      const result = buildDynamicHarness({ ...baseOpts, prompt: "Add a new caching layer" });
      expect(result.systemPrompt).toContain("Strategy: Feature Implementation");
    });

    it("refactor prompt gets refactor strategy", () => {
      const result = buildDynamicHarness({ ...baseOpts, prompt: "Refactor the database module" });
      expect(result.systemPrompt).toContain("Strategy: Refactoring");
    });

    it("test prompt gets test strategy", () => {
      const result = buildDynamicHarness({ ...baseOpts, prompt: "Write tests for the parser" });
      expect(result.systemPrompt).toContain("Strategy: Test Writing");
    });

    it("debug prompt gets debug strategy", () => {
      const result = buildDynamicHarness({ ...baseOpts, prompt: "Debug the memory leak" });
      expect(result.systemPrompt).toContain("Strategy: Debugging");
    });
  });
});
