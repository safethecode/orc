import Parser from "web-tree-sitter";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface ParsedCommand {
  commands: string[];        // command names found (e.g., ["curl", "sh"])
  pipes: boolean;            // has pipe operators
  redirects: string[];       // redirect targets (e.g., ["/etc/passwd"])
  subcommands: string[];     // commands inside $() or backticks
  backgrounded: boolean;     // has & operator
  chained: string[];         // && or || chain operators
}

export class TreeSitterBashParser {
  private parser: Parser | null = null;
  private language: Parser.Language | null = null;
  private ready = false;

  /**
   * Initialize the tree-sitter parser with bash grammar.
   * Looks for WASM file in:
   * 1. node_modules/tree-sitter-bash/tree-sitter-bash.wasm (if exists)
   * 2. ~/.orchestrator/cache/tree-sitter-bash.wasm
   *
   * If no WASM found, parser stays null and parse() returns null.
   */
  async initialize(): Promise<boolean> {
    try {
      await Parser.init();
      this.parser = new Parser();

      // Try to find WASM file
      const candidates = [
        join(process.cwd(), "node_modules", "tree-sitter-bash", "tree-sitter-bash.wasm"),
        join(process.env.HOME ?? "~", ".orchestrator", "cache", "tree-sitter-bash.wasm"),
      ];

      let wasmPath: string | null = null;
      for (const p of candidates) {
        if (existsSync(p)) { wasmPath = p; break; }
      }

      if (!wasmPath) {
        this.parser = null;
        return false;
      }

      this.language = await Parser.Language.load(wasmPath);
      this.parser.setLanguage(this.language);
      this.ready = true;
      return true;
    } catch {
      this.parser = null;
      this.ready = false;
      return false;
    }
  }

  isReady(): boolean { return this.ready; }

  /**
   * Parse a bash command string into structured data.
   * Returns null if parser is not initialized.
   */
  parse(command: string): ParsedCommand | null {
    if (!this.parser || !this.ready) return null;

    const tree = this.parser.parse(command);
    const root = tree.rootNode;

    const result: ParsedCommand = {
      commands: [],
      pipes: false,
      redirects: [],
      subcommands: [],
      backgrounded: false,
      chained: [],
    };

    this.walkNode(root, result, false);
    tree.delete();

    return result;
  }

  private walkNode(node: Parser.SyntaxNode, result: ParsedCommand, inSubcommand: boolean): void {
    switch (node.type) {
      case "command_name": {
        const name = node.text;
        if (inSubcommand) {
          result.subcommands.push(name);
        } else {
          result.commands.push(name);
        }
        break;
      }

      case "pipeline":
        result.pipes = true;
        // Walk children to get individual commands
        for (let i = 0; i < node.childCount; i++) {
          this.walkNode(node.child(i)!, result, inSubcommand);
        }
        return; // already walked children

      case "redirected_statement":
      case "file_redirect": {
        // Look for redirect target (the file path after > or >>)
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i)!;
          if (child.type === "word" && i > 0) {
            result.redirects.push(child.text);
          }
          this.walkNode(child, result, inSubcommand);
        }
        return;
      }

      case "command_substitution":
        // $(...) or `...` — walk children as subcommands
        for (let i = 0; i < node.childCount; i++) {
          this.walkNode(node.child(i)!, result, true);
        }
        return;

      case "list":
        // && and || chains
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i)!;
          if (child.type === "&&" || child.type === "||") {
            result.chained.push(child.type);
          }
          this.walkNode(child, result, inSubcommand);
        }
        return;

      default:
        // Check for & (background)
        if (node.type === "&") {
          result.backgrounded = true;
        }
        break;
    }

    // Walk children by default
    for (let i = 0; i < node.childCount; i++) {
      this.walkNode(node.child(i)!, result, inSubcommand);
    }
  }
}
