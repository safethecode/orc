import type { StackProfile, SafetyLevel } from "../config/types.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { classifyCommand } from "./safety.ts";

const STACK_PROFILES: StackProfile[] = [
  {
    name: "nodejs",
    detectFiles: ["package.json"],
    safeCommands: ["npm", "npx", "node", "bun", "jest", "vitest", "tsc", "eslint", "prettier"],
    dangerousPatterns: [/\brequire\s*\(\s*['"]child_process['"]\s*\)/],
  },
  {
    name: "python",
    detectFiles: ["pyproject.toml", "setup.py", "requirements.txt"],
    safeCommands: ["pip", "python", "python3", "pytest", "ruff", "mypy", "black"],
    dangerousPatterns: [/\bsubprocess\.call\b/],
  },
  {
    name: "rust",
    detectFiles: ["Cargo.toml"],
    safeCommands: ["cargo", "rustc", "rustfmt", "clippy"],
    dangerousPatterns: [],
  },
  {
    name: "go",
    detectFiles: ["go.mod"],
    safeCommands: ["go", "gofmt", "golint", "golangci-lint"],
    dangerousPatterns: [],
  },
  {
    name: "java",
    detectFiles: ["pom.xml", "build.gradle", "build.gradle.kts"],
    safeCommands: ["mvn", "gradle", "javac", "java"],
    dangerousPatterns: [],
  },
];

export class DynamicSecurityProfile {
  private cache: { profiles: StackProfile[]; mtime: number } | null = null;
  private cacheTtlMs = 30_000;

  async detect(projectDir: string): Promise<StackProfile[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.mtime < this.cacheTtlMs) {
      return this.cache.profiles;
    }

    const detected: StackProfile[] = [];
    for (const profile of STACK_PROFILES) {
      for (const file of profile.detectFiles) {
        if (existsSync(join(projectDir, file))) {
          detected.push(profile);
          break;
        }
      }
    }

    this.cache = { profiles: detected, mtime: now };
    return detected;
  }

  async getSafeCommands(projectDir: string): Promise<string[]> {
    const profiles = await this.detect(projectDir);
    const commands = new Set<string>();
    for (const profile of profiles) {
      for (const cmd of profile.safeCommands) {
        commands.add(cmd);
      }
    }
    return [...commands];
  }

  async classifyWithProfile(command: string, projectDir: string): Promise<SafetyLevel> {
    // Check base classification first
    const base = classifyCommand(command);
    if (base === "forbidden") return "forbidden";
    if (base === "safe") return "safe";

    // Check dynamic profile safe commands
    const safeCommands = await this.getSafeCommands(projectDir);
    const trimmed = command.trim();
    const firstWord = trimmed.split(/\s+/)[0];
    if (safeCommands.includes(firstWord)) return "safe";

    // Check dangerous patterns from detected stacks
    const profiles = await this.detect(projectDir);
    for (const profile of profiles) {
      for (const pattern of profile.dangerousPatterns) {
        if (pattern.test(trimmed)) return "forbidden";
      }
    }

    return "prompt";
  }
}
