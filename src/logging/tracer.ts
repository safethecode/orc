export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  agentName: string;
  taskId: string;
  startTime: string;
  endTime: string | null;
  status: "running" | "completed" | "error";
  metadata?: Record<string, unknown>;
}

export class Tracer {
  private spans: Map<string, Span> = new Map();

  startSpan(traceId: string, agentName: string, taskId: string, parentSpanId?: string): Span {
    const span: Span = {
      traceId,
      spanId: crypto.randomUUID(),
      parentSpanId: parentSpanId ?? null,
      agentName,
      taskId,
      startTime: new Date().toISOString(),
      endTime: null,
      status: "running",
    };
    this.spans.set(span.spanId, span);
    return span;
  }

  endSpan(spanId: string, status: "completed" | "error" = "completed"): Span | undefined {
    const span = this.spans.get(spanId);
    if (!span) return undefined;
    span.endTime = new Date().toISOString();
    span.status = status;
    return span;
  }

  getSpan(spanId: string): Span | undefined {
    return this.spans.get(spanId);
  }

  getTrace(traceId: string): Span[] {
    return Array.from(this.spans.values())
      .filter((s) => s.traceId === traceId)
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
  }

  getActiveSpans(): Span[] {
    return Array.from(this.spans.values()).filter((s) => s.endTime === null);
  }

  toTimeline(traceId: string): string {
    const spans = this.getTrace(traceId);
    if (spans.length === 0) return `Trace ${traceId}: (empty)`;

    const lines = [`Trace ${traceId}:`];
    for (const span of spans) {
      const duration = span.endTime
        ? `${new Date(span.endTime).getTime() - new Date(span.startTime).getTime()}ms`
        : "running";
      const indent = span.parentSpanId ? "  " : "";
      lines.push(
        `${indent}[${span.status}] ${span.agentName}:${span.taskId} (${duration})`
      );
    }
    return lines.join("\n");
  }
}
