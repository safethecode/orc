/** @jsxImportSource @opentui/react */
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import type { Orchestrator } from "../core/orchestrator.ts";
import type { OrchestratorConfig } from "../config/types.ts";
import { App } from "./app.tsx";
import { createTuiRenderer } from "./tui-renderer.ts";
import { ReplController } from "../repl/repl-controller.ts";

export async function startTuiRepl(
  orchestrator: Orchestrator,
  config: OrchestratorConfig,
): Promise<void> {
  const cliRenderer = await createCliRenderer({
    exitOnCtrlC: true,
  });

  // Mutable ref: populated once App mounts and useReducer dispatch is available
  const dispatchRef: { current: ((action: any) => void) | null } = { current: null };

  let controller: ReplController | null = null;

  const handleSubmit = async (text: string) => {
    if (!controller && dispatchRef.current) {
      const tuiRenderer = createTuiRenderer(dispatchRef.current);
      controller = new ReplController({ orchestrator, config, renderer: tuiRenderer });
      await controller.initialize();
    }
    if (controller) {
      const result = await controller.handle(text);
      if (result === "quit") cliRenderer.destroy();
    }
  };

  const handleAbort = () => {
    if (controller) controller.abort();
  };

  const root = createRoot(cliRenderer);
  root.render(<App onSubmit={handleSubmit} onAbort={handleAbort} dispatchRef={dispatchRef} />);

  // Initialize controller immediately once dispatch is available
  setTimeout(async () => {
    if (dispatchRef.current) {
      const tuiRenderer = createTuiRenderer(dispatchRef.current);
      controller = new ReplController({ orchestrator, config, renderer: tuiRenderer });
      await controller.initialize();
    }
  }, 100);

  // Keep process alive until renderer is destroyed
  await new Promise<void>((resolve) => {
    cliRenderer.on("destroy", resolve);
  });
}
