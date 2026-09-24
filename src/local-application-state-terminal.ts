/** Compact human-terminal flow rendering of the canonical local setup/application state. */

import type { LocalApplicationNextAction, LocalApplicationSetupStep } from "./local-application-state.js";

const COMPLETED_MARKER = "✔"; // ✔
const CURRENT_MARKER = "●"; // ●
const PENDING_MARKER = "○"; // ○
const FLOW_CONNECTOR = "│"; // │

export interface LocalApplicationSetupFlowInput {
  readonly steps: readonly LocalApplicationSetupStep[];
  readonly nextAction: LocalApplicationNextAction;
}

/**
 * Marker vocabulary is derived only from fields already present on the
 * canonical step and next-action projection (`status`, `id`, `nextAction.stepId`);
 * it adds no independent setup/lifecycle inference.
 */
function stepMarker(step: LocalApplicationSetupStep, nextAction: LocalApplicationNextAction): string {
  if (step.status === "ready") return COMPLETED_MARKER;
  if (step.status === "blocked" || step.id === nextAction.stepId) return CURRENT_MARKER;
  return PENDING_MARKER;
}

/**
 * Render the canonical ordered setup steps as a compact vertical flow for
 * non-interactive terminal output (plain text and Unicode markers only; no
 * ANSI control sequences or TTY assumptions).
 */
export function renderLocalApplicationSetupFlow(state: LocalApplicationSetupFlowInput): readonly string[] {
  const lines: string[] = [];
  state.steps.forEach((step, index) => {
    const diagnostic = step.diagnostic === undefined ? "" : ` (${step.diagnostic})`;
    lines.push(`${stepMarker(step, state.nextAction)} ${step.title}${diagnostic}`);
    const isLast = index === state.steps.length - 1;
    lines.push(`${isLast ? " " : FLOW_CONNECTOR}  ${step.syntax}`);
  });
  return lines;
}
