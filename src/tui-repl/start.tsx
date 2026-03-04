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

  // Enable bracketed paste mode so Cmd+V / Ctrl+V paste works in textarea
  process.stdout.write("\x1b[?2004h");

  // Mutable ref: populated once App mounts and useReducer dispatch is available
  const dispatchRef: { current: ((action: any) => void) | null } = { current: null };

  // Mutable ref: populated when an approval is pending, resolved by App's Y/N handler
  const approvalRef: { current: { resolve: (approved: boolean) => void } | null } = { current: null };

  let controller: ReplController | null = null;

  const rendererOpts = {
    version: "0.1.0",
    cwd: process.cwd(),
    defaultTier: config.defaultTier ?? "haiku",
  };

  // Approval callback: dispatches SHOW_APPROVAL, waits for user Y/N via Promise
  const approveCallback = async (command: string, message: string): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      approvalRef.current = { resolve };
      if (dispatchRef.current) {
        dispatchRef.current({ type: "SHOW_APPROVAL", command, message });
      }
    });
  };

  const handleSubmit = async (text: string) => {
    if (!controller && dispatchRef.current) {
      const tuiRenderer = createTuiRenderer(dispatchRef.current, rendererOpts);
      controller = new ReplController({ orchestrator, config, renderer: tuiRenderer, approve: approveCallback });
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
  root.render(
    <App
      onSubmit={handleSubmit}
      onAbort={handleAbort}
      dispatchRef={dispatchRef}
      approvalRef={approvalRef}
    />,
  );

  // Initialize controller immediately once dispatch is available
  setTimeout(async () => {
    if (dispatchRef.current) {
      const tuiRenderer = createTuiRenderer(dispatchRef.current, rendererOpts);
      controller = new ReplController({ orchestrator, config, renderer: tuiRenderer, approve: approveCallback });
      await controller.initialize();
    }
  }, 100);

  // Keep process alive until renderer is destroyed
  await new Promise<void>((resolve) => {
    cliRenderer.on("destroy", () => {
      // Disable bracketed paste mode on exit
      process.stdout.write("\x1b[?2004l");
      resolve();
    });
  });
}
