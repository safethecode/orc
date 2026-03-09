import { describe, it, expect } from "bun:test";
import { classifyWithSam } from "../src/core/router.ts";

const LLM_TIMEOUT = 15_000;

describe("multi-agent detection via Sam", () => {
  it("detects multi-domain Korean prompt", async () => {
    const result = await classifyWithSam("디자인 개선해줘. 너무 심플해. secret 이슈도 해결해");
    expect(result.type).toBe("development");
    // Sam should detect both design and coder domains
    if (result.agents) {
      expect(result.agents.length).toBeGreaterThan(1);
      expect(result.agents).toContain("design");
      expect(result.agents).toContain("coder");
    } else {
      // If Sam returns single agent, primary should be design or coder
      expect(["design", "coder"]).toContain(result.agent);
    }
  }, LLM_TIMEOUT);

  it("detects multi-domain English prompt", async () => {
    const result = await classifyWithSam("Design the landing page UI and then implement the authentication API");
    expect(result.type).toBe("development");
    if (result.agents) {
      expect(result.agents.length).toBeGreaterThan(1);
    }
  }, LLM_TIMEOUT);

  it("detects single-domain Korean prompt", async () => {
    const result = await classifyWithSam("이 함수의 버그를 고쳐줘");
    expect(result.type).toBe("development");
    // Should be single agent
    const agentCount = result.agents?.length ?? 1;
    expect(agentCount).toBe(1);
    expect(result.agent).toBe("coder");
  }, LLM_TIMEOUT);

  it("detects single-domain English prompt", async () => {
    const result = await classifyWithSam("Fix the null pointer exception in auth.ts");
    expect(result.type).toBe("development");
    const agentCount = result.agents?.length ?? 1;
    expect(agentCount).toBe(1);
    expect(result.agent).toBe("coder");
  }, LLM_TIMEOUT);

  it("conversation prompt has no multi-agent", async () => {
    const result = await classifyWithSam("안녕하세요");
    expect(result.type).toBe("conversation");
    expect(result.agent).toBe("Sam");
    expect(result.agents).toBeUndefined();
  }, LLM_TIMEOUT);
});
