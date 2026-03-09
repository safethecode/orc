/** @jsxImportSource @opentui/react */
import { useReducer, useCallback, useEffect, useRef } from "react";
import { useKeyboard } from "@opentui/react";
import { StoreContext, INITIAL_STATE, reducer } from "./store.ts";
import { MessageArea } from "./components/message-area.tsx";
import { StatusBar } from "./components/status-bar.tsx";

import { ProjectBar } from "./components/project-bar.tsx";
import { InputArea, type AgentEntry } from "./components/input-area.tsx";
import { ApprovalDialog } from "./components/approval-dialog.tsx";
import { createMessage } from "./store.ts";

interface Props {
  onSubmit?: (text: string) => void;
  onAbort?: () => void;
  dispatchRef?: { current: ((action: any) => void) | null };
  approvalRef?: { current: { resolve: (approved: boolean) => void } | null };
  agents?: AgentEntry[];
}

export function App({ onSubmit, onAbort, dispatchRef, approvalRef, agents }: Props) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);

  // Refs for stable access inside useKeyboard callback
  const stateRef = useRef(state);
  stateRef.current = state;

  // Expose dispatch to outer scope so controller can send actions
  useEffect(() => {
    if (dispatchRef) dispatchRef.current = dispatch;
    return () => { if (dispatchRef) dispatchRef.current = null; };
  }, [dispatch, dispatchRef]);

  const isAgentRunning = state.status.agentState !== "idle";
  const isAgentRunningRef = useRef(isAgentRunning);
  isAgentRunningRef.current = isAgentRunning;

  const handleSubmit = useCallback(
    (text: string) => {
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("user", text) });
      if (onSubmit) onSubmit(text);
    },
    [onSubmit],
  );

  const handleApprove = useCallback(() => {
    dispatch({ type: "RESOLVE_APPROVAL" });
    approvalRef?.current?.resolve(true);
  }, [approvalRef]);

  const handleDeny = useCallback(() => {
    dispatch({ type: "RESOLVE_APPROVAL" });
    approvalRef?.current?.resolve(false);
  }, [approvalRef]);

  // Global keyboard handler via useKeyboard (fires before focused renderables)
  useKeyboard((key: any) => {
    // Ctrl+C: always exit (raw mode doesn't generate SIGINT)
    if (key.name === "c" && key.ctrl) {
      process.exit(0);
    }

    // Approval dialog: Y/N/Escape
    if (stateRef.current.approval) {
      if (key.name === "y") {
        handleApprove();
        key.stopPropagation();
        return;
      }
      if (key.name === "n" || key.name === "escape") {
        handleDeny();
        key.stopPropagation();
        return;
      }
      // Block all other keys while approval is active
      key.stopPropagation();
      return;
    }

    // Escape: abort running agent
    if (key.name === "escape" && isAgentRunningRef.current && onAbort) {
      onAbort();
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("system", "Generation aborted.") });
      key.stopPropagation();
    }

    // Ctrl+L: clear messages
    if (key.name === "l" && key.ctrl) {
      dispatch({ type: "CLEAR" });
      key.stopPropagation();
    }
  });

  return (
    <StoreContext.Provider value={{ state, dispatch }}>
      <box flexDirection="column" width="100%" height="100%">
        <MessageArea />
        <ProjectBar />
        <StatusBar />
        {state.approval ? (
          <ApprovalDialog
            command={state.approval.command}
            message={state.approval.message}
            onApprove={handleApprove}
            onDeny={handleDeny}
          />
        ) : (
          <InputArea onSubmit={handleSubmit} agents={agents} />
        )}
      </box>
    </StoreContext.Provider>
  );
}
