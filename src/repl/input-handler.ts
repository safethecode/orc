import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";

export interface InputResult {
  text: string;
  type: "normal" | "multiline" | "bash_inline" | "editor" | "file_ref";
  metadata?: Record<string, unknown>;
}

export interface InputHandlerConfig {
  multilineEnabled: boolean;
  inlineBashEnabled: boolean;
  editorCommand?: string;
}

export class InputHandler {
  private config: InputHandlerConfig;

  constructor(config?: Partial<InputHandlerConfig>) {
    this.config = {
      multilineEnabled: true,
      inlineBashEnabled: true,
      editorCommand: process.env.EDITOR || "vim",
      ...config,
    };
  }

  async process(input: string): Promise<InputResult> {
    const trimmed = input.trim();

    // Inline bash: starts with !
    if (this.config.inlineBashEnabled && this.isInlineBash(trimmed)) {
      const command = trimmed.slice(1).trim();
      if (command.length === 0) {
        return { text: "", type: "bash_inline", metadata: { error: "empty command" } };
      }

      try {
        const output = await this.executeInlineBash(command);
        return {
          text: output,
          type: "bash_inline",
          metadata: { command },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          text: `$ ${command}\n[error: ${message}]`,
          type: "bash_inline",
          metadata: { command, error: message },
        };
      }
    }

    // Editor command: /editor, /edit, /e
    if (this.isEditorCommand(trimmed)) {
      const content = await this.openEditor();
      if (content === null || content.trim().length === 0) {
        return { text: "", type: "editor", metadata: { cancelled: true } };
      }
      return {
        text: content,
        type: "editor",
        metadata: { editor: this.config.editorCommand },
      };
    }

    // Multi-line detection
    if (this.config.multilineEnabled && this.isMultiline(input)) {
      return { text: input, type: "multiline" };
    }

    return { text: input, type: "normal" };
  }

  async executeInlineBash(command: string): Promise<string> {
    const proc = Bun.spawn(["sh", "-c", command], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });

    const timeoutMs = 30_000;
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        proc.kill();
        reject(new Error(`Command timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
    });

    const [stdout, stderr, exitCode] = await Promise.race([
      Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]),
      timeoutPromise.then(() => ["", "", 1] as [string, string, number]),
    ]);

    const output = (stdout + stderr).trim();
    return this.formatBashOutput(command, output, exitCode);
  }

  async openEditor(initialContent?: string): Promise<string | null> {
    const tmpPath = join(tmpdir(), `orc-edit-${randomBytes(4).toString("hex")}.md`);

    // Write initial content to temp file
    await Bun.write(tmpPath, initialContent ?? "");

    const editor = this.config.editorCommand ?? "vim";
    const editorBase = editor.split("/").pop()?.split(" ")[0] ?? editor;

    // Editors that need --wait flag to block until closed
    const waitEditors = new Set(["code", "cursor", "windsurf"]);
    const needsWait = waitEditors.has(editorBase);

    const args: string[] = [];
    if (needsWait) args.push("--wait");
    args.push(tmpPath);

    // Terminal editors (vim, nvim, nano, etc.) need stdio: "inherit"
    const terminalEditors = new Set(["vim", "nvim", "vi", "nano", "micro", "emacs", "helix", "hx"]);
    const isTerminal = terminalEditors.has(editorBase);

    try {
      const child = spawn(editor, args, {
        stdio: isTerminal ? "inherit" : "ignore",
        detached: false,
      });

      await new Promise<void>((resolve, reject) => {
        child.on("close", (code) => {
          if (code === 0 || code === null) {
            resolve();
          } else {
            reject(new Error(`Editor exited with code ${code}`));
          }
        });
        child.on("error", (err) => reject(err));
      });

      // Read the edited content
      const file = Bun.file(tmpPath);
      if (!(await file.exists())) return null;

      const content = await file.text();

      // Clean up
      try {
        unlinkSync(tmpPath);
      } catch {
        // Ignore cleanup errors
      }

      // Return null if content is unchanged from initial or empty
      if (content.trim().length === 0) return null;
      if (initialContent !== undefined && content === initialContent) return null;

      return content;
    } catch (err) {
      // Clean up on error
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
      } catch {
        // Ignore cleanup errors
      }
      throw err;
    }
  }

  isMultiline(input: string): boolean {
    return input.includes("\n");
  }

  isInlineBash(input: string): boolean {
    return input.trimStart().startsWith("!");
  }

  isEditorCommand(input: string): boolean {
    const trimmed = input.trim().toLowerCase();
    return trimmed === "/editor" || trimmed === "/edit" || trimmed === "/e";
  }

  formatBashOutput(command: string, output: string, exitCode: number): string {
    let result = `$ ${command}`;
    if (output.length > 0) {
      result += `\n${output}`;
    }
    if (exitCode !== 0) {
      result += `\n[exit: ${exitCode}]`;
    }
    return result;
  }
}
