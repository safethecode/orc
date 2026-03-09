/** @jsxImportSource @opentui/react */
import { useState, useEffect } from "react";
import type { MessageMeta } from "../store.ts";
import { useStore } from "../store.ts";
import { SPINNER_FRAMES } from "../theme-adapter.ts";

interface Props {
  meta?: MessageMeta;
}

function formatTokens(input?: number, output?: number): string {
  const total = (input ?? 0) + (output ?? 0);
  if (total === 0) return "";
  if (total < 1000) return `${total} tokens`;
  return `${(total / 1000).toFixed(1)}k tokens`;
}

function formatElapsed(startMs: number): string {
  const sec = Math.floor((Date.now() - startMs) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${sec % 60}s`;
}

function formatDuration(ms?: number): string {
  if (!ms) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function TaskListDisplay({ meta }: Props) {
  const items = meta?.taskItems ?? [];
  const { state } = useStore();
  const [frame, setFrame] = useState(0);

  if (items.length === 0) return null;

  const hasRunning = items.some((i) => i.status === "running");
  const allDone = items.every((i) => i.status === "passed" || i.status === "failed");

  // Spinner animation — only when tasks are running
  useEffect(() => {
    if (!hasRunning) return;
    const id = setInterval(() => setFrame((f) => f + 1), 80);
    return () => clearInterval(id);
  }, [hasRunning]);

  const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
  const headerIcon = allDone ? "\u2713" : spinner;
  const headerColor = allDone ? "#9ece6a" : "#7aa2f7";
  const description = meta?.taskDescription ?? "Multi-agent execution";
  const totalTokens = formatTokens(meta?.totalInputTokens, meta?.totalOutputTokens);

  // Find the timestamp of the task_list message for elapsed time
  const taskListMsg = state.messages.findLast((m) => m.type === "task_list");
  const elapsed = taskListMsg ? formatElapsed(taskListMsg.timestamp) : "";

  // Worker map for matching running tasks to current tool
  const workers = state.status.workers;

  return (
    <box flexDirection="column" paddingLeft={2} paddingTop={1}>
      {/* Header row */}
      <box flexDirection="row" gap={1}>
        <text fg={headerColor} bold>{headerIcon}</text>
        <text fg="#c0caf5" bold>{description.length > 60 ? description.slice(0, 57) + "..." : description}</text>
        {elapsed && <text fg="#565f89">{elapsed}</text>}
        {totalTokens && <text fg="#565f89">{totalTokens}</text>}
      </box>

      {/* Subtask rows */}
      {items.map((item, i) => {
        const isLast = i === items.length - 1;
        const connector = isLast ? "\u2514\u2500 " : "\u251C\u2500 ";

        let icon: string;
        let iconColor: string;
        switch (item.status) {
          case "running":
            icon = spinner;
            iconColor = "#7aa2f7";
            break;
          case "passed":
            icon = "\u25A0";
            iconColor = "#9ece6a";
            break;
          case "failed":
            icon = "\u2717";
            iconColor = "#f7768e";
            break;
          default:
            icon = "\u25A1";
            iconColor = "#565f89";
            break;
        }

        // Right-side info: tool for running, duration+tokens for done, dash for pending
        let rightInfo = "";
        if (item.status === "running") {
          // Find worker with matching taskId
          for (const [, w] of workers) {
            if (w.taskId === item.id && w.lastTool) {
              const tool = w.lastTool;
              // Truncate long tool paths: "Read /very/long/path/file.ts" → "Read …path/file.ts"
              if (tool.length > 40) {
                const spaceIdx = tool.indexOf(" ");
                if (spaceIdx > 0) {
                  const name = tool.slice(0, spaceIdx);
                  const arg = tool.slice(spaceIdx + 1);
                  const parts = arg.split("/");
                  const short = parts.length > 2 ? parts.slice(-2).join("/") : arg;
                  rightInfo = `${name} …${short}`;
                } else {
                  rightInfo = tool.slice(0, 37) + "...";
                }
              } else {
                rightInfo = tool;
              }
              break;
            }
          }
        } else if (item.status === "passed" || item.status === "failed") {
          const dur = formatDuration(item.durationMs);
          const tok = formatTokens(item.inputTokens, item.outputTokens);
          rightInfo = [dur, tok].filter(Boolean).join("  ");
        } else {
          rightInfo = "\u2014";
        }

        return (
          <box key={item.id} flexDirection="row" paddingLeft={1}>
            <text fg="#3d4262">{connector}</text>
            <text fg={iconColor}>{icon} </text>
            <text fg={item.status === "pending" ? "#565f89" : "#c0caf5"}>{item.label}</text>
            <text fg="#565f89">{`  ${item.role}`}</text>
            {rightInfo && <text fg={item.status === "running" ? "#7aa2f7" : "#565f89"}>{`  ${rightInfo}`}</text>}
          </box>
        );
      })}
    </box>
  );
}
