/** @jsxImportSource @opentui/react */
import { useReducer, useCallback, useEffect, useRef } from "react";
import { StoreContext, INITIAL_STATE, reducer } from "./store.ts";
import { MessageArea } from "./components/message-area.tsx";
import { StatusBar } from "./components/status-bar.tsx";
import { WorkerHud } from "./components/worker-hud.tsx";
import { ProjectBar } from "./components/project-bar.tsx";
import { InputArea } from "./components/input-area.tsx";
import { ApprovalDialog } from "./components/approval-dialog.tsx";
import { createMessage } from "./store.ts";

interface Props {
  onSubmit?: (text: string) => void;
  onAbort?: () => void;
  dispatchRef?: { current: ((action: any) => void) | null };
  approvalRef?: { current: { resolve: (approved: boolean) => void } | null };
}

export function App({ onSubmit, onAbort, dispatchRef, approvalRef }: Props) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const approvalRefLocal = useRef(approvalRef);
  approvalRefLocal.current = approvalRef;

  // Expose dispatch to outer scope so controller can send actions
  useEffect(() => {
    if (dispatchRef) dispatchRef.current = dispatch;
    return () => { if (dispatchRef) dispatchRef.current = null; };
  }, [dispatch, dispatchRef]);

  const isAgentRunning = state.status.agentState !== "idle";

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

  // Global keyboard shortcuts
  const handleKeyPress = useCallback(
    (key: string) => {
      // Approval dialog: Y/N keys
      if (state.approval) {
        if (key === "y" || key === "Y") {
          handleApprove();
          return;
        }
        if (key === "n" || key === "N" || key === "escape") {
          handleDeny();
          return;
        }
        return; // Block other keys while approval is active
      }

      // Escape: abort running agent
      if (key === "escape" && isAgentRunning && onAbort) {
        onAbort();
        dispatch({ type: "APPEND_MESSAGE", message: createMessage("system", "Generation aborted.") });
      }
      // Ctrl+L: clear messages
      if (key === "ctrl+l") {
        dispatch({ type: "CLEAR" });
      }
    },
    [isAgentRunning, onAbort, state.approval, handleApprove, handleDeny],
  );

  return (
    <StoreContext.Provider value={{ state, dispatch }}>
      <box flexDirection="column" width="100%" height="100%" onKeyPress={handleKeyPress}>
        <MessageArea />
        <WorkerHud />
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
          <InputArea onSubmit={handleSubmit} />
        )}
      </box>
    </StoreContext.Provider>
  );
}
