import { describe, it, expect } from "bun:test";
import { classifyWithSam } from "../src/core/router.ts";

const LLM_TIMEOUT = 15_000;

describe("language detection via Sam", () => {
  it("detects Korean", async () => {
    const result = await classifyWithSam("디자인 개선해줘");
    expect(result.lang).toBe("ko");
  }, LLM_TIMEOUT);

  it("detects English", async () => {
    const result = await classifyWithSam("Fix this bug in the auth module");
    expect(result.lang).toBe("en");
  }, LLM_TIMEOUT);

  it("detects Korean greeting", async () => {
    const result = await classifyWithSam("안녕하세요");
    expect(result.lang).toBe("ko");
  }, LLM_TIMEOUT);

  it("detects English greeting", async () => {
    const result = await classifyWithSam("hello there");
    expect(result.lang).toBe("en");
  }, LLM_TIMEOUT);
});

describe("language instruction injection", () => {
  it("generates instruction for Korean", () => {
    const lang = "ko";
    const instruction = lang !== "en"
      ? `\n\n[LANGUAGE] The user writes in ${lang}. Always respond in the same language.`
      : "";
    expect(instruction).toContain("[LANGUAGE]");
    expect(instruction).toContain("ko");
  });

  it("generates instruction for Japanese", () => {
    const lang = "ja";
    const instruction = lang !== "en"
      ? `\n\n[LANGUAGE] The user writes in ${lang}. Always respond in the same language.`
      : "";
    expect(instruction).toContain("ja");
  });

  it("generates empty instruction for English", () => {
    const lang = "en";
    const instruction = lang !== "en"
      ? `\n\n[LANGUAGE] The user writes in ${lang}. Always respond in the same language.`
      : "";
    expect(instruction).toBe("");
  });

  it("generates empty instruction for undefined", () => {
    const lang: string | undefined = undefined;
    const instruction = lang && lang !== "en"
      ? `\n\n[LANGUAGE] The user writes in ${lang}. Always respond in the same language.`
      : "";
    expect(instruction).toBe("");
  });
});
