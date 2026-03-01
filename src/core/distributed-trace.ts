import { eventBus } from "./events.ts";

// ── Types ────────────────────────────────────────────────────────────────

export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  operationName: string;
  serviceName: string;
  startTime: number;
  endTime: number | null;
  durationMs: number | null;
  status: "ok" | "error" | "cancelled";
  tags: Record<string, string | number | boolean>;
  events: Array<{
    timestamp: number;
    name: string;
    attributes: Record<string, string | number>;
  }>;
}

export interface TraceContext {
  traceId: string;
  spanId: string;
}

// ── ID Generation (OpenTelemetry compatible hex) ─────────────────────────

function generateTraceId(): string {
  return Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, "0"),
  ).join("");
}

function generateSpanId(): string {
  return Array.from({ length: 8 }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, "0"),
  ).join("");
}

// ── Distributed Tracer ───────────────────────────────────────────────────

export class DistributedTracer {
  private traces: Map<string, TraceSpan[]> = new Map();
  private activeSpans: Map<string, TraceSpan> = new Map();
  private maxTraces: number;

  constructor(maxTraces: number = 50) {
    this.maxTraces = maxTraces;
  }

  /**
   * Start a new root trace. Returns the trace context.
   */
  startTrace(
    operationName: string,
    serviceName: string,
    tags?: Record<string, string | number | boolean>,
  ): TraceContext {
    this.evict();

    const traceId = generateTraceId();
    const spanId = generateSpanId();

    const span: TraceSpan = {
      traceId,
      spanId,
      parentSpanId: null,
      operationName,
      serviceName,
      startTime: Date.now(),
      endTime: null,
      durationMs: null,
      status: "ok",
      tags: { ...tags },
      events: [],
    };

    this.traces.set(traceId, [span]);
    this.activeSpans.set(spanId, span);

    eventBus.publish({
      type: "trace:start",
      traceId,
      operation: operationName,
      service: serviceName,
    });

    return { traceId, spanId };
  }

  /**
   * Start a child span within an existing trace.
   */
  startSpan(
    parentCtx: TraceContext,
    operationName: string,
    serviceName: string,
    tags?: Record<string, string | number | boolean>,
  ): TraceContext {
    const spanId = generateSpanId();

    const span: TraceSpan = {
      traceId: parentCtx.traceId,
      spanId,
      parentSpanId: parentCtx.spanId,
      operationName,
      serviceName,
      startTime: Date.now(),
      endTime: null,
      durationMs: null,
      status: "ok",
      tags: { ...tags },
      events: [],
    };

    const traceSpans = this.traces.get(parentCtx.traceId);
    if (traceSpans) {
      traceSpans.push(span);
    } else {
      this.traces.set(parentCtx.traceId, [span]);
    }

    this.activeSpans.set(spanId, span);

    eventBus.publish({
      type: "trace:span_start",
      traceId: parentCtx.traceId,
      spanId,
      operation: operationName,
      service: serviceName,
    });

    return { traceId: parentCtx.traceId, spanId };
  }

  /**
   * End a span. Records duration and status.
   */
  endSpan(
    spanId: string,
    status: "ok" | "error" | "cancelled" = "ok",
    errorMessage?: string,
  ): void {
    const span = this.activeSpans.get(spanId);
    if (!span) return;

    span.endTime = Date.now();
    span.durationMs = span.endTime - span.startTime;
    span.status = status;

    if (errorMessage) {
      span.tags["error.message"] = errorMessage;
    }

    this.activeSpans.delete(spanId);

    eventBus.publish({
      type: "trace:span_end",
      traceId: span.traceId,
      spanId,
      durationMs: span.durationMs,
      status,
    });

    // If this is the root span, emit trace:end
    if (span.parentSpanId === null) {
      const traceSpans = this.traces.get(span.traceId) ?? [];
      const allDone = traceSpans.every((s) => s.endTime !== null);
      if (allDone) {
        const overallStatus = traceSpans.some((s) => s.status === "error")
          ? "error"
          : traceSpans.some((s) => s.status === "cancelled")
            ? "cancelled"
            : "ok";

        eventBus.publish({
          type: "trace:end",
          traceId: span.traceId,
          durationMs: span.durationMs,
          spanCount: traceSpans.length,
          status: overallStatus,
        });
      }
    }
  }

  /**
   * Add a timestamped event to a span.
   */
  addEvent(
    spanId: string,
    name: string,
    attributes?: Record<string, string | number>,
  ): void {
    const span = this.activeSpans.get(spanId) ?? this.findSpan(spanId);
    if (!span) return;

    span.events.push({
      timestamp: Date.now(),
      name,
      attributes: { ...attributes },
    });
  }

  /**
   * Add tags to an existing span.
   */
  addTags(spanId: string, tags: Record<string, string | number | boolean>): void {
    const span = this.activeSpans.get(spanId) ?? this.findSpan(spanId);
    if (!span) return;

    Object.assign(span.tags, tags);
  }

  /**
   * Get all spans for a trace.
   */
  getTrace(traceId: string): TraceSpan[] | undefined {
    return this.traces.get(traceId);
  }

  /**
   * Get a specific span.
   */
  getSpan(spanId: string): TraceSpan | undefined {
    return this.activeSpans.get(spanId) ?? this.findSpan(spanId);
  }

  /**
   * Get all active (unfinished) spans.
   */
  getActiveSpans(): TraceSpan[] {
    return [...this.activeSpans.values()];
  }

  /**
   * Get recent traces (newest first).
   */
  getRecentTraces(limit: number = 10): Array<{
    traceId: string;
    rootOperation: string;
    startTime: number;
    durationMs: number | null;
    spanCount: number;
    status: "ok" | "error" | "cancelled" | "in_progress";
    services: string[];
  }> {
    const result: Array<{
      traceId: string;
      rootOperation: string;
      startTime: number;
      durationMs: number | null;
      spanCount: number;
      status: "ok" | "error" | "cancelled" | "in_progress";
      services: string[];
    }> = [];

    for (const [traceId, spans] of this.traces) {
      if (spans.length === 0) continue;

      const root = spans.find((s) => s.parentSpanId === null) ?? spans[0];
      const services = [...new Set(spans.map((s) => s.serviceName))];
      const hasActive = spans.some((s) => s.endTime === null);

      let status: "ok" | "error" | "cancelled" | "in_progress";
      if (hasActive) {
        status = "in_progress";
      } else if (spans.some((s) => s.status === "error")) {
        status = "error";
      } else if (spans.some((s) => s.status === "cancelled")) {
        status = "cancelled";
      } else {
        status = "ok";
      }

      result.push({
        traceId,
        rootOperation: root.operationName,
        startTime: root.startTime,
        durationMs: root.durationMs,
        spanCount: spans.length,
        status,
        services,
      });
    }

    // Sort newest first
    result.sort((a, b) => b.startTime - a.startTime);
    return result.slice(0, limit);
  }

  /**
   * Build a visual trace timeline for terminal display.
   */
  formatTrace(traceId: string): string {
    const spans = this.traces.get(traceId);
    if (!spans || spans.length === 0) return `Trace ${traceId}: (empty)`;

    const root = spans.find((s) => s.parentSpanId === null) ?? spans[0];
    const totalDuration = root.durationMs !== null
      ? formatDuration(root.durationMs)
      : "in progress";

    const lines: string[] = [`Trace ${traceId.slice(0, 12)}... (${totalDuration})`];

    // Build parent-children map
    const childrenMap = new Map<string | null, TraceSpan[]>();
    for (const span of spans) {
      const children = childrenMap.get(span.parentSpanId) ?? [];
      children.push(span);
      childrenMap.set(span.parentSpanId, children);
    }

    // Sort children by start time within each group
    for (const children of childrenMap.values()) {
      children.sort((a, b) => a.startTime - b.startTime);
    }

    // Recursive tree render
    const renderChildren = (parentId: string, prefix: string, isLast: boolean): void => {
      const children = childrenMap.get(parentId) ?? [];
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const last = i === children.length - 1;
        const connector = last ? "\u2514\u2500 " : "\u251c\u2500 ";
        const duration = child.durationMs !== null
          ? `${child.durationMs}ms`
          : "...";
        const statusLabel = child.endTime === null
          ? "\x1b[33mRUNNING\x1b[0m"
          : child.status === "ok"
            ? "\x1b[32mOK\x1b[0m"
            : child.status === "error"
              ? "\x1b[31mERROR\x1b[0m"
              : "\x1b[90mCANCELLED\x1b[0m";

        lines.push(
          `${prefix}${connector}${child.operationName} [\x1b[36m${child.serviceName}\x1b[0m] ${duration} ${statusLabel}`,
        );

        const childPrefix = prefix + (last ? "   " : "\u2502  ");
        renderChildren(child.spanId, childPrefix, last);
      }
    };

    // Render root span
    const rootDuration = root.durationMs !== null
      ? `${root.durationMs}ms`
      : "...";
    const rootStatus = root.endTime === null
      ? "\x1b[33mRUNNING\x1b[0m"
      : root.status === "ok"
        ? "\x1b[32mOK\x1b[0m"
        : root.status === "error"
          ? "\x1b[31mERROR\x1b[0m"
          : "\x1b[90mCANCELLED\x1b[0m";

    lines.push(
      `${root.operationName} [\x1b[36m${root.serviceName}\x1b[0m] ${rootDuration} ${rootStatus}`,
    );

    renderChildren(root.spanId, "", true);

    return lines.join("\n");
  }

  /**
   * Search traces by operation name, service, or tag.
   */
  search(opts: {
    operationName?: string;
    serviceName?: string;
    tag?: { key: string; value: string | number };
    status?: "ok" | "error" | "cancelled";
    minDurationMs?: number;
  }): TraceSpan[] {
    const results: TraceSpan[] = [];

    for (const spans of this.traces.values()) {
      for (const span of spans) {
        if (opts.operationName && !span.operationName.includes(opts.operationName)) continue;
        if (opts.serviceName && span.serviceName !== opts.serviceName) continue;
        if (opts.status && span.status !== opts.status) continue;
        if (opts.minDurationMs !== undefined && (span.durationMs === null || span.durationMs < opts.minDurationMs)) continue;
        if (opts.tag) {
          const tagVal = span.tags[opts.tag.key];
          if (tagVal === undefined || String(tagVal) !== String(opts.tag.value)) continue;
        }
        results.push(span);
      }
    }

    return results;
  }

  /**
   * Evict oldest completed traces when maxTraces exceeded.
   */
  private evict(): void {
    if (this.traces.size < this.maxTraces) return;

    // Collect traces sorted by root start time (oldest first)
    const traceEntries: Array<{ traceId: string; startTime: number; hasActive: boolean }> = [];
    for (const [traceId, spans] of this.traces) {
      const root = spans.find((s) => s.parentSpanId === null) ?? spans[0];
      const hasActive = spans.some((s) => s.endTime === null);
      traceEntries.push({
        traceId,
        startTime: root?.startTime ?? 0,
        hasActive,
      });
    }

    traceEntries.sort((a, b) => a.startTime - b.startTime);

    // Remove oldest completed traces until under limit
    for (const entry of traceEntries) {
      if (this.traces.size < this.maxTraces) break;
      // Never evict traces with active spans
      if (entry.hasActive) continue;

      // Clean up any references
      const spans = this.traces.get(entry.traceId);
      if (spans) {
        for (const span of spans) {
          this.activeSpans.delete(span.spanId);
        }
      }
      this.traces.delete(entry.traceId);
    }
  }

  /**
   * Find a span across all traces (for ended spans not in activeSpans).
   */
  private findSpan(spanId: string): TraceSpan | undefined {
    for (const spans of this.traces.values()) {
      const found = spans.find((s) => s.spanId === spanId);
      if (found) return found;
    }
    return undefined;
  }

  clear(): void {
    this.traces.clear();
    this.activeSpans.clear();
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = ((ms % 60_000) / 1000).toFixed(0);
  return `${minutes}m${seconds}s`;
}
