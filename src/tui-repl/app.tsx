/** @jsxImportSource @opentui/react */
import { useReducer, useCallback, useEffect } from "react";
import { StoreContext, INITIAL_STATE, reducer } from "./store.ts";
import { MessageArea } from "./components/message-area.tsx";
import { StatusBar } from "./components/status-bar.tsx";
import { WorkerHud } from "./components/worker-hud.tsx";
import { ProjectBar } from "./components/project-bar.tsx";
import { InputArea } from "./components/input-area.tsx";
import { createMessage } from "./store.ts";

interface Props {
  onSubmit?: (text: string) => void;
  onAbort?: () => void;
  dispatchRef?: { current: ((action: any) => void) | null };
}

export function App({ onSubmit, onAbort, dispatchRef }: Props) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);

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

  // Global keyboard shortcuts
  const handleKeyPress = useCallback(
    (key: string) => {
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
    [isAgentRunning, onAbort],
  );

  return (
    <StoreContext.Provider value={{ state, dispatch }}>
      <box flexDirection="column" width="100%" height="100%" onKeyPress={handleKeyPress}>
        <MessageArea />
        <WorkerHud />
        <ProjectBar />
        <StatusBar />
        <InputArea onSubmit={handleSubmit} />
      </box>
    </StoreContext.Provider>
  );
}
