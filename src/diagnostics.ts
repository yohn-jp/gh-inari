/**
 * Versioned, bounded diagnostics shared by artifact convergence operations.
 *
 * This module is a data contract only. Command adapters may project their
 * local failures into it, but the contract deliberately does not own command
 * behavior or template semantics.
 */

export const ARTIFACT_DIAGNOSTIC_VERSION = 1 as const;

export type ArtifactDiagnosticVersion = typeof ARTIFACT_DIAGNOSTIC_VERSION;

export type ArtifactDiagnosticState =
  "accepted" | "missing" | "invalid" | "conflicting" | "unsupported" | "unrecoverable";

/** Stable reason discriminants shared by all convergence command adapters. */
export type ArtifactDiagnosticCode =
  | "FIELD_ACCEPTED"
  | "FIELD_MISSING"
  | "FIELD_INVALID"
  | "FIELD_CONFLICT"
  | "FIELD_UNSUPPORTED"
  | "ARTIFACT_UNRECOVERABLE";

export type ArtifactDiagnosticRecoveryAction =
  "provide" | "replace" | "resolve-conflict" | "select-template" | "repair" | "retry";

export interface ArtifactDiagnosticRecovery {
  readonly action: ArtifactDiagnosticRecoveryAction;
  /** Field identity or JSON path, when the action is field-local. */
  readonly path?: string;
  /** Bounded human-readable projection of the deterministic next step. */
  readonly hint?: string;
}

export interface ArtifactDiagnosticInput {
  readonly state: ArtifactDiagnosticState;
  readonly code: ArtifactDiagnosticCode;
  /** Field identity or JSON path. Keep this field-local where possible. */
  readonly path?: string;
  /** Human-readable projection; state and code remain authoritative. */
  readonly message: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly recovery?: readonly ArtifactDiagnosticRecoveryInput[];
}

export interface ArtifactDiagnosticRecoveryInput {
  readonly action: ArtifactDiagnosticRecoveryAction;
  readonly path?: string;
  readonly hint?: string;
}

export interface ArtifactDiagnostic {
  readonly version: ArtifactDiagnosticVersion;
  readonly state: ArtifactDiagnosticState;
  readonly code: ArtifactDiagnosticCode;
  readonly path?: string;
  readonly message: string;
  readonly expected?: BoundedDiagnosticValue;
  readonly actual?: BoundedDiagnosticValue;
  readonly recovery?: readonly ArtifactDiagnosticRecovery[];
}

/**
 * A recursively bounded value suitable for expected/actual evidence.
 * Truncation is explicit so consumers never mistake evidence for a complete
 * artifact or complete field payload.
 */
export type BoundedDiagnosticValue =
  | null
  | boolean
  | number
  | string
  | readonly BoundedDiagnosticValue[]
  | { readonly [key: string]: BoundedDiagnosticValue };

export interface ArtifactDiagnosticReport {
  readonly version: ArtifactDiagnosticVersion;
  readonly diagnostics: readonly ArtifactDiagnostic[];
  /** Explicitly accepted field identities retained for partial convergence. */
  readonly acceptedFields: readonly string[];
}

export const MAX_ARTIFACT_DIAGNOSTICS = 32 as const;
export const MAX_ACCEPTED_FIELDS = 128 as const;
export const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 240 as const;
export const MAX_DIAGNOSTIC_PATH_LENGTH = 160 as const;
export const MAX_RECOVERY_ACTIONS = 4 as const;
export const MAX_RECOVERY_HINT_LENGTH = 240 as const;
export const MAX_EVIDENCE_DEPTH = 3 as const;
export const MAX_EVIDENCE_ITEMS = 8 as const;
export const MAX_EVIDENCE_KEYS = 12 as const;
export const MAX_EVIDENCE_STRING_LENGTH = 240 as const;

const SENSITIVE_KEY = /(?:^|[_-])(api[-_]?key|authorization|cookie|credential|password|secret|token)(?:$|[_-])/i;
const PRIVATE_ARTIFACT_KEY = /^(?:artifact|body|document|fields|metadata|payload)$/i;
const REPORT_KEYS = new Set(["version", "diagnostics", "acceptedFields"]);
const DIAGNOSTIC_KEYS = new Set(["version", "state", "code", "path", "message", "expected", "actual", "recovery"]);
const RECOVERY_KEYS = new Set(["action", "path", "hint"]);

const CODE_STATE: Readonly<Record<ArtifactDiagnosticCode, ArtifactDiagnosticState>> = {
  FIELD_ACCEPTED: "accepted",
  FIELD_MISSING: "missing",
  FIELD_INVALID: "invalid",
  FIELD_CONFLICT: "conflicting",
  FIELD_UNSUPPORTED: "unsupported",
  ARTIFACT_UNRECOVERABLE: "unrecoverable",
};

/**
 * Create one contract-valid diagnostic and sanitize all evidence at the
 * boundary. Sanitization is intentionally lossy: diagnostics must never be a
 * transport for a complete artifact, secret, or unbounded parser payload.
 */
export function createArtifactDiagnostic(input: ArtifactDiagnosticInput): ArtifactDiagnostic {
  assertStateCode(input.state, input.code);
  const diagnostic: ArtifactDiagnostic = {
    version: ARTIFACT_DIAGNOSTIC_VERSION,
    state: input.state,
    code: input.code,
    ...(input.path === undefined ? {} : { path: boundedText(input.path, MAX_DIAGNOSTIC_PATH_LENGTH) }),
    message: boundedText(input.message, MAX_DIAGNOSTIC_MESSAGE_LENGTH),
    ...(input.expected === undefined ? {} : { expected: sanitizeEvidence(input.expected) }),
    ...(input.actual === undefined ? {} : { actual: sanitizeEvidence(input.actual) }),
    ...(input.recovery === undefined ? {} : { recovery: normalizeRecovery(input.recovery) }),
  };
  return diagnostic;
}

/** Create a stable report, sorting field identities and diagnostics by contract keys. */
export function createArtifactDiagnosticReport(
  diagnostics: readonly ArtifactDiagnostic[],
  acceptedFields: readonly string[] = [],
): ArtifactDiagnosticReport {
  if (diagnostics.length > MAX_ARTIFACT_DIAGNOSTICS) {
    throw new RangeError(`At most ${MAX_ARTIFACT_DIAGNOSTICS} diagnostics are supported.`);
  }
  if (acceptedFields.length > MAX_ACCEPTED_FIELDS) {
    throw new RangeError(`At most ${MAX_ACCEPTED_FIELDS} accepted fields are supported.`);
  }
  const normalized = diagnostics.map(canonicalizeDiagnostic).sort(compareDiagnostics);
  const accepted = [...new Set(acceptedFields.map((field) => boundedText(field, MAX_DIAGNOSTIC_PATH_LENGTH)))].sort();
  return {
    version: ARTIFACT_DIAGNOSTIC_VERSION,
    diagnostics: normalized,
    acceptedFields: accepted,
  };
}

/** Serialize a report with stable key ordering and stable diagnostic ordering. */
export function serializeArtifactDiagnosticReport(report: ArtifactDiagnosticReport): string {
  if (report.version !== ARTIFACT_DIAGNOSTIC_VERSION) {
    throw new TypeError("Artifact diagnostics report has an unsupported version.");
  }
  return JSON.stringify(createArtifactDiagnosticReport(report.diagnostics, report.acceptedFields));
}

/** Project the machine contract into bounded human-readable text. */
export function formatArtifactDiagnostic(diagnostic: ArtifactDiagnostic): string {
  const normalized = canonicalizeDiagnostic(diagnostic);
  const location = normalized.path === undefined ? "artifact" : normalized.path;
  const recovery = normalized.recovery?.find((action) => action.hint !== undefined)?.hint;
  return recovery === undefined
    ? `[${normalized.code}] ${location}: ${normalized.message}`
    : `[${normalized.code}] ${location}: ${normalized.message} Next: ${recovery}`;
}

/** Project all report diagnostics without introducing a command-specific shape. */
export function formatArtifactDiagnosticReport(report: ArtifactDiagnosticReport): string {
  const normalized = createArtifactDiagnosticReport(report.diagnostics, report.acceptedFields);
  const lines = normalized.diagnostics.map(formatArtifactDiagnostic);
  if (normalized.acceptedFields.length > 0) lines.push(`Accepted fields: ${normalized.acceptedFields.join(", ")}.`);
  return lines.join("\n");
}

/** Parse and validate a serialized report at an untrusted boundary. */
export function deserializeArtifactDiagnosticReport(serialized: string): ArtifactDiagnosticReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new TypeError(
      `Artifact diagnostics must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) throw new TypeError("Artifact diagnostics must be a JSON object.");
  if (Object.keys(parsed).some((key) => !REPORT_KEYS.has(key))) {
    throw new TypeError("Artifact diagnostics contain an unknown property.");
  }
  if (parsed.version !== ARTIFACT_DIAGNOSTIC_VERSION) {
    throw new TypeError(`Unsupported artifact diagnostics version: ${String(parsed.version)}.`);
  }
  if (!Array.isArray(parsed.diagnostics) || !parsed.diagnostics.every(isDiagnostic)) {
    throw new TypeError("Artifact diagnostics must contain a valid diagnostics array.");
  }
  if (!Array.isArray(parsed.acceptedFields) || !parsed.acceptedFields.every((field) => typeof field === "string")) {
    throw new TypeError("Artifact diagnostics must contain an acceptedFields string array.");
  }
  return createArtifactDiagnosticReport(parsed.diagnostics, parsed.acceptedFields);
}

function assertStateCode(state: ArtifactDiagnosticState, code: ArtifactDiagnosticCode): void {
  if (CODE_STATE[code] !== state) {
    throw new TypeError(`Diagnostic code ${code} is incompatible with state ${state}.`);
  }
}

function assertDiagnostic(diagnostic: ArtifactDiagnostic): ArtifactDiagnostic {
  if (diagnostic.version !== ARTIFACT_DIAGNOSTIC_VERSION) {
    throw new TypeError("Artifact diagnostic has an unsupported version.");
  }
  assertStateCode(diagnostic.state, diagnostic.code);
  if (diagnostic.message.length > MAX_DIAGNOSTIC_MESSAGE_LENGTH) {
    throw new RangeError("Artifact diagnostic message exceeds its bound.");
  }
  if (diagnostic.path !== undefined && diagnostic.path.length > MAX_DIAGNOSTIC_PATH_LENGTH) {
    throw new RangeError("Artifact diagnostic path exceeds its bound.");
  }
  if (diagnostic.recovery !== undefined && diagnostic.recovery.length > MAX_RECOVERY_ACTIONS) {
    throw new RangeError("Artifact diagnostic recovery actions exceed their bound.");
  }
  return diagnostic;
}

function canonicalizeDiagnostic(diagnostic: ArtifactDiagnostic): ArtifactDiagnostic {
  assertDiagnostic(diagnostic);
  return {
    version: ARTIFACT_DIAGNOSTIC_VERSION,
    state: diagnostic.state,
    code: diagnostic.code,
    ...(diagnostic.path === undefined ? {} : { path: boundedText(diagnostic.path, MAX_DIAGNOSTIC_PATH_LENGTH) }),
    message: boundedText(diagnostic.message, MAX_DIAGNOSTIC_MESSAGE_LENGTH),
    ...(diagnostic.expected === undefined ? {} : { expected: sanitizeEvidence(diagnostic.expected) }),
    ...(diagnostic.actual === undefined ? {} : { actual: sanitizeEvidence(diagnostic.actual) }),
    ...(diagnostic.recovery === undefined ? {} : { recovery: normalizeRecovery(diagnostic.recovery) }),
  };
}

function normalizeRecovery(input: readonly ArtifactDiagnosticRecoveryInput[]): readonly ArtifactDiagnosticRecovery[] {
  if (input.length > MAX_RECOVERY_ACTIONS) {
    throw new RangeError(`At most ${MAX_RECOVERY_ACTIONS} recovery actions are supported.`);
  }
  return input.map((recovery) => ({
    action: assertRecoveryAction(recovery.action),
    ...(recovery.path === undefined ? {} : { path: boundedText(recovery.path, MAX_DIAGNOSTIC_PATH_LENGTH) }),
    ...(recovery.hint === undefined ? {} : { hint: boundedText(recovery.hint, MAX_RECOVERY_HINT_LENGTH) }),
  }));
}

function assertRecoveryAction(action: string): ArtifactDiagnosticRecoveryAction {
  const actions: readonly ArtifactDiagnosticRecoveryAction[] = [
    "provide",
    "replace",
    "resolve-conflict",
    "select-template",
    "repair",
    "retry",
  ];
  if (!actions.includes(action as ArtifactDiagnosticRecoveryAction)) {
    throw new TypeError(`Unsupported artifact diagnostic recovery action: ${action}.`);
  }
  return action as ArtifactDiagnosticRecoveryAction;
}

function sanitizeEvidence(value: unknown, depth = 0, key?: string): BoundedDiagnosticValue {
  if (key !== undefined && (SENSITIVE_KEY.test(key) || PRIVATE_ARTIFACT_KEY.test(key))) {
    return "[redacted]";
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return typeof value === "string" ? boundedEvidenceText(value) : value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (depth >= MAX_EVIDENCE_DEPTH) return "[truncated]";
  if (Array.isArray(value)) {
    const bounded = value.slice(0, MAX_EVIDENCE_ITEMS).map((entry) => sanitizeEvidence(entry, depth + 1));
    return value.length > MAX_EVIDENCE_ITEMS ? [...bounded, "[truncated]"] : bounded;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort().slice(0, MAX_EVIDENCE_KEYS);
    const bounded: Record<string, BoundedDiagnosticValue> = {};
    for (const entry of keys) bounded[entry] = sanitizeEvidence(value[entry], depth + 1, entry);
    if (Object.keys(value).length > MAX_EVIDENCE_KEYS) bounded._truncated = "[truncated]";
    return bounded;
  }
  return "[unsupported]";
}

function boundedEvidenceText(value: string): string {
  return value.length <= MAX_EVIDENCE_STRING_LENGTH ? value : `${value.slice(0, MAX_EVIDENCE_STRING_LENGTH)}…`;
}

function boundedText(value: string, maxLength: number): string {
  if (value.length > maxLength) throw new RangeError(`Diagnostic text exceeds its ${maxLength}-character bound.`);
  return value;
}

function compareDiagnostics(left: ArtifactDiagnostic, right: ArtifactDiagnostic): number {
  const leftKey = [left.path ?? "", left.code, left.state, left.message].join("\u0000");
  const rightKey = [right.path ?? "", right.code, right.state, right.message].join("\u0000");
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function isDiagnostic(value: unknown): value is ArtifactDiagnostic {
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) => !DIAGNOSTIC_KEYS.has(key))) return false;
  return (
    value.version === ARTIFACT_DIAGNOSTIC_VERSION &&
    typeof value.state === "string" &&
    typeof value.code === "string" &&
    CODE_STATE[value.code as ArtifactDiagnosticCode] === value.state &&
    typeof value.message === "string" &&
    (value.path === undefined || typeof value.path === "string") &&
    (value.recovery === undefined ||
      (Array.isArray(value.recovery) &&
        value.recovery.every(
          (entry) =>
            isRecord(entry) &&
            [...Object.keys(entry)].every((key) => RECOVERY_KEYS.has(key)) &&
            typeof entry.action === "string" &&
            ["provide", "replace", "resolve-conflict", "select-template", "repair", "retry"].includes(entry.action) &&
            (entry.path === undefined || typeof entry.path === "string") &&
            (entry.hint === undefined || typeof entry.hint === "string"),
        )))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
