import { describe, it, expect } from "bun:test";
import { AgentRegistry, parseProfile } from "../src/agents/registry.ts";
import { resolve } from "node:path";

const VALID_PROFILE = `---
name: test-agent
provider: claude
model: sonnet
role: "Test Agent"
maxBudgetUsd: 0.50
requires:
  - claude
worktree: false
---

You are a test agent. Follow instructions precisely.
`;

const MULTI_DELIMITER_PROFILE = `---
name: multi
provider: claude
model: opus
role: "Architect"
maxBudgetUsd: 1.00
requires: []
worktree: false
---

System prompt with --- dashes inside.
More text after dashes.
`;

describe("parseProfile", () => {
  it("parses valid frontmatter + system prompt", () => {
    const profile = parseProfile(VALID_PROFILE);
    expect(profile.name).toBe("test-agent");
    expect(profile.provider).toBe("claude");
    expect(profile.model).toBe("sonnet");
    expect(profile.role).toBe("Test Agent");
    expect(profile.maxBudgetUsd).toBe(0.5);
    expect(profile.requires).toEqual(["claude"]);
    expect(profile.worktree).toBe(false);
    expect(profile.systemPrompt).toContain("test agent");
  });

  it("throws on missing delimiters", () => {
    expect(() => parseProfile("no delimiters here")).toThrow(
      "missing YAML frontmatter delimiters",
    );
  });

  it("handles --- inside system prompt body", () => {
    const profile = parseProfile(MULTI_DELIMITER_PROFILE);
    expect(profile.name).toBe("multi");
    expect(profile.systemPrompt).toContain("--- dashes inside");
    expect(profile.systemPrompt).toContain("More text after dashes");
  });
});

describe("AgentRegistry", () => {
  it("register + get + has + list", () => {
    const registry = new AgentRegistry();
    const profile = parseProfile(VALID_PROFILE);

    registry.register(profile);

    expect(registry.has("test-agent")).toBe(true);
    expect(registry.has("nonexistent")).toBe(false);

    const retrieved = registry.get("test-agent");
    expect(retrieved).not.toBeUndefined();
    expect(retrieved!.name).toBe("test-agent");
    expect(retrieved!.provider).toBe("claude");

    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("test-agent");
  });

  it("get returns undefined for missing agent", () => {
    const registry = new AgentRegistry();
    expect(registry.get("missing")).toBeUndefined();
  });

  it("loadProfiles loads all 6 profiles from disk", async () => {
    const registry = new AgentRegistry();
    const profileDir = resolve(import.meta.dir, "../profiles");
    await registry.loadProfiles(profileDir);

    const profiles = registry.list();
    expect(profiles).toHaveLength(6);

    const names = profiles.map((p) => p.name).sort();
    expect(names).toEqual(["Sam", "architect", "coder", "rapid", "researcher", "reviewer"]);
  });

  it("loaded profiles have correct fields", async () => {
    const registry = new AgentRegistry();
    const profileDir = resolve(import.meta.dir, "../profiles");
    await registry.loadProfiles(profileDir);

    const architect = registry.get("architect")!;
    expect(architect.provider).toBe("claude");
    expect(architect.model).toBe("opus");
    expect(architect.role).toBe("Software Architect");

    const coder = registry.get("coder")!;
    expect(coder.provider).toBe("claude");
    expect(coder.model).toBe("sonnet");
    expect(coder.role).toBe("Software Engineer");

    // All profiles have required fields
    for (const profile of registry.list()) {
      expect(typeof profile.name).toBe("string");
      expect(typeof profile.provider).toBe("string");
      expect(typeof profile.model).toBe("string");
      expect(typeof profile.role).toBe("string");
      expect(typeof profile.maxBudgetUsd).toBe("number");
      expect(profile.systemPrompt.length).toBeGreaterThan(0);
    }
  });
});
