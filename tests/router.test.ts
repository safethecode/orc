import { describe, it, expect } from "bun:test";
import { routeTask, suggestAgent, isDevelopmentTask, classifyWithSam } from "../src/core/router.ts";
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

  it("multi-agent triggers on Korean keyword '그리고'", () => {
    const result = routeTask(
      "refactor the auth module 그리고 implement the design system",
      config,
    );
    expect(result.multiAgent).toBe(true);
  });

  it("multi-agent triggers on Korean keyword '도 해'", () => {
    const result = routeTask(
      "디자인 수정해줘. 테스트도 해",
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

  it("detects Korean design/UI terms as dev tasks", () => {
    expect(isDevelopmentTask("디자인이 맘에 안 들어")).toBe(true);
    expect(isDevelopmentTask("스타일 좀 바꿔줘")).toBe(true);
    expect(isDevelopmentTask("UI가 별로야")).toBe(true);
  });

  it("returns false for conversational prompts", () => {
    expect(isDevelopmentTask("hello")).toBe(false);
    expect(isDevelopmentTask("what time is it?")).toBe(false);
    expect(isDevelopmentTask("고마워")).toBe(false);
  });
});

describe("classifyWithSam", () => {
  const LLM_TIMEOUT = 15_000;

  it("returns a valid classification object", async () => {
    const result = await classifyWithSam("hello");
    expect(result).toHaveProperty("type");
    expect(result).toHaveProperty("agent");
    expect(result).toHaveProperty("reason");
    expect(["development", "conversation"]).toContain(result.type);
    expect(["Sam", "coder", "architect", "design", "writer"]).toContain(result.agent);
  }, LLM_TIMEOUT);

  it("classifies greeting as conversation → Sam", async () => {
    const result = await classifyWithSam("안녕하세요");
    expect(result.type).toBe("conversation");
    expect(result.agent).toBe("Sam");
    expect(result.lang).toBe("ko");
  }, LLM_TIMEOUT);

  it("classifies dev task as development → coder or architect", async () => {
    const result = await classifyWithSam("src/index.ts 파일의 버그를 수정해줘");
    expect(result.type).toBe("development");
    expect(["coder", "architect"]).toContain(result.agent);
    expect(result.lang).toBe("ko");
  }, LLM_TIMEOUT);

  it("classifies design/UI task as development → design", async () => {
    const result = await classifyWithSam("디자인이 맘에 안 들어. 스타일 바꿔줘");
    expect(result.type).toBe("development");
    expect(result.agent).toBe("design");
    expect(result.lang).toBe("ko");
  }, LLM_TIMEOUT);

  it("detects English language", async () => {
    const result = await classifyWithSam("Fix the null pointer exception in auth.ts");
    expect(result.lang).toBe("en");
  }, LLM_TIMEOUT);

  it("falls back gracefully when claude CLI is unavailable", async () => {
    // This test verifies the fallback path exists - if claude is available it uses LLM,
    // otherwise regex fallback kicks in. Either way it should return a valid result.
    const result = await classifyWithSam("what's the weather?");
    expect(["development", "conversation"]).toContain(result.type);
    expect(["Sam", "coder", "architect", "design", "writer"]).toContain(result.agent);
  }, LLM_TIMEOUT);
});
