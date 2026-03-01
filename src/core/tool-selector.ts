import type { ProviderName } from "../config/types.ts";

export interface ToolSpec {
  name: string;
  description: string;
  preferred: boolean;
}

export interface ToolBranch {
  editTool: string;
  writeTool: string;
  additionalTools: string[];
  guidelines: string;
}

const DEFAULT_BRANCHES: Record<string, ToolBranch> = {
  claude: {
    editTool: "edit",
    writeTool: "write",
    additionalTools: ["read", "bash", "grep", "glob"],
    guidelines: [
      "Use the `edit` tool for modifying existing files — never overwrite entire files with `write` when small edits suffice.",
      "Always `read` a file before editing it.",
      "Use `bash` for running tests, git operations, and system commands.",
      "Prefer targeted `grep` over broad file reads for finding code.",
    ].join("\n"),
  },
  codex: {
    editTool: "apply_patch",
    writeTool: "write",
    additionalTools: ["read", "bash", "grep", "glob"],
    guidelines: [
      "Use `apply_patch` for all file modifications — provide unified diff format.",
      "Write complete file contents with `write` for new files only.",
      "Include full context lines in patches for accurate matching.",
      "Prefer direct code generation over explanations.",
    ].join("\n"),
  },
  gemini: {
    editTool: "edit",
    writeTool: "write",
    additionalTools: ["read", "bash", "grep", "glob"],
    guidelines: [
      "Use `edit` for surgical file modifications.",
      "Leverage your large context window — read multiple related files at once.",
      "Be concise in tool call descriptions.",
      "Use `bash` for verification after changes.",
    ].join("\n"),
  },
  kiro: {
    editTool: "write",
    writeTool: "write",
    additionalTools: ["read"],
    guidelines: [
      "Write all code inline in your response.",
      "Use `write` only when explicitly creating files.",
      "Follow the spec → implementation → verification pattern.",
      "Minimize tool use — prefer inline code blocks.",
    ].join("\n"),
  },
};

export class ToolSelector {
  private branches: Record<string, ToolBranch>;

  constructor(overrides?: Record<string, Partial<ToolBranch>>) {
    this.branches = { ...DEFAULT_BRANCHES };
    if (overrides) {
      for (const [provider, override] of Object.entries(overrides)) {
        if (this.branches[provider]) {
          this.branches[provider] = { ...this.branches[provider], ...override };
        } else {
          this.branches[provider] = {
            editTool: override.editTool ?? "edit",
            writeTool: override.writeTool ?? "write",
            additionalTools: override.additionalTools ?? ["read", "bash"],
            guidelines: override.guidelines ?? "",
          };
        }
      }
    }
  }

  getBranch(provider: ProviderName): ToolBranch {
    return this.branches[provider] ?? this.branches["claude"];
  }

  formatForPrompt(provider: ProviderName): string {
    const branch = this.getBranch(provider);
    const lines = [
      `Primary edit tool: \`${branch.editTool}\``,
      `File creation tool: \`${branch.writeTool}\``,
      `Available tools: ${[branch.editTool, branch.writeTool, ...branch.additionalTools].map(t => `\`${t}\``).join(", ")}`,
      "",
      branch.guidelines,
    ];
    return lines.join("\n");
  }
}
