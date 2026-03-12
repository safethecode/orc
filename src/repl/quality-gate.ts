import type { CritiqueResult } from "../config/types.ts";

function isConversationalRole(role: string): boolean {
  const lower = role.toLowerCase();
  return lower.includes("conversational") || lower.includes("assistant") || lower === "conversation";
}

function isDesignRole(role: string): boolean {
  return role.toLowerCase().includes("design");
}

export function runQualityGate(
  context: { agentRole: string; prompt: string; toolUseCount?: number },
  result: string,
): CritiqueResult {
  const issues: string[] = [];
  const improvements: string[] = [];

  // Heuristic checks (fast, no LLM call)
  // Skip length check for conversational agents (Sam etc.) — short replies are normal
  if (!isConversationalRole(context.agentRole) && result.length < 30) {
    issues.push("Result is suspiciously short");
  }

  if (/TODO|FIXME|HACK|XXX/i.test(result)) {
    issues.push("Contains TODO/FIXME markers");
    improvements.push("Resolve all TODO/FIXME items before completion");
  }

  if (/error|Error|ERROR/.test(result) && /traceback|stack trace|at .+\(.+:\d+/i.test(result)) {
    issues.push("Result contains error traces");
    improvements.push("Fix errors before reporting completion");
  }

  if (result.includes("I cannot") || result.includes("I'm unable") || result.includes("I don't have")) {
    issues.push("Agent reported inability to complete task");
  }

  // Design-specific checks (fast regex, no LLM)
  if (isDesignRole(context.agentRole) && result.length > 200) {
    // 1. Missing reference declaration
    if (!/This UI follows|Reference:|레퍼런스:|참고:/i.test(result)) {
      issues.push("Design output missing reference declaration");
      improvements.push("Declare reference products before generating UI (PRIORITY 0 protocol)");
    }

    // 2. Gradient abuse (linear-gradient in non-progress-bar context)
    const gradientCount = (result.match(/linear-gradient|radial-gradient|bg-gradient/g) || []).length;
    if (gradientCount > 1) {
      issues.push(`Gradient abuse: ${gradientCount} gradients detected`);
      improvements.push("Real SaaS products use flat solid colors, not gradients");
    }

    // 3. Rainbow badge syndrome (4+ distinct bg-color utilities for badges/tags)
    const colorBadges = new Set((result.match(/bg-(red|green|blue|yellow|purple|pink|indigo|teal|orange|amber|violet|rose|emerald|cyan|fuchsia|lime)-\d+/g) || []));
    if (colorBadges.size > 3) {
      issues.push(`Rainbow syndrome: ${colorBadges.size} distinct badge colors`);
      improvements.push("Use gray as default badge color. Max 3 colors: gray + red (danger) + green (success)");
    }

    // 4. Glassmorphism / excessive blur
    if (/backdrop-blur-(?:lg|xl|2xl|3xl)|glass|glassmorphism/i.test(result)) {
      issues.push("Glassmorphism detected");
      improvements.push("Production SaaS uses solid backgrounds with subtle borders, not glass effects");
    }

    // 5. Oversized border-radius
    if (/rounded-(?:2xl|3xl|full)|border-radius:\s*(?:1[6-9]|[2-9]\d|\d{3,})px/i.test(result)) {
      issues.push("Oversized border-radius detected");
      improvements.push("Max radius: 8-12px for cards, 6px for inputs. Never rounded-2xl on containers");
    }

    // 6. scale() on hover (cards/buttons)
    if (/hover:.*scale|transform.*scale\(1\.[0-9]/i.test(result)) {
      issues.push("scale() hover effect detected");
      improvements.push("Use bg-color shift only for hover. Never scale() on cards");
    }

    // 7. Excessive shadows
    if (/shadow-(?:lg|xl|2xl)|box-shadow:\s*0\s+\d{2,}/i.test(result)) {
      issues.push("Heavy shadows detected");
      improvements.push("Use border instead of shadows. Real products use border-gray-200, not shadow-lg");
    }

    // 8. Hand-written SVG icons (should use lucide-react)
    const svgCount = (result.match(/<svg[\s>]/gi) || []).length;
    if (svgCount > 2) {
      issues.push(`Hand-written SVG icons: ${svgCount} found`);
      improvements.push("Use lucide-react for icons, never hand-write SVG");
    }
  }

  // Intent without action: text declares action but zero tools were used
  if (!isConversationalRole(context.agentRole) && (context.toolUseCount ?? -1) === 0) {
    const ACTION_INTENT = /겠습니다|할게요|하겠|시작합니다|진행하겠|진행합니다|let\s+me|i['']ll\s|i\s+will\s|i['']m\s+going\s+to/i;
    if (ACTION_INTENT.test(result)) {
      issues.push("Intent without action: declared actions but used zero tools");
      improvements.push("Use tools to execute actions instead of just describing them");
    }
  }

  const passed = issues.length === 0;

  return {
    passes: passed,
    issues,
    improvements,
    confidence: passed ? "high" : issues.length > 2 ? "low" : "medium",
  };
}
