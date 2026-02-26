import type { SessionInfo } from "../config/types.ts";

async function run(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["tmux", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

export async function tmuxAvailable(): Promise<boolean> {
  const proc = Bun.spawn(["which", "tmux"], { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  return exitCode === 0;
}

function assertTmux(available: boolean): void {
  if (!available) {
    throw new Error("tmux is not installed or not found in PATH");
  }
}

export async function createSession(name: string): Promise<void> {
  assertTmux(await tmuxAvailable());
  const { exitCode, stderr } = await run(["new-session", "-d", "-s", name]);
  if (exitCode !== 0) {
    throw new Error(`Failed to create tmux session "${name}": ${stderr.trim()}`);
  }
}

export async function killSession(name: string): Promise<void> {
  assertTmux(await tmuxAvailable());
  const { exitCode, stderr } = await run(["kill-session", "-t", name]);
  if (exitCode !== 0) {
    throw new Error(`Failed to kill tmux session "${name}": ${stderr.trim()}`);
  }
}

export async function hasSession(name: string): Promise<boolean> {
  assertTmux(await tmuxAvailable());
  const { exitCode } = await run(["has-session", "-t", name]);
  return exitCode === 0;
}

export async function sendKeys(session: string, keys: string): Promise<void> {
  assertTmux(await tmuxAvailable());
  const { exitCode, stderr } = await run(["send-keys", "-t", session, keys, "Enter"]);
  if (exitCode !== 0) {
    throw new Error(`Failed to send keys to session "${session}": ${stderr.trim()}`);
  }
}

export async function capturePane(session: string, lines?: number): Promise<string> {
  assertTmux(await tmuxAvailable());
  const args = ["capture-pane", "-t", session, "-p"];
  if (lines !== undefined) {
    args.push("-S", `-${lines}`);
  }
  const { exitCode, stdout, stderr } = await run(args);
  if (exitCode !== 0) {
    throw new Error(`Failed to capture pane for session "${session}": ${stderr.trim()}`);
  }
  return stdout;
}

export async function listSessions(prefix?: string): Promise<string[]> {
  assertTmux(await tmuxAvailable());
  const { exitCode, stdout } = await run(["list-sessions", "-F", "#{session_name}"]);
  if (exitCode !== 0) {
    return [];
  }
  const names = stdout.trim().split("\n").filter(Boolean);
  if (prefix) {
    return names.filter((n) => n.startsWith(prefix));
  }
  return names;
}
