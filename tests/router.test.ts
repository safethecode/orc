import { describe, it, expect } from "bun:test";
import { routeTask, suggestAgent, isDevelopmentTask } from "../src/core/router.ts";
import type { RoutingConfig } from "../src/config/types.ts";

const config: RoutingConfig = {
  tiers: {
    simple: {
      model: "haiku",
      keywords: ["format", "rename", "typo", "lint", "style"],
    },
    medium: {
      model: "sonnet",
      keywords: ["refactor", "test", "review", "implement", "fix"],
    },
    complex: {
      model: "opus",
      keywords: ["architect", "design", "security", "optimize", "migrate"],
    },
  },
};

describe("routeTask", () => {
  it("routes simple task with 'rename' keyword to haiku", () => {
    const result = routeTask("rename the variable foo to bar", config);
    expect(result.tier).toBe("simple");
    expect(result.model).toBe("haiku");
    expect(result.multiAgent).toBe(false);
  });

  it("routes medium task with 'refactor' to sonnet", () => {
    const result = routeTask("refactor the auth module", config);
    expect(result.tier).toBe("medium");
    expect(result.model).toBe("sonnet");
    expect(result.multiAgent).toBe(false);
  });

  it("routes complex task with 'architect' to opus", () => {
    const result = routeTask("architect a new microservice system", config);
    expect(result.tier).toBe("complex");
    expect(result.model).toBe("opus");
  });

  it("unknown prompt falls to default (simple with 0 score)", () => {
    const result = routeTask("hello world", config);
    // No keywords match, so bestScore stays 0 and bestTier stays 'simple'
    expect(result.model).toBe("haiku");
    expect(result.multiAgent).toBe(false);
  });

  it("multi-agent triggers on keyword 'and then'", () => {
    const result = routeTask(
      "implement the auth module and then review the database layer",
      config,
    );
    expect(result.multiAgent).toBe(true);
  });

  it("multi-agent triggers on long prompts with multiple domains", () => {
    // 3+ distinct keyword matches across tiers triggers multiAgentByDomains
    const result = routeTask(
      "rename variables, refactor code, and architect the design",
      config,
    );
    expect(result.multiAgent).toBe(true);
  });

  it("returns reason with keyword match count", () => {
    const result = routeTask("format and lint the code", config);
    expect(result.reason).toContain("keyword");
  });
});

describe("suggestAgent", () => {
  it("returns 'architect' for complex tier", () => {
    expect(suggestAgent("complex")).toBe("architect");
  });

  it("returns 'coder' for medium tier", () => {
    expect(suggestAgent("medium")).toBe("coder");
  });

  it("returns 'coder' for simple tier without prompt", () => {
    expect(suggestAgent("simple")).toBe("coder");
  });

  it("returns 'Sam' for simple tier with conversational prompt", () => {
    expect(suggestAgent("simple", "hello")).toBe("Sam");
    expect(suggestAgent("simple", "안녕")).toBe("Sam");
    expect(suggestAgent("simple", "지금은?")).toBe("Sam");
    expect(suggestAgent("simple", "thanks")).toBe("Sam");
  });

  it("returns 'coder' for simple tier with dev-like prompt", () => {
    expect(suggestAgent("simple", "fix the typo in main.py")).toBe("coder");
    expect(suggestAgent("simple", "rename the function in utils.ts")).toBe("coder");
  });
});

describe("isDevelopmentTask", () => {
  it("detects file extensions as dev tasks", () => {
    expect(isDevelopmentTask("fix main.py")).toBe(true);
    expect(isDevelopmentTask("update config.yml")).toBe(true);
  });

  it("detects code keywords as dev tasks", () => {
    expect(isDevelopmentTask("import the module and export it")).toBe(true);
    expect(isDevelopmentTask("fix the bug in auth")).toBe(true);
  });

  it("detects Korean dev terms", () => {
    expect(isDevelopmentTask("코드 수정해줘")).toBe(true);
    expect(isDevelopmentTask("테스트 돌려봐")).toBe(true);
  });

  it("returns false for conversational prompts", () => {
    expect(isDevelopmentTask("hello")).toBe(false);
    expect(isDevelopmentTask("what time is it?")).toBe(false);
    expect(isDevelopmentTask("고마워")).toBe(false);
  });
});
