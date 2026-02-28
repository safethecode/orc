import { existsSync } from "node:fs";
import { resolve, extname } from "node:path";

export interface FormatterConfig {
  command: string;
  extensions: string[];
}

export interface FormatterResult {
  file: string;
  formatted: boolean;
  error?: string;
}

const KNOWN_FORMATTERS: Array<{
  name: string;
  detectFiles: string[];
  command: string;
  extensions: string[];
}> = [
  {
    name: "prettier",
    detectFiles: [".prettierrc", ".prettierrc.json", ".prettierrc.js", "prettier.config.js"],
    command: "npx prettier --write",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".css", ".json", ".md", ".html"],
  },
  {
    name: "biome",
    detectFiles: ["biome.json", "biome.jsonc"],
    command: "npx @biomejs/biome format --write",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".json", ".css"],
  },
  {
    name: "gofmt",
    detectFiles: ["go.mod"],
    command: "gofmt -w",
    extensions: [".go"],
  },
  {
    name: "rustfmt",
    detectFiles: ["Cargo.toml"],
    command: "rustfmt",
    extensions: [".rs"],
  },
  {
    name: "black",
    detectFiles: ["pyproject.toml", "setup.py", "requirements.txt"],
    command: "black",
    extensions: [".py"],
  },
  {
    name: "rubocop",
    detectFiles: ["Gemfile", ".rubocop.yml"],
    command: "rubocop -a",
    extensions: [".rb"],
  },
  {
    name: "clang-format",
    detectFiles: [".clang-format"],
    command: "clang-format -i",
    extensions: [".c", ".cpp", ".h", ".hpp"],
  },
];

export class AutoFormatter {
  private formatters: FormatterConfig[] = [];
  private customFormatters: FormatterConfig[] = [];
  private detected = false;
  private detectedNames: string[] = [];

  constructor(customFormatters?: FormatterConfig[]) {
    if (customFormatters) {
      this.customFormatters = customFormatters;
      this.formatters = [...customFormatters];
    }
  }

  async detect(projectDir: string): Promise<string[]> {
    const names: string[] = [];
    const absDir = resolve(projectDir);

    for (const known of KNOWN_FORMATTERS) {
      const found = known.detectFiles.some((file) =>
        existsSync(resolve(absDir, file)),
      );
      if (found) {
        // Only add if not already covered by a custom formatter for same extensions
        const alreadyCovered = this.customFormatters.some((cf) =>
          cf.extensions.some((ext) => known.extensions.includes(ext)),
        );
        if (!alreadyCovered) {
          this.formatters.push({
            command: known.command,
            extensions: known.extensions,
          });
        }
        names.push(known.name);
      }
    }

    this.detected = true;
    this.detectedNames = names;
    return names;
  }

  async format(filePath: string): Promise<FormatterResult> {
    const ext = extname(filePath);
    const formatter = this.getFormatterFor(ext);

    if (!formatter) {
      return { file: filePath, formatted: false };
    }

    const parts = formatter.command.split(/\s+/);
    const cmd = parts[0];
    const args = [...parts.slice(1), filePath];

    try {
      const proc = Bun.spawn([cmd, ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });

      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        return {
          file: filePath,
          formatted: false,
          error: stderr.trim() || `Formatter exited with code ${exitCode}`,
        };
      }

      return { file: filePath, formatted: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { file: filePath, formatted: false, error: message };
    }
  }

  async formatAll(files: string[]): Promise<FormatterResult[]> {
    const results: FormatterResult[] = [];
    for (const file of files) {
      results.push(await this.format(file));
    }
    return results;
  }

  addFormatter(config: FormatterConfig): void {
    this.customFormatters.push(config);
    this.formatters.push(config);
  }

  getFormatterFor(extension: string): FormatterConfig | undefined {
    // Custom formatters take priority (searched first since they are prepended)
    for (const fmt of this.formatters) {
      if (fmt.extensions.includes(extension)) return fmt;
    }
    return undefined;
  }

  listDetected(): string[] {
    return this.detectedNames;
  }
}
