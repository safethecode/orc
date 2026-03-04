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
    toolUse(name, detail) {
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("tool", "", { toolName: name, toolDetail: detail }) });
    },
    workerToolUse(agentName, toolName, detail) {
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("tool", "", { agentName, toolName, toolDetail: detail }) });
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
      dispatch({ type: "STATUS_UPDATE", partial: { agentState: "thinking", agentName, tier } });
    },
    updateSpinner(_text) {
      // Status bar auto-updates from state
    },
    stopSpinner() {
      dispatch({ type: "STATUS_UPDATE", partial: { agentState: "idle" } });
    },
    notifyIdle() {
      dispatch({ type: "STATUS_UPDATE", partial: { agentState: "idle" } });
    },
    updateCostLive(usd) {
      dispatch({ type: "STATUS_UPDATE", partial: { cost: usd } });
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
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("system", `mcp scout: ${names.join(", ")} (${durationMs}ms)`) });
    },
    skillScout(names, durationMs) {
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("system", `skills: ${names.join(", ")} (${durationMs}ms)`) });
    },
    retryAttempt(attempt, maxAttempts, reason) {
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("system", `retry ${attempt}/${maxAttempts}: ${reason}`) });
    },
    qualityGate(passes, issues) {
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("system", passes ? "quality: passed" : `quality: failed — ${issues.join(", ")}`, { passed: passes, issues }) });
    },
    costEstimate(single, multi, recommendation) {
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("system", `cost estimate: $${single.toFixed(4)} single / $${multi.toFixed(4)} multi — ${recommendation}`) });
    },
    conflictWarning(conflicts) {
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("system", `conflicts: ${conflicts.join(", ")}`) });
    },
    riskAssessment(risks) {
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("system", `risks: ${risks.join(", ")}`) });
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
    taskList(items) {
      dispatch({
        type: "APPEND_MESSAGE",
        message: createMessage("task_list", "", {
          taskItems: items.map((i) => ({ ...i, status: "pending" as const })),
        }),
      });
    },
    taskUpdate(taskId, status, durationMs) {
      dispatch({ type: "UPDATE_TASK_LIST", taskId, status, durationMs });
    },
  };
}
