/** Terminal projection and explicit input adapter for the canonical setup Application. */
import type { SetupApplication, SetupRepository, SetupState } from "../../application/setup/index.js";
import type {
  SetupAction,
  SetupActionResult,
  SetupInputRequirement,
  StructuredCommand,
} from "../../runtime-contracts/index.js";
import { SETUP_CONTRACT_VERSION } from "../../runtime-contracts/index.js";
import { createReadStream, statSync } from "node:fs";

function quote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(value) ? value : `'${value.replace(/'/gu, "'\\''")}'`;
}

/** Format an argv vector without parsing a shell string or inventing input values. */
export function renderShellCommand(command: StructuredCommand, multiline = false): string {
  const words = [command.executable, ...command.argv].map(quote);
  return multiline ? words.join(" \\\n  ") : words.join(" ");
}

function actionFor(state: SetupState): SetupAction | undefined {
  const next = state.nextAction;
  return next.kind === "perform" ? state.actions.find((action) => action.id === next.actionId) : undefined;
}

/** Default view reports exactly the Core-selected next operation. */
export function renderSetupState(state: SetupState, detail = false): string {
  const next = state.nextAction;
  const action = actionFor(state);
  const lines = [`Setup: ${state.stage}`];
  if (next.kind === "perform") {
    lines.push(`Next: ${action?.title ?? next.step}`);
    if (action?.command !== undefined && action.inputs.every((input) => !input.required)) {
      lines.push(renderShellCommand(action.command, detail));
    }
    for (const input of action?.inputs ?? []) {
      if (input.required)
        lines.push(`Input required: ${input.label}${input.kind === "enrollment" ? " (file reference)" : ""}`);
    }
  } else if (next.kind === "complete") lines.push("Setup complete.");
  else if (next.kind === "wait") lines.push(`Next: wait for ${next.reason} (${next.step}).`);
  else if (next.kind === "refresh") lines.push(`Next: refresh observations (${next.reason}).`);
  else lines.push(`Next: blocked at ${next.step} (${next.reason}).`);
  if (detail) {
    lines.push("Steps:");
    for (const step of state.steps)
      lines.push(`  ${step.dimension}: ${step.status}${step.reason ? ` (${step.reason})` : ""}`);
    for (const dimension of state.dimensions) {
      lines.push(`  ${dimension.dimension} observation: ${dimension.status} (${dimension.freshness})`);
    }
    for (const diagnostic of state.diagnostics) lines.push(`  ${diagnostic.code}: ${diagnostic.message}`);
  }
  return lines.join("\n");
}

export function renderSetupHelp(state: SetupState): string {
  const action = actionFor(state);
  if (action === undefined) return renderSetupState(state);
  return [
    action.title,
    action.confirmation.summary,
    ...action.inputs.map(
      (input) =>
        `${input.label}: ${input.kind}${input.required ? " (required)" : ""}${input.choices ? ` [${input.choices.join(", ")}]` : ""}`,
    ),
  ].join("\n");
}

export interface SetupTerminalIO {
  readonly isTTY: boolean;
  prompt(input: SetupInputRequirement): Promise<string | undefined>;
  confirm(summary: string): Promise<boolean>;
}

export interface SetupRunOptions {
  readonly json?: boolean;
  readonly detail?: boolean;
  readonly execute?: boolean;
  readonly inputs?: Readonly<Record<string, string | boolean>>;
  readonly enrollmentFiles?: Readonly<Record<string, string>>;
  readonly io?: SetupTerminalIO;
  readonly signal?: AbortSignal;
  readonly confirmed?: boolean;
}

export type SetupRunResult =
  | { readonly kind: "state"; readonly state: SetupState; readonly output: string }
  | { readonly kind: "result"; readonly result: SetupActionResult; readonly output: string }
  | { readonly kind: "input-required" | "cancelled"; readonly state: SetupState; readonly output: string };

/** Explicit execution only. JSON and non-TTY calls never prompt. */
export async function runSetupAction(
  application: SetupApplication,
  repository: SetupRepository,
  options: SetupRunOptions = {},
): Promise<SetupRunResult> {
  const state = await application.state(repository);
  if (!options.execute)
    return {
      kind: "state",
      state,
      output: options.json ? JSON.stringify(state) : renderSetupState(state, options.detail),
    };
  const action = actionFor(state);
  if (action === undefined)
    return {
      kind: "state",
      state,
      output: options.json ? JSON.stringify(state) : renderSetupState(state, options.detail),
    };
  const inputs: Record<string, string | boolean> = { ...options.inputs };
  const enrollmentFiles: Record<string, string> = { ...options.enrollmentFiles };
  for (const input of action.inputs) {
    if (input.kind === "enrollment") {
      if (input.required && enrollmentFiles[input.id] === undefined && options.io?.isTTY && !options.json) {
        const file = await options.io.prompt(input);
        if (file === undefined)
          return {
            kind: "cancelled",
            state,
            output: options.json ? JSON.stringify({ outcome: "cancelled" }) : "Cancelled.",
          };
        enrollmentFiles[input.id] = file;
      }
      if (input.required && enrollmentFiles[input.id] === undefined)
        return {
          kind: "input-required",
          state,
          output: options.json
            ? JSON.stringify({ outcome: "input-required", state })
            : renderSetupState(state, options.detail),
        };
    } else if (input.required && inputs[input.id] === undefined) {
      if (!options.json && options.io?.isTTY) {
        const value = await options.io.prompt(input);
        if (value === undefined)
          return {
            kind: "cancelled",
            state,
            output: options.json ? JSON.stringify({ outcome: "cancelled" }) : "Cancelled.",
          };
        inputs[input.id] = input.kind === "confirmation" ? value === "yes" : value;
      } else
        return {
          kind: "input-required",
          state,
          output: options.json
            ? JSON.stringify({ outcome: "input-required", state })
            : renderSetupState(state, options.detail),
        };
    }
  }
  let confirmed = options.confirmed === true || !action.confirmation.required;
  if (action.confirmation.required && !confirmed) {
    if (options.json || !options.io?.isTTY)
      return {
        kind: "input-required",
        state,
        output: options.json
          ? JSON.stringify({ outcome: "input-required", state })
          : renderSetupState(state, options.detail),
      };
    confirmed = await options.io.confirm(action.confirmation.summary);
    if (!confirmed)
      return {
        kind: "cancelled",
        state,
        output: options.json ? JSON.stringify({ outcome: "cancelled" }) : "Cancelled.",
      };
  }
  const enrollments = Object.fromEntries(
    Object.entries(enrollmentFiles).map(([id, file]) => [
      id,
      { declaredBytes: statSync(file).size, stream: createReadStream(file) },
    ]),
  );
  const result = await application.perform(
    repository,
    { version: SETUP_CONTRACT_VERSION, actionId: action.id, generation: state.generation, confirmed, inputs },
    { signal: options.signal, enrollments },
  );
  return { kind: "result", result, output: options.json ? JSON.stringify(result) : `Setup action: ${result.outcome}` };
}
