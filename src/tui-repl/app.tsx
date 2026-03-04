/** @jsxImportSource @opentui/react */
import { useReducer, useCallback } from "react";
import { StoreContext, INITIAL_STATE, reducer } from "./store.ts";
import { MessageArea } from "./components/message-area.tsx";
import { StatusBar } from "./components/status-bar.tsx";
import { WorkerHud } from "./components/worker-hud.tsx";
import { InputArea } from "./components/input-area.tsx";

interface Props {
  onSubmit?: (text: string) => void;
}

export function App({ onSubmit }: Props) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);

  const handleSubmit = useCallback(
    (text: string) => {
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
