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
  // Polyfill Bun.stripANSI — OpenTUI's KeyHandler.processPaste() calls it
  // but it doesn't exist in current Bun versions, silently killing paste events
  if (typeof (Bun as any).stripANSI !== "function") {
    (Bun as any).stripANSI = (str: string) =>
      str.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)/g, "");
  }

  // Save real stdout.write before OpenTUI intercepts it (OTUI_OVERRIDE_STDOUT=true)
  const realWrite = process.stdout.write.bind(process.stdout);

  const cliRenderer = await createCliRenderer({
    exitOnCtrlC: true,
  });

  // Enable bracketed paste mode so Cmd+V / Ctrl+V paste works in textarea
  // Must use realWrite since OpenTUI intercepts process.stdout.write
  realWrite("\x1b[?2004h");

  // Ensure terminal modes are reset on ANY exit (including process.exit(0) from Ctrl+C)
  // process.on("exit") fires synchronously, so realWrite still works
  process.on("exit", () => {
    realWrite("\x1b[?2004l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1006l");
  });

  // Mutable ref: populated once App mounts and useReducer dispatch is available
  const dispatchRef: { current: ((action: any) => void) | null } = { current: null };

  // Mutable ref: populated when an approval is pending, resolved by App's Y/N handler
  const approvalRef: { current: { resolve: (approved: boolean) => void } | null } = { current: null };

  // Mutable ref: populated when agent asks user a question, resolved by App's input handler
  const askUserRef: { current: { resolve: (answer: string) => void; question: string; options?: string[] } | null } = { current: null };

  let controller: ReplController | null = null;

  const rendererOpts = {
    version: "0.1.0",
    cwd: process.cwd(),
    defaultTier: config.defaultTier ?? "sonnet",
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

  // AskUser callback: dispatches SHOW_QUESTION, waits for user answer via Promise
  const askUserCallback = async (question: string, options?: string[]): Promise<string> => {
    return new Promise<string>((resolve) => {
      askUserRef.current = { resolve, question, options };
      if (dispatchRef.current) {
        dispatchRef.current({ type: "SHOW_QUESTION", question, options });
      }
    });
  };

  const handleSubmit = async (text: string) => {
    if (!controller && dispatchRef.current) {
      const tuiRenderer = createTuiRenderer(dispatchRef.current, rendererOpts);
      controller = new ReplController({ orchestrator, config, renderer: tuiRenderer, approve: approveCallback, askUser: askUserCallback });
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

  // Extract agent list for @ picker
  const agents = orchestrator.getRegistry().list().map((p) => ({
    name: p.name,
    role: p.role,
  }));

  const root = createRoot(cliRenderer);
  root.render(
    <App
      onSubmit={handleSubmit}
      onAbort={handleAbort}
      dispatchRef={dispatchRef}
      approvalRef={approvalRef}
      askUserRef={askUserRef}
      agents={agents}
    />,
  );

  // Initialize controller immediately once dispatch is available
  setTimeout(async () => {
    if (dispatchRef.current) {
      const tuiRenderer = createTuiRenderer(dispatchRef.current, rendererOpts);
      controller = new ReplController({ orchestrator, config, renderer: tuiRenderer, approve: approveCallback, askUser: askUserCallback });
      await controller.initialize();
    }
  }, 100);

  // Keep process alive until renderer is destroyed
  await new Promise<void>((resolve) => {
    cliRenderer.on("destroy", () => {
      // Disable bracketed paste mode and mouse tracking on exit
      // Mouse: 1000=basic, 1002=button-event, 1003=any-event, 1006=SGR format
      realWrite("\x1b[?2004l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1006l");
      resolve();
    });
  });
}
