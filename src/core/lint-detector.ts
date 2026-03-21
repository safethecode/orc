import { join } from "node:path";

export interface LintConfig {
  tool: string;
  configPath: string;
  summary: string;
}

const LINT_FILES = [
  { pattern: "biome.json", tool: "biome" },
  { pattern: "biome.jsonc", tool: "biome" },
  { pattern: ".eslintrc.json", tool: "eslint" },
  { pattern: ".eslintrc.js", tool: "eslint" },
  { pattern: ".eslintrc.cjs", tool: "eslint" },
  { pattern: ".eslintrc.yml", tool: "eslint" },
  { pattern: "eslint.config.js", tool: "eslint" },
  { pattern: "eslint.config.mjs", tool: "eslint" },
  { pattern: ".prettierrc", tool: "prettier" },
  { pattern: ".prettierrc.json", tool: "prettier" },
  { pattern: ".prettierrc.js", tool: "prettier" },
  { pattern: "prettier.config.js", tool: "prettier" },
  { pattern: "deno.json", tool: "deno" },
  { pattern: "deno.jsonc", tool: "deno" },
];

/**
 * Detect and read lint configuration from the project.
 * Returns a formatted summary suitable for system prompt injection.
 */
export async function detectLintConfig(projectDir: string): Promise<LintConfig | null> {
  for (const { pattern, tool } of LINT_FILES) {
    const filePath = join(projectDir, pattern);
    try {
      const file = Bun.file(filePath);
      if (!await file.exists()) continue;

      const content = await file.text();
      const summary = summarizeLintConfig(tool, content);
      return { tool, configPath: filePath, summary };
    } catch {
      continue;
    }
  }
  return null;
}

function summarizeLintConfig(tool: string, content: string): string {
  const lines: string[] = [`## Lint Rules (${tool}) — FOLLOW THESE`];

  if (tool === "biome") {
    try {
      // Strip jsonc comments
      const cleaned = content.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      const config = JSON.parse(cleaned);

      // Formatter
      const fmt = config.formatter;
      if (fmt) {
        const rules: string[] = [];
        if (fmt.indentStyle) rules.push(`indent: ${fmt.indentStyle}${fmt.indentWidth ? ` (${fmt.indentWidth})` : ""}`);
        if (fmt.lineWidth) rules.push(`max line: ${fmt.lineWidth}`);
        if (fmt.formatWithErrors !== undefined) rules.push(`format with errors: ${fmt.formatWithErrors}`);
        if (rules.length > 0) lines.push(`- Formatting: ${rules.join(", ")}`);
      }

      // JS/TS
      const js = config.javascript;
      if (js) {
        const rules: string[] = [];
        if (js.formatter?.quoteStyle) rules.push(`quotes: ${js.formatter.quoteStyle}`);
        if (js.formatter?.semicolons) rules.push(`semicolons: ${js.formatter.semicolons}`);
        if (js.formatter?.trailingCommas) rules.push(`trailing commas: ${js.formatter.trailingCommas}`);
        if (js.formatter?.arrowParentheses) rules.push(`arrow parens: ${js.formatter.arrowParentheses}`);
        if (rules.length > 0) lines.push(`- JS/TS: ${rules.join(", ")}`);
      }

      // Linter rules
      const linter = config.linter;
      if (linter?.rules) {
        const ruleGroups = linter.rules;
        const disabled: string[] = [];
        const warns: string[] = [];
        for (const [group, rules] of Object.entries(ruleGroups)) {
          if (typeof rules !== "object" || rules === null) continue;
          for (const [rule, value] of Object.entries(rules as Record<string, unknown>)) {
            if (value === "off") disabled.push(`${group}/${rule}`);
            else if (value === "warn") warns.push(`${group}/${rule}`);
          }
        }
        if (disabled.length > 0) lines.push(`- Disabled rules: ${disabled.join(", ")}`);
        if (warns.length > 0) lines.push(`- Warn-only: ${warns.join(", ")}`);
      }

      // Organize imports
      if (config.organizeImports?.enabled !== false) {
        lines.push("- Import ordering: auto-organized (biome organizeImports)");
      }

      // Overrides for specific paths
      const overrides = config.overrides;
      if (Array.isArray(overrides) && overrides.length > 0) {
        for (const ov of overrides.slice(0, 3)) {
          const include = ov.include?.join(", ") ?? "?";
          const changes: string[] = [];
          if (ov.linter?.rules) {
            for (const [group, rules] of Object.entries(ov.linter.rules)) {
              if (typeof rules !== "object" || rules === null) continue;
              for (const [rule, value] of Object.entries(rules as Record<string, unknown>)) {
                changes.push(`${group}/${rule}=${typeof value === "string" ? value : JSON.stringify(value)}`);
              }
            }
          }
          if (changes.length > 0) lines.push(`- Override (${include}): ${changes.join(", ")}`);
        }
      }
    } catch {
      // Can't parse — include raw content (truncated)
      lines.push("```json");
      lines.push(content.slice(0, 1000));
      lines.push("```");
    }
  } else if (tool === "eslint") {
    // For ESLint, include raw config (usually small)
    lines.push("```json");
    lines.push(content.slice(0, 1500));
    lines.push("```");
  } else if (tool === "prettier") {
    lines.push("```json");
    lines.push(content.slice(0, 500));
    lines.push("```");
  } else {
    lines.push("```");
    lines.push(content.slice(0, 1000));
    lines.push("```");
  }

  lines.push("");
  lines.push("**Write code that passes `pnpm lint` with zero errors. Check rules above before writing.**");

  return lines.join("\n");
}

/**
 * Format lint config for system prompt injection.
 */
export function formatLintForPrompt(config: LintConfig): string {
  return config.summary;
}
