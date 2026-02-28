import { existsSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

export interface LspServerDef {
  name: string;
  command: string[];
  extensions: string[];
  rootMarkers: string[];
  installCheck?: string;
  installHint?: string;
  initializationOptions?: Record<string, unknown>;
}

export const BUILT_IN_SERVERS: LspServerDef[] = [
  // 1. TypeScript / JavaScript
  {
    name: "typescript",
    command: ["typescript-language-server", "--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    rootMarkers: ["tsconfig.json", "package.json"],
    installCheck: "typescript-language-server --version",
    installHint: "npm install -g typescript-language-server typescript",
  },

  // 2. Go
  {
    name: "gopls",
    command: ["gopls", "serve"],
    extensions: [".go"],
    rootMarkers: ["go.mod"],
    installCheck: "gopls version",
    installHint: "go install golang.org/x/tools/gopls@latest",
  },

  // 3. Rust
  {
    name: "rust-analyzer",
    command: ["rust-analyzer"],
    extensions: [".rs"],
    rootMarkers: ["Cargo.toml"],
    installCheck: "rust-analyzer --version",
    installHint: "rustup component add rust-analyzer",
  },

  // 4. Python
  {
    name: "pyright",
    command: ["pyright-langserver", "--stdio"],
    extensions: [".py", ".pyi"],
    rootMarkers: ["pyproject.toml", "setup.py", "requirements.txt"],
    installCheck: "pyright-langserver --version",
    installHint: "npm install -g pyright",
  },

  // 5. C / C++
  {
    name: "clangd",
    command: ["clangd"],
    extensions: [".c", ".h", ".cpp", ".hpp", ".cc", ".cxx", ".hxx"],
    rootMarkers: ["compile_commands.json", "CMakeLists.txt", ".clangd"],
    installCheck: "clangd --version",
    installHint: "Install via your package manager (apt install clangd, brew install llvm, etc.)",
  },

  // 6. Bash / Shell
  {
    name: "bash-language-server",
    command: ["bash-language-server", "start"],
    extensions: [".sh", ".bash", ".zsh"],
    rootMarkers: [".bashrc", ".bash_profile"],
    installCheck: "bash-language-server --version",
    installHint: "npm install -g bash-language-server",
  },

  // 7. YAML
  {
    name: "yaml-language-server",
    command: ["yaml-language-server", "--stdio"],
    extensions: [".yaml", ".yml"],
    rootMarkers: [".yaml-language-server.yaml"],
    installCheck: "yaml-language-server --version",
    installHint: "npm install -g yaml-language-server",
    initializationOptions: {
      yaml: {
        validate: true,
        hover: true,
        completion: true,
      },
    },
  },

  // 8. Svelte
  {
    name: "svelte-language-server",
    command: ["svelteserver", "--stdio"],
    extensions: [".svelte"],
    rootMarkers: ["svelte.config.js", "svelte.config.ts"],
    installCheck: "svelteserver --version",
    installHint: "npm install -g svelte-language-server",
  },

  // 9. Vue
  {
    name: "vue-language-server",
    command: ["vue-language-server", "--stdio"],
    extensions: [".vue"],
    rootMarkers: ["vue.config.js", "nuxt.config.js", "nuxt.config.ts"],
    installCheck: "vue-language-server --version",
    installHint: "npm install -g @vue/language-server",
  },

  // 10. CSS / SCSS / LESS
  {
    name: "css-languageserver",
    command: ["vscode-css-language-server", "--stdio"],
    extensions: [".css", ".scss", ".less"],
    rootMarkers: ["package.json"],
    installCheck: "vscode-css-language-server --version",
    installHint: "npm install -g vscode-langservers-extracted",
  },
];

/** Detect the appropriate LSP server definition for a given file path */
export function detectServerForFile(filePath: string): LspServerDef | undefined {
  const ext = extname(filePath).toLowerCase();
  if (!ext) return undefined;

  return BUILT_IN_SERVERS.find((server) =>
    server.extensions.includes(ext),
  );
}

/**
 * Walk up from the given file path looking for any of the specified marker
 * files. Returns the directory containing the first match, or null.
 */
export function findProjectRoot(
  filePath: string,
  markers: string[],
): string | null {
  let dir = resolve(dirname(filePath));
  const root = resolve("/");

  while (true) {
    for (const marker of markers) {
      if (existsSync(join(dir, marker))) {
        return dir;
      }
    }

    const parent = dirname(dir);
    if (parent === dir || dir === root) break;
    dir = parent;
  }

  return null;
}

/** Check whether a language server is installed by running its check command */
export async function isServerInstalled(
  server: LspServerDef,
): Promise<boolean> {
  if (!server.installCheck) return true; // Assume available if no check defined

  try {
    const parts = server.installCheck.split(/\s+/);
    const proc = Bun.spawn(parts, {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}
