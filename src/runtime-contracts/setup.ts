/**
 * Neutral setup observations, actions and results (#1098).
 *
 * Five setup dimensions are observed separately and never collapsed into one
 * "ready" flag: configuration, component health, provider binding, canonical
 * repository trust and task/Session readiness. Each has its own status
 * vocabulary; a status from one dimension is invalid in another.
 *
 * Actions describe prerequisites, required inputs, confirmation, freshness and
 * an optional structured command. Results are bounded outcomes, including the
 * truthful `unknown` for effects whose outcome was not observed. All of it is
 * secret-free JSON: secrets use `SecretEnrollmentPort`.
 */
import type { RuntimeComponent } from "./components.js";
import { RUNTIME_COMPONENTS } from "./components.js";
import { validateStructuredCommand, type StructuredCommand } from "./command.js";
import {
  SECRET_ENROLLMENT_KINDS,
  validateSecretEnrollmentReceipt,
  type SecretEnrollmentKind,
  type SecretEnrollmentReceipt,
} from "./enrollment.js";
import { invalid } from "./errors.js";
import { assertSecretFreeSetupJson } from "./secret-material.js";
import {
  SETUP_CONTRACT_VERSION,
  requireMembers,
  validateOperationId,
  validateSetupDiagnostics,
  validateSetupGeneration,
  validateText,
  validateTimestamp,
  type SetupDiagnostic,
  type SetupGeneration,
} from "./setup-primitives.js";

export const SETUP_DIMENSIONS = Object.freeze([
  "configuration",
  "health",
  "provider-binding",
  "repository-trust",
  "session-readiness",
] as const);

export type SetupDimension = (typeof SETUP_DIMENSIONS)[number];

export const SETUP_DIMENSION_STATUSES = Object.freeze({
  configuration: Object.freeze(["unknown", "unconfigured", "partial", "configured"] as const),
  health: Object.freeze(["unknown", "not-running", "unhealthy", "healthy"] as const),
  "provider-binding": Object.freeze(["unknown", "unbound", "mismatched", "bound"] as const),
  "repository-trust": Object.freeze(["unknown", "untrusted", "pending-human-trust", "trusted"] as const),
  "session-readiness": Object.freeze(["unknown", "not-ready", "ready"] as const),
});

export type SetupDimensionStatus<D extends SetupDimension> = (typeof SETUP_DIMENSION_STATUSES)[D][number];

/** Who observed a dimension, when, and against which owner generation. */
export interface SetupEvidence {
  readonly owner: RuntimeComponent;
  readonly observedAt: string;
  readonly generation: string;
}

export interface SetupDimensionObservation<D extends SetupDimension = SetupDimension> {
  readonly dimension: D;
  readonly status: SetupDimensionStatus<D>;
  /** Absent only when `status` is `unknown`. */
  readonly evidence?: SetupEvidence;
  readonly diagnostics: readonly SetupDiagnostic[];
}

export interface SetupObservation {
  readonly version: typeof SETUP_CONTRACT_VERSION;
  readonly generation: SetupGeneration;
  readonly observedAt: string;
  readonly configuration: SetupDimensionObservation<"configuration">;
  readonly health: SetupDimensionObservation<"health">;
  readonly providerBinding: SetupDimensionObservation<"provider-binding">;
  readonly repositoryTrust: SetupDimensionObservation<"repository-trust">;
  readonly sessionReadiness: SetupDimensionObservation<"session-readiness">;
}

/** Observation member carrying each dimension. */
export const SETUP_OBSERVATION_MEMBERS: Readonly<Record<SetupDimension, keyof SetupObservation>> = Object.freeze({
  configuration: "configuration",
  health: "health",
  "provider-binding": "providerBinding",
  "repository-trust": "repositoryTrust",
  "session-readiness": "sessionReadiness",
});

export const SETUP_INPUT_KINDS = Object.freeze(["text", "choice", "confirmation", "enrollment"] as const);
export type SetupInputKind = (typeof SETUP_INPUT_KINDS)[number];

/**
 * One input an action needs. `enrollment` inputs are satisfied only through
 * the named owner enrollment port and never appear in `SetupActionRequest`.
 */
export interface SetupInputRequirement {
  readonly id: string;
  readonly kind: SetupInputKind;
  readonly label: string;
  readonly required: boolean;
  readonly choices?: readonly string[];
  readonly enrollment?: SecretEnrollmentKind;
}

/** The action is allowed only while `dimension` has one of `statuses`. */
export interface SetupPrerequisite {
  readonly dimension: SetupDimension;
  readonly statuses: readonly string[];
}

export interface SetupAction {
  readonly version: typeof SETUP_CONTRACT_VERSION;
  /** Operation identity, stable across retries of the same intent. */
  readonly id: string;
  /** Owner-defined action kind, e.g. `executor.configure-app-id`. */
  readonly kind: string;
  readonly owner: RuntimeComponent;
  readonly title: string;
  readonly prerequisites: readonly SetupPrerequisite[];
  readonly inputs: readonly SetupInputRequirement[];
  readonly confirmation: { readonly required: boolean; readonly summary: string };
  readonly freshness: { readonly generation: SetupGeneration; readonly notAfter: string };
  readonly command?: StructuredCommand;
}

export interface SetupActionRequest {
  readonly version: typeof SETUP_CONTRACT_VERSION;
  readonly actionId: string;
  readonly generation: SetupGeneration;
  readonly confirmed: boolean;
  readonly inputs: Readonly<Record<string, string | boolean>>;
}

export const SETUP_ACTION_OUTCOMES = Object.freeze([
  "succeeded",
  "failed",
  "cancelled",
  "stale",
  "action-required",
  "unknown",
] as const);

export type SetupActionOutcome = (typeof SETUP_ACTION_OUTCOMES)[number];

export interface SetupActionResult {
  readonly version: typeof SETUP_CONTRACT_VERSION;
  readonly actionId: string;
  readonly generation: SetupGeneration;
  readonly outcome: SetupActionOutcome;
  readonly diagnostics: readonly SetupDiagnostic[];
  readonly receipt?: SecretEnrollmentReceipt;
}

export const MAX_SETUP_JOURNAL_ENTRIES = 64;
export const SETUP_JOURNAL_PHASES = Object.freeze(["requested", "confirmed", "completed"] as const);
export type SetupJournalPhase = (typeof SETUP_JOURNAL_PHASES)[number];

/** One secret-free journal record of an action attempt, used for reconciliation. */
export interface SetupJournalEntry {
  readonly version: typeof SETUP_CONTRACT_VERSION;
  readonly actionId: string;
  readonly owner: RuntimeComponent;
  readonly generation: SetupGeneration;
  readonly phase: SetupJournalPhase;
  /** Present exactly for `completed`. */
  readonly outcome?: SetupActionOutcome;
  readonly recordedAt: string;
  readonly diagnostics: readonly SetupDiagnostic[];
}

const MAX_SETUP_ITEMS = 16;
const ACTION_KIND = /^[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9-]{0,63}$/u;

function validateVersion(value: unknown, path: string): typeof SETUP_CONTRACT_VERSION {
  if (value !== SETUP_CONTRACT_VERSION) throw invalid(path, "is unsupported.");
  return SETUP_CONTRACT_VERSION;
}

function validateComponent(value: unknown, path: string): RuntimeComponent {
  if (!RUNTIME_COMPONENTS.includes(value as RuntimeComponent)) throw invalid(path, "is not a Runtime component.");
  return value as RuntimeComponent;
}

function validateBoundedArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > MAX_SETUP_ITEMS) {
    throw invalid(path, `must be an array of at most ${MAX_SETUP_ITEMS} items.`);
  }
  return value;
}

function validateDimensionObservation<D extends SetupDimension>(
  value: unknown,
  dimension: D,
  path: string,
): SetupDimensionObservation<D> {
  const record = requireMembers(value, path, ["dimension", "status", "evidence", "diagnostics"]);
  if (record.dimension !== dimension) throw invalid(`${path}.dimension`, `must be ${dimension}.`);
  const statuses: readonly string[] = SETUP_DIMENSION_STATUSES[dimension];
  if (typeof record.status !== "string" || !statuses.includes(record.status)) {
    throw invalid(`${path}.status`, `is not a ${dimension} status.`);
  }
  let evidence: SetupEvidence | undefined;
  if (record.evidence !== undefined) {
    const item = requireMembers(record.evidence, `${path}.evidence`, ["owner", "observedAt", "generation"]);
    evidence = Object.freeze({
      owner: validateComponent(item.owner, `${path}.evidence.owner`),
      observedAt: validateTimestamp(item.observedAt, `${path}.evidence.observedAt`),
      generation: validateOperationId(item.generation, `${path}.evidence.generation`),
    });
  } else if (record.status !== "unknown") {
    throw invalid(`${path}.evidence`, "is required for a known status.");
  }
  return Object.freeze({
    dimension,
    status: record.status as SetupDimensionStatus<D>,
    ...(evidence === undefined ? {} : { evidence }),
    diagnostics: validateSetupDiagnostics(record.diagnostics, `${path}.diagnostics`),
  });
}

export function validateSetupObservation(input: unknown): SetupObservation {
  assertSecretFreeSetupJson(input);
  const record = requireMembers(input, "$", [
    "version",
    "generation",
    "observedAt",
    ...Object.values(SETUP_OBSERVATION_MEMBERS),
  ]);
  return Object.freeze({
    version: validateVersion(record.version, "$.version"),
    generation: validateSetupGeneration(record.generation, "$.generation"),
    observedAt: validateTimestamp(record.observedAt, "$.observedAt"),
    configuration: validateDimensionObservation(record.configuration, "configuration", "$.configuration"),
    health: validateDimensionObservation(record.health, "health", "$.health"),
    providerBinding: validateDimensionObservation(record.providerBinding, "provider-binding", "$.providerBinding"),
    repositoryTrust: validateDimensionObservation(record.repositoryTrust, "repository-trust", "$.repositoryTrust"),
    sessionReadiness: validateDimensionObservation(record.sessionReadiness, "session-readiness", "$.sessionReadiness"),
  });
}

function validateInputRequirement(value: unknown, path: string): SetupInputRequirement {
  const record = requireMembers(value, path, ["id", "kind", "label", "required", "choices", "enrollment"]);
  const kind = record.kind as SetupInputKind;
  if (!SETUP_INPUT_KINDS.includes(kind)) throw invalid(`${path}.kind`, "is not an input kind.");
  if (typeof record.required !== "boolean") throw invalid(`${path}.required`, "must be a boolean.");
  const choices =
    record.choices === undefined
      ? undefined
      : Object.freeze(
          validateBoundedArray(record.choices, `${path}.choices`).map((choice, index) =>
            validateText(choice, `${path}.choices[${index}]`),
          ),
        );
  if ((kind === "choice") !== (choices !== undefined && choices.length > 0)) {
    throw invalid(`${path}.choices`, "must be present exactly for choice inputs.");
  }
  const enrollment = record.enrollment as SecretEnrollmentKind | undefined;
  if (
    kind === "enrollment"
      ? !SECRET_ENROLLMENT_KINDS.includes(enrollment as SecretEnrollmentKind)
      : enrollment !== undefined
  ) {
    throw invalid(`${path}.enrollment`, "must name an enrollment kind exactly for enrollment inputs.");
  }
  return Object.freeze({
    id: validateOperationId(record.id, `${path}.id`),
    kind,
    label: validateText(record.label, `${path}.label`),
    required: record.required,
    ...(choices === undefined ? {} : { choices }),
    ...(enrollment === undefined ? {} : { enrollment }),
  });
}

function validatePrerequisite(value: unknown, path: string): SetupPrerequisite {
  const record = requireMembers(value, path, ["dimension", "statuses"]);
  const dimension = record.dimension as SetupDimension;
  if (!SETUP_DIMENSIONS.includes(dimension)) throw invalid(`${path}.dimension`, "is not a setup dimension.");
  const allowed: readonly string[] = SETUP_DIMENSION_STATUSES[dimension];
  const statuses = validateBoundedArray(record.statuses, `${path}.statuses`);
  if (statuses.length === 0) throw invalid(`${path}.statuses`, "must not be empty.");
  statuses.forEach((status, index) => {
    if (typeof status !== "string" || !allowed.includes(status)) {
      throw invalid(`${path}.statuses[${index}]`, `is not a ${dimension} status.`);
    }
  });
  return Object.freeze({ dimension, statuses: Object.freeze([...(statuses as string[])]) });
}

export function validateSetupAction(input: unknown): SetupAction {
  assertSecretFreeSetupJson(input);
  const record = requireMembers(input, "$", [
    "version",
    "id",
    "kind",
    "owner",
    "title",
    "prerequisites",
    "inputs",
    "confirmation",
    "freshness",
    "command",
  ]);
  if (typeof record.kind !== "string" || !ACTION_KIND.test(record.kind)) {
    throw invalid("$.kind", "must be <component>.<action>.");
  }
  const inputs = validateBoundedArray(record.inputs, "$.inputs").map((item, index) =>
    validateInputRequirement(item, `$.inputs[${index}]`),
  );
  if (new Set(inputs.map((item) => item.id)).size !== inputs.length) throw invalid("$.inputs", "has duplicate IDs.");
  const confirmation = requireMembers(record.confirmation, "$.confirmation", ["required", "summary"]);
  if (typeof confirmation.required !== "boolean") throw invalid("$.confirmation.required", "must be a boolean.");
  const freshness = requireMembers(record.freshness, "$.freshness", ["generation", "notAfter"]);
  return Object.freeze({
    version: validateVersion(record.version, "$.version"),
    id: validateOperationId(record.id, "$.id"),
    kind: record.kind,
    owner: validateComponent(record.owner, "$.owner"),
    title: validateText(record.title, "$.title"),
    prerequisites: Object.freeze(
      validateBoundedArray(record.prerequisites, "$.prerequisites").map((item, index) =>
        validatePrerequisite(item, `$.prerequisites[${index}]`),
      ),
    ),
    inputs: Object.freeze(inputs),
    confirmation: Object.freeze({
      required: confirmation.required,
      summary: validateText(confirmation.summary, "$.confirmation.summary"),
    }),
    freshness: Object.freeze({
      generation: validateSetupGeneration(freshness.generation, "$.freshness.generation"),
      notAfter: validateTimestamp(freshness.notAfter, "$.freshness.notAfter"),
    }),
    ...(record.command === undefined ? {} : { command: validateStructuredCommand(record.command, "$.command") }),
  });
}

export function validateSetupActionRequest(input: unknown): SetupActionRequest {
  assertSecretFreeSetupJson(input);
  const record = requireMembers(input, "$", ["version", "actionId", "generation", "confirmed", "inputs"]);
  if (typeof record.confirmed !== "boolean") throw invalid("$.confirmed", "must be a boolean.");
  if (record.inputs === null || typeof record.inputs !== "object" || Array.isArray(record.inputs)) {
    throw invalid("$.inputs", "must be an object.");
  }
  const entries = Object.entries(record.inputs as Record<string, unknown>);
  if (entries.length > MAX_SETUP_ITEMS) throw invalid("$.inputs", `must have at most ${MAX_SETUP_ITEMS} values.`);
  const inputs: Record<string, string | boolean> = {};
  for (const [id, value] of entries) {
    validateOperationId(id, `$.inputs.${id}`);
    if (typeof value === "boolean") inputs[id] = value;
    else inputs[id] = validateText(value, `$.inputs.${id}`);
  }
  return Object.freeze({
    version: validateVersion(record.version, "$.version"),
    actionId: validateOperationId(record.actionId, "$.actionId"),
    generation: validateSetupGeneration(record.generation, "$.generation"),
    confirmed: record.confirmed,
    inputs: Object.freeze(inputs),
  });
}

export function validateSetupActionResult(input: unknown): SetupActionResult {
  assertSecretFreeSetupJson(input);
  const record = requireMembers(input, "$", ["version", "actionId", "generation", "outcome", "diagnostics", "receipt"]);
  const outcome = record.outcome as SetupActionOutcome;
  if (!SETUP_ACTION_OUTCOMES.includes(outcome)) throw invalid("$.outcome", "is not a setup action outcome.");
  return Object.freeze({
    version: validateVersion(record.version, "$.version"),
    actionId: validateOperationId(record.actionId, "$.actionId"),
    generation: validateSetupGeneration(record.generation, "$.generation"),
    outcome,
    diagnostics: validateSetupDiagnostics(record.diagnostics, "$.diagnostics"),
    ...(record.receipt === undefined ? {} : { receipt: validateSecretEnrollmentReceipt(record.receipt, "$.receipt") }),
  });
}

export function validateSetupJournalEntry(input: unknown): SetupJournalEntry {
  assertSecretFreeSetupJson(input);
  const record = requireMembers(input, "$", [
    "version",
    "actionId",
    "owner",
    "generation",
    "phase",
    "outcome",
    "recordedAt",
    "diagnostics",
  ]);
  const phase = record.phase as SetupJournalPhase;
  if (!SETUP_JOURNAL_PHASES.includes(phase)) throw invalid("$.phase", "is not a journal phase.");
  const outcome = record.outcome as SetupActionOutcome | undefined;
  if (phase === "completed" ? !SETUP_ACTION_OUTCOMES.includes(outcome as SetupActionOutcome) : outcome !== undefined) {
    throw invalid("$.outcome", "must be a setup action outcome exactly for completed entries.");
  }
  return Object.freeze({
    version: validateVersion(record.version, "$.version"),
    actionId: validateOperationId(record.actionId, "$.actionId"),
    owner: validateComponent(record.owner, "$.owner"),
    generation: validateSetupGeneration(record.generation, "$.generation"),
    phase,
    ...(outcome === undefined ? {} : { outcome }),
    recordedAt: validateTimestamp(record.recordedAt, "$.recordedAt"),
    diagnostics: validateSetupDiagnostics(record.diagnostics, "$.diagnostics"),
  });
}
