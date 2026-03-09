export interface OutputLimits {
  maxBytesPerStream: number;
  maxLines: number;
  stderrRatio: number;
}

export const DEFAULT_LIMITS: OutputLimits = {
  maxBytesPerStream: 10_485_760, // 10 MiB
  maxLines: 50_000,
  stderrRatio: 0.67,
};

export function truncateOutput(output: string, maxBytes: number): string {
  if (output.length <= maxBytes) return output;

  const prefixSize = Math.floor(maxBytes * 0.7);
  const suffixSize = Math.floor(maxBytes * 0.25);
  const prefix = output.slice(0, prefixSize);
  const suffix = output.slice(-suffixSize);
  const omitted = output.length - prefixSize - suffixSize;

  return `${prefix}\n\n... ${omitted} characters truncated ...\n\n${suffix}`;
}

export function killProcessGroup(pid: number): void {
  // Try process group kill first, fall back to individual pid
  let groupKilled = false;
  try {
    process.kill(-pid, "SIGTERM");
    groupKilled = true;
  } catch {
    // Process group kill failed (not a group leader) — kill individual pid
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  setTimeout(() => {
    try {
      if (groupKilled) process.kill(-pid, "SIGKILL");
    } catch {}
    try { process.kill(pid, "SIGKILL"); } catch {}
  }, 1000);
}
