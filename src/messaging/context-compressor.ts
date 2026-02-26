export interface CompressedContext {
  summary: string;
  fullOutputRef: string;
  originalLength: number;
  compressedLength: number;
}

export class ContextCompressor {
  private storage = new Map<string, string>();

  constructor(private maxLines: number = 50) {}

  compress(fullOutput: string): CompressedContext {
    const refId = crypto.randomUUID();
    this.storage.set(refId, fullOutput);

    const lines = fullOutput.split("\n");
    let summary: string;

    if (lines.length <= this.maxLines) {
      summary = fullOutput;
    } else {
      const head = lines.slice(0, 20).join("\n");
      const tail = lines.slice(-20).join("\n");
      summary = `${head}\n... (truncated) ...\n${tail}`;
    }

    return {
      summary,
      fullOutputRef: refId,
      originalLength: fullOutput.length,
      compressedLength: summary.length,
    };
  }

  getFullOutput(refId: string): string | undefined {
    return this.storage.get(refId);
  }

  clear(): void {
    this.storage.clear();
  }

  formatForAgent(context: CompressedContext): string {
    return `=== Summary (ref: ${context.fullOutputRef}) ===\n${context.summary}\n=== End Summary ===`;
  }
}
