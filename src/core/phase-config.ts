import type { ExecutionPhase, PhaseModelConfig, ModelTier, OrchestratorConfig } from "../config/types.ts";

export const DEFAULT_PHASE_MODELS: Record<ExecutionPhase, PhaseModelConfig> = {
  spec:     { model: "sonnet", thinkingLevel: "medium" },
  planning: { model: "opus",   thinkingLevel: "high" },
  coding:   { model: "sonnet", thinkingLevel: "medium" },
  review:   { model: "sonnet", thinkingLevel: "high" },
  qa:       { model: "haiku",  thinkingLevel: "low" },
  fix:      { model: "sonnet", thinkingLevel: "medium" },
};

export function getPhaseModel(
  phase: ExecutionPhase,
  overrides?: Partial<Record<ExecutionPhase, PhaseModelConfig>>,
): PhaseModelConfig {
  if (overrides?.[phase]) {
    return { ...DEFAULT_PHASE_MODELS[phase], ...overrides[phase] };
  }
  return DEFAULT_PHASE_MODELS[phase];
}

export function resolveModelForPhase(
  phase: ExecutionPhase,
  config: OrchestratorConfig,
): { model: ModelTier; flags: string[] } {
  const phaseConfig = DEFAULT_PHASE_MODELS[phase];
  const flags: string[] = [];

  if (phaseConfig.thinkingLevel) {
    flags.push(`--thinking=${phaseConfig.thinkingLevel}`);
  }
  if (phaseConfig.maxTokens) {
    flags.push(`--max-tokens=${phaseConfig.maxTokens}`);
  }

  return { model: phaseConfig.model, flags };
}
