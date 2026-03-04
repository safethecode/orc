import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import type { Orchestrator } from "../core/orchestrator.ts";
import type { OrchestratorConfig } from "../config/types.ts";
import { App } from "./app.tsx";

export async function startTuiRepl(
  _orchestrator: Orchestrator,
  _config: OrchestratorConfig,
): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
  });

  const root = createRoot(renderer);
  root.render(<App />);

  // Keep process alive until renderer is destroyed
  await new Promise<void>((resolve) => {
    renderer.on("destroy", resolve);
  });
}
