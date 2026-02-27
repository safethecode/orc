import { describe, it, expect } from "bun:test";
import { loadConfig, resolvePath } from "../src/config/loader.ts";
import { homedir } from "os";

describe("loadConfig", () => {
  it("returns valid config with all required fields", () => {
    const config = loadConfig();

    expect(config).toBeDefined();
    expect(config.orchestrator).toBeDefined();
    expect(config.budget).toBeDefined();
    expect(config.providers).toBeDefined();
    expect(config.routing).toBeDefined();
  });

  it("config has orchestrator section with required fields", () => {
    const config = loadConfig();

    expect(config.orchestrator.sessionPrefix).toBe("orc-");
    expect(typeof config.orchestrator.maxConcurrentAgents).toBe("number");
    expect(typeof config.orchestrator.dataDir).toBe("string");
    expect(typeof config.orchestrator.db).toBe("string");
    expect(typeof config.orchestrator.logDir).toBe("string");
  });

  it("config has budget section", () => {
    const config = loadConfig();

    expect(typeof config.budget.defaultMaxPerTask).toBe("number");
    expect(config.budget.defaultMaxPerTask).toBeGreaterThan(0);
  });

  it("config has providers with expected structure", () => {
    const config = loadConfig();

    expect(config.providers.claude).toBeDefined();
    expect(config.providers.claude.command).toBe("claude");
    expect(Array.isArray(config.providers.claude.flags)).toBe(true);

    // Each provider has required fields
    for (const [name, provider] of Object.entries(config.providers)) {
      expect(typeof provider.command).toBe("string");
      expect(Array.isArray(provider.flags)).toBe(true);
    }
  });

  it("config has routing section with all three tiers", () => {
    const config = loadConfig();

    expect(config.routing.tiers.simple).toBeDefined();
    expect(config.routing.tiers.medium).toBeDefined();
    expect(config.routing.tiers.complex).toBeDefined();

    expect(config.routing.tiers.simple.model).toBe("haiku");
    expect(config.routing.tiers.medium.model).toBe("sonnet");
    expect(config.routing.tiers.complex.model).toBe("opus");

    expect(Array.isArray(config.routing.tiers.simple.keywords)).toBe(true);
    expect(config.routing.tiers.simple.keywords.length).toBeGreaterThan(0);
  });

  it("path resolution replaces ~ with homedir", () => {
    const config = loadConfig();
    const home = homedir();

    // dataDir, db, logDir should all have ~ resolved
    expect(config.orchestrator.dataDir.startsWith(home)).toBe(true);
    expect(config.orchestrator.db.startsWith(home)).toBe(true);
    expect(config.orchestrator.logDir.startsWith(home)).toBe(true);

    // Should not contain ~ anymore
    expect(config.orchestrator.dataDir).not.toContain("~");
    expect(config.orchestrator.db).not.toContain("~");
    expect(config.orchestrator.logDir).not.toContain("~");
  });
});

describe("resolvePath", () => {
  it("replaces ~ with homedir", () => {
    const resolved = resolvePath("~/foo/bar");
    expect(resolved).toBe(`${homedir()}/foo/bar`);
    expect(resolved).not.toContain("~");
  });

  it("resolves relative paths", () => {
    const resolved = resolvePath("./relative/path");
    expect(resolved.startsWith("/")).toBe(true);
  });
});
