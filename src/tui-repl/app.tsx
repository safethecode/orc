/** @jsxImportSource @opentui/react */
import { useReducer, useCallback, useEffect } from "react";
import { StoreContext, INITIAL_STATE, reducer } from "./store.ts";
import { MessageArea } from "./components/message-area.tsx";
import { StatusBar } from "./components/status-bar.tsx";
import { WorkerHud } from "./components/worker-hud.tsx";
import { InputArea } from "./components/input-area.tsx";
import { createMessage } from "./store.ts";

interface Props {
  onSubmit?: (text: string) => void;
  dispatchRef?: { current: ((action: any) => void) | null };
}

export function App({ onSubmit, dispatchRef }: Props) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);

  // Expose dispatch to outer scope so controller can send actions
  useEffect(() => {
    if (dispatchRef) dispatchRef.current = dispatch;
    return () => { if (dispatchRef) dispatchRef.current = null; };
  }, [dispatch, dispatchRef]);

  const handleSubmit = useCallback(
    (text: string) => {
      // Echo user message to the store
      dispatch({ type: "APPEND_MESSAGE", message: createMessage("user", text) });
      if (onSubmit) onSubmit(text);
    },
    [onSubmit],
  );

  return (
    <StoreContext.Provider value={{ state, dispatch }}>
      <box flexDirection="column" width="100%" height="100%">
        <MessageArea />
        <WorkerHud />
        <StatusBar />
        <InputArea onSubmit={handleSubmit} />
      </box>
    </StoreContext.Provider>
  );
}
