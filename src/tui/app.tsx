import React from "react";
import { render } from "ink";
import type { Orchestrator } from "../core/orchestrator.ts";
import type { OrchestratorConfig } from "../config/types.ts";
import { Dashboard } from "./dashboard.tsx";

export async function renderDashboard(orchestrator: Orchestrator, config: OrchestratorConfig) {
  const { waitUntilExit } = render(
    <Dashboard orchestrator={orchestrator} config={config} />
  );
  await waitUntilExit();
}
