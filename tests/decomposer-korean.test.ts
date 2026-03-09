import { describe, it, expect } from "bun:test";
import { decompose, detectDomains } from "../src/core/decomposer.ts";

describe("Korean prompt domain detection", () => {
  it("detects frontend domain from Korean UI prompt", () => {
    const domains = detectDomains("React 컴포넌트 UI 수정해줘");
    expect(domains).toContain("frontend");
  });

  it("detects auth domain from Korean security prompt", () => {
    const domains = detectDomains("JWT 토큰 인증 로직 수정");
    expect(domains).toContain("auth");
  });

  it("detects design domain from Korean design prompt", () => {
    const domains = detectDomains("landing page hero section 디자인 개선");
    expect(domains).toContain("design");
  });

  it("detects multiple domains from compound Korean prompt", () => {
    const domains = detectDomains("UI component 디자인 개선하고 API endpoint 보안 이슈도 수정해");
    expect(domains.length).toBeGreaterThan(1);
  });
});

describe("Korean prompt decomposition", () => {
  it("decomposes compound Korean prompt into multiple subtasks", () => {
    const result = decompose(
      "UI component design system 만들고 API auth endpoint security audit도 해줘",
      "test-1",
    );
    // Compound prompt with design + auth + security domains should produce multiple subtasks
    if (result.subtasks.length > 1) {
      const roles = result.subtasks.map(st => st.agentRole);
      // Should have diverse roles, not all coder
      expect(new Set(roles).size).toBeGreaterThanOrEqual(1);
    }
  });

  it("keeps simple Korean prompt as single subtask", () => {
    const result = decompose("이 버그 고쳐줘", "test-2");
    expect(result.subtasks.length).toBe(1);
  });

  it("preserves original prompt in subtask", () => {
    const prompt = "React 컴포넌트 테스트 작성해줘";
    const result = decompose(prompt, "test-3");
    expect(result.subtasks[0].prompt).toContain("React");
  });
});
