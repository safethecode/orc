import type { Dispatch } from "react";
import type { RendererPort } from "../repl/renderer-types.ts";
import type { ModelTier } from "../config/types.ts";
import { createMessage } from "./store.ts";

type Action = Parameters<Dispatch<any>>[0];

export interface TuiRendererOptions {
  version?: string;
  cwd?: string;
  defaultTier?: string;
}

export function createTuiRenderer(dispatch: (action: any) => void, opts: TuiRendererOptions = {}): RendererPort {
  return {
    welcome(profiles) {
      dispatch({
        type: "APPEND_MESSAGE",
        message: createMessage("welcome", profiles.join(", "), {
          version: opts.version,
          cwd: opts.cwd,
          defaultTier: opts.defaultTier,
        }),
      });
    },
    agentHeader(name, tier, reason) {
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("agent_header", name, { agentName: name, tier, reason }) });
    },
    startBox(tier) {
      dispatch({ type: "STREAMING_START", tier });
    },
    endBox() {
      dispatch({ type: "STREAMING_COMMIT" });
    },
    text(content) {
      dispatch({ type: "STREAMING_DELTA", text: content });
    },
    toolUse(name, detail, _insideBox, _input) {
      const toolLabel = detail ? `${name} ${detail}` : name;
      dispatch({ type: "PUSH_RECENT_TOOL", tool: toolLabel });
      // Show as compact inline message so it's visible even during streaming
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("system", `● ${toolLabel}`) });
    },
    workerToolUse(agentName, toolName, detail) {
      // No APPEND_MESSAGE — worker activity is shown inline in the task tree
      dispatch({ type: "UPDATE_WORKER", name: agentName, partial: { lastTool: `${toolName}${detail ? " " + detail : ""}`, state: "tool_use" } });
    },
    workerFileChange(agentName, action, filePath) {
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("system", `${agentName}: ${action} ${filePath}`) });
    },
    cost(usd, inputTokens, outputTokens, durationMs) {
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("cost", "", { cost: usd, inputTokens, outputTokens, durationMs }) });
    },
    error(message) {
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("error", message) });
    },
    info(message) {
      // Merge formatter info into welcome panel instead of separate message
      if (message.startsWith("Formatters: ")) {
        const fmts = message.replace("Formatters: ", "").split(", ");
        dispatch({ type: "UPDATE_WELCOME_META", partial: { formatters: fmts } });
        return;
      }
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("system", message) });
    },
    dim(message) {
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("system", message) });
    },
    handoff(from, to) {
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("handoff", `${from} → ${to}`, { agentName: from, reason: to }) });
    },
    separator() {
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("separator", "") });
    },
    startSpinner(agentName, tier) {
      dispatch({ type: "STATUS_UPDATE", partial: { agentState: "thinking", agentName, tier, elapsedStart: Date.now(), recentTools: [], liveInputTokens: 0, liveOutputTokens: 0 } });
    },
    updateSpinner(text) {
      if (text) {
        dispatch({ type: "PUSH_RECENT_TOOL", tool: text });
      }
    },
    stopSpinner() {
      dispatch({ type: "STATUS_UPDATE", partial: { agentState: "idle", currentTool: "", recentTools: [] } });
    },
    notifyIdle() {
      dispatch({ type: "STATUS_UPDATE", partial: { agentState: "idle", currentTool: "", recentTools: [] } });
    },
    updateCostLive(usd, inputTokens?: number, outputTokens?: number) {
      const partial: Record<string, any> = { cost: usd };
      if (inputTokens != null) partial.liveInputTokens = inputTokens;
      if (outputTokens != null) partial.liveOutputTokens = outputTokens;
      dispatch({ type: "STATUS_UPDATE", partial });
    },
    brainstormStatus(count, durationMs) {
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("system", `deliberation: ${count} rounds in ${(durationMs / 1000).toFixed(1)}s`) });
    },
    planSummary(subtasks, _plan) {
      const lines = subtasks.map((s, i) => `  ${i + 1}. ${s.prompt.slice(0, 80)}`).join("\n");
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("system", `plan:\n${lines}`) });
    },
    phaseHeader(name, count, parallel) {
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("system", `phase: ${name} (${count} tasks${parallel ? ", parallel" : ""})`) });
    },
    mcpStatus(serverNames, _toolCount) {
      dispatch({ type: "UPDATE_WELCOME_META", partial: { mcpServers: serverNames } });
    },
    mcpScout(names, durationMs) {
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("system", `MCP Scout: ${names.join(", ")} (${durationMs}ms)`) });
    },
    skillScout(names, durationMs) {
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("system", `Skills: ${names.join(", ")} (${durationMs}ms)`) });
    },
    retryAttempt(attempt, maxAttempts, reason) {
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("system", `Retry ${attempt}/${maxAttempts}: ${reason}`) });
    },
    qualityGate(passes, issues) {
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("system", passes ? "Quality: PASSED" : `Quality: FAILED — ${issues.join(", ")}`, { passed: passes, issues }) });
    },
    costEstimate(single, multi, recommendation) {
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("system", `Cost estimate: $${single.toFixed(4)} single / $${multi.toFixed(4)} multi — ${recommendation}`) });
    },
    conflictWarning(conflicts) {
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("system", `Conflicts: ${conflicts.join(", ")}`) });
    },
    riskAssessment(risks) {
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("system", `Risks: ${risks.join(", ")}`) });
    },
    phaseStart(phaseNum, name, target) {
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("system", `phase ${phaseNum}: ${name} (target: ${target})`) });
    },
    studyComplete(durationMs) {
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("system", `study complete (${(durationMs / 1000).toFixed(1)}s)`) });
    },
    verificationResult(path, valid, issue) {
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("system", valid ? `path ${path}: valid` : `path ${path}: invalid — ${issue}`) });
    },
    goldenLoaded(count) {
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("system", `golden: ${count} loaded`) });
    },
    goldenSaved(metric) {
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("system", `golden saved (metric: ${metric})`) });
    },
    researchStart(round) {
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("system", `research round ${round}`) });
    },
    researchProgress(phase, detail) {
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("system", `research: ${phase}${detail ? ` — ${detail}` : ""}`) });
    },
    researchComplete(durationMs) {
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("system", `research complete (${(durationMs / 1000).toFixed(1)}s)`) });
    },
    phaseUpdate(phase, detail) {
      dispatch({ type: "STATUS_UPDATE", partial: { phase: phase as any, phaseDetail: detail ?? "" } });
    },
    taskList(items, description) {
      dispatch({
        type: "APPEND_MESSAGE",
        message: createMessage("task_list", "", {
          taskItems: items.map((i) => ({ ...i, status: "pending" as const })),
          taskDescription: description,
        }),
      });
    },
    taskUpdate(taskId, status, durationMs) {
      dispatch({ type: "UPDATE_TASK_LIST", taskId, status, durationMs });
    },
    taskTokens(taskId, inputTokens, outputTokens) {
      dispatch({ type: "UPDATE_TASK_TOKENS", taskId, inputTokens, outputTokens });
    },
    workerStart(agentName, taskId, model) {
      dispatch({
        type: "REGISTER_WORKER",
        name: agentName,
        entry: { state: "thinking", model, startedAt: Date.now(), taskId, inputTokens: 0, outputTokens: 0 },
      });
    },
    workerUpdate(agentName, partial) {
      dispatch({ type: "UPDATE_WORKER", name: agentName, partial });
    },
    workerDone(agentName) {
      dispatch({ type: "REMOVE_WORKER", name: agentName });
    },
  };
}
