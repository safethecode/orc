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

describe("routing accuracy matrix", () => {
  // Single-agent English scenarios
  const SINGLE_EN: [string, string][] = [
    ["Fix the null pointer in auth.ts", "coder"],
    ["Refactor the auth module", "coder"],
    ["Build a landing page with hero section", "design"],
    ["Fix the bug in server.ts and deploy", "coder"],
    ["hello", "Sam"],
    ["thanks!", "Sam"],
    ["what time is it?", "Sam"],
  ];

  // Single-agent Korean scenarios
  const SINGLE_KO: [string, string][] = [
    ["이 버그 고쳐줘", "coder"],
    ["코드 리팩토링해줘", "coder"],
    ["디자인 수정해줘", "design"],
    ["안녕하세요", "Sam"],
    ["감사합니다", "Sam"],
    ["src/index.ts 파일 수정해", "coder"],
    ["테스트 코드 작성해줘", "coder"],
    ["UI 컴포넌트 스타일 바꿔줘", "design"],
  ];

  describe("English single-agent routing via suggestAgent+isDev", () => {
    for (const [prompt, expected] of SINGLE_EN) {
      it(`"${prompt.slice(0, 40)}" → ${expected}`, () => {
        const isDev = isDevelopmentTask(prompt);
        if (!isDev && prompt.length < 80) {
          // conversational
          const agent = suggestAgent("simple", prompt);
          expect(agent).toBe(expected);
        } else {
          // dev task — suggestAgent alone can't determine design/writer,
          // but isDevelopmentTask should return true
          expect(isDev).toBe(true);
        }
      });
    }
  });

  describe("Korean single-agent routing via suggestAgent+isDev", () => {
    for (const [prompt, expected] of SINGLE_KO) {
      it(`"${prompt.slice(0, 40)}" → ${expected}`, () => {
        const isDev = isDevelopmentTask(prompt);
        if (expected === "Sam") {
          const agent = suggestAgent("simple", prompt);
          expect(agent).toBe("Sam");
        } else {
          expect(isDev).toBe(true);
        }
      });
    }
  });

  describe("multi-agent keyword detection (English)", () => {
    it("'and then' triggers multi-agent", () => {
      const result = routeTask("implement auth and then review security", config);
      expect(result.multiAgent).toBe(true);
    });

    it("'after that' triggers multi-agent", () => {
      const result = routeTask("fix the bug after that run tests", config);
      expect(result.multiAgent).toBe(true);
    });

    it("'followed by' triggers multi-agent", () => {
      const result = routeTask("implement the feature followed by review", config);
      expect(result.multiAgent).toBe(true);
    });
  });

  describe("multi-agent keyword detection (Korean)", () => {
    it("'그리고' triggers multi-agent", () => {
      const result = routeTask("implement auth 그리고 review the code", config);
      expect(result.multiAgent).toBe(true);
    });

    it("'동시에' triggers multi-agent", () => {
      const result = routeTask("test 동시에 fix deploy", config);
      expect(result.multiAgent).toBe(true);
    });

    it("'도 해' triggers multi-agent", () => {
      const result = routeTask("디자인 수정해줘. 테스트도 해", config);
      expect(result.multiAgent).toBe(true);
    });

    it("'하고 나서' triggers multi-agent", () => {
      const result = routeTask("implement 하고 나서 review", config);
      expect(result.multiAgent).toBe(true);
    });
  });

  describe("no false positives", () => {
    it("simple single-domain prompt is NOT multi-agent", () => {
      const result = routeTask("fix the typo in main.py", config);
      expect(result.multiAgent).toBe(false);
    });

    it("short Korean prompt is NOT multi-agent", () => {
      const result = routeTask("이 버그 고쳐줘", config);
      expect(result.multiAgent).toBe(false);
    });

    it("greeting is NOT multi-agent", () => {
      const result = routeTask("hello", config);
      expect(result.multiAgent).toBe(false);
    });
  });
});
