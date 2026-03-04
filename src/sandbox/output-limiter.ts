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
  try {
    process.kill(-pid, "SIGTERM");
    setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }, 2000);
  } catch {}
}
