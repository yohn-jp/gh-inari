/**
 * Bounded Local Runtime failure diagnostic (#1180).
 *
 * The Executor, Admission and CLI owners pass this value across their
 * existing wire envelopes so an operator can tell which owner stage failed and
 * which repairable class applies, without any owner exposing raw provider
 * bodies, exception messages, stacks, keys, tokens or signatures. Only reason
 * codes named in the fixed catalog below cross a boundary; every message is the
 * catalog's fixed text. An unknown failure is projected to a generic reason.
 */

export const RUNTIME_FAILURE_STAGES = Object.freeze([
  "repository-resolution",
  "trust-evidence",
  "session-registration",
  "implementation-admission",
  "provider-execution",
] as const);
export type RuntimeFailureStage = (typeof RUNTIME_FAILURE_STAGES)[number];

export const RUNTIME_FAILURE_CATEGORIES = Object.freeze([
  "configuration",
  "binding-mismatch",
  "trust",
  "session",
  "denied",
  "unavailable",
  "internal",
] as const);
export type RuntimeFailureCategory = (typeof RUNTIME_FAILURE_CATEGORIES)[number];

interface RuntimeFailureReasonEntry {
  readonly category: RuntimeFailureCategory;
  readonly message: string;
}

function reason(category: RuntimeFailureCategory, message: string): RuntimeFailureReasonEntry {
  return Object.freeze({ category, message });
}

/** Fixed catalog of owner reason codes that may cross a Runtime boundary. */
export const RUNTIME_FAILURE_REASONS = Object.freeze({
  // Executor Issuer configuration and repository binding.
  EXECUTOR_PROVIDER_CONFIGURATION_MISSING: reason("configuration", "The Executor Issuer App ID is not configured."),
  EXECUTOR_ISSUER_KEY_MISSING: reason("configuration", "The Executor Issuer App private key is not configured."),
  EXECUTOR_ISSUER_KEY_INVALID: reason("configuration", "The Executor Issuer App private key is not usable."),
  EXECUTOR_ISSUER_CUSTODY_UNVERIFIED: reason(
    "configuration",
    "The managed Executor Issuer key is not verified for an App installation yet.",
  ),
  EXECUTOR_ISSUER_CUSTODY_UNAVAILABLE: reason("configuration", "The Executor Issuer custody could not be read."),
  EXECUTOR_ISSUER_BINDING_CONFLICT: reason(
    "configuration",
    "An explicit Issuer override contradicts the managed Executor Issuer custody.",
  ),
  EXECUTOR_REPOSITORY_BINDING_MISSING: reason(
    "configuration",
    "No setup binding connects this repository to an Issuer App installation.",
  ),
  EXECUTOR_REPOSITORY_BINDING_UNAVAILABLE: reason(
    "unavailable",
    "The repository setup binding could not be read by the Executor.",
  ),
  EXECUTOR_REPOSITORY_BINDING_INCONSISTENT: reason(
    "binding-mismatch",
    "The repository setup binding and the Executor Runtime profile disagree.",
  ),
  EXECUTOR_ISSUER_BINDING_MISMATCH: reason(
    "binding-mismatch",
    "The Issuer App, installation or repository does not match the repository setup binding.",
  ),
  // Issuer installation credential stages.
  GITHUB_APP_ISSUER_CONFIGURATION_INVALID: reason("configuration", "The Issuer App credential input is invalid."),
  GITHUB_APP_INSTALLATION_TOKEN_FAILED: reason(
    "binding-mismatch",
    "GitHub refused an Issuer installation token for the bound App and installation.",
  ),
  GITHUB_APP_INSTALLATION_SCOPE_MISMATCH: reason(
    "binding-mismatch",
    "The Issuer installation does not grant the bound repository or required permissions.",
  ),
  GITHUB_APP_PROVIDER_UNAVAILABLE: reason("unavailable", "GitHub could not be reached with the Issuer credential."),
  // Repository protected-ref Runtime Authority trust.
  RUNTIME_AUTHORITY_NOT_FOUND: reason(
    "trust",
    "The Runtime Authority is not registered on the repository protected ref.",
  ),
  RUNTIME_AUTHORITY_INACTIVE: reason(
    "trust",
    "The Runtime Authority on the repository protected ref is inactive or outside its validity window.",
  ),
  RUNTIME_AUTHORITY_AMBIGUOUS: reason("trust", "The repository protected ref has ambiguous Runtime Authority records."),
  RUNTIME_AUTHORITY_SOURCE_INVALID: reason(
    "trust",
    "The repository protected-ref Runtime Authority records are invalid.",
  ),
  RUNTIME_AUTHORITY_SOURCE_UNAVAILABLE: reason(
    "unavailable",
    "The repository protected-ref Runtime Authority records could not be read.",
  ),
  RUNTIME_AUTHORITY_REPOSITORY_ID_UNAVAILABLE: reason("unavailable", "The repository identity could not be read."),
  ADMISSION_RUNTIME_AUTHORITY_MISMATCH: reason(
    "trust",
    "The protected-ref Runtime Authority does not match the Authority pinned by Admission.",
  ),
  ADMISSION_REPOSITORY_MISMATCH: reason("denied", "Executor repository evidence does not match the Session."),
  ADMISSION_EVIDENCE_MALFORMED: reason("internal", "Executor evidence did not match the Admission contract."),
  // Session binding registration and lifecycle.
  ADMISSION_SESSION_BINDING_INVALID: reason("session", "The Session binding is invalid."),
  ADMISSION_SESSION_STORE_EXPIRED: reason("session", "The Session binding has expired."),
  ADMISSION_SESSION_STORE_CLOSED: reason("session", "The Session binding is closed."),
  ADMISSION_SESSION_STORE_CONFLICT: reason("session", "The Session id is already bound to different claims."),
  ADMISSION_SESSION_STORE_NOT_FOUND: reason("session", "The Session is not registered with Admission."),
  ADMISSION_SESSION_STORE_TRUST_MISMATCH: reason("trust", "The Session was admitted under different Authority trust."),
  ADMISSION_SESSION_STORE_INVALID_BINDING: reason("session", "The Session binding is invalid."),
  ADMISSION_SESSION_STORE_INVALID_SESSION_ID: reason("session", "The Session id is invalid."),
  ADMISSION_SESSION_STORE_INVALID_RECORD: reason("internal", "The Admission Session record is unreadable."),
  ADMISSION_SESSION_STORE_STORAGE_FAILED: reason("unavailable", "Admission Session storage is unavailable."),
  ADMISSION_SESSION_UNAVAILABLE: reason("session", "The Session is not active."),
  ADMISSION_BRANCH_OBSERVATION_MISSING: reason(
    "unavailable",
    "Admission has no current repository branch-policy observation for this Session.",
  ),
  ADMISSION_BRANCH_OBSERVATION_STALE: reason(
    "session",
    "The current repository branch-policy observation is invalid or stale.",
  ),
  ADMISSION_BRANCH_OBSERVATION_CONTRADICTED: reason(
    "session",
    "The current repository branch-policy observation contradicts the Session binding.",
  ),
  // Governed Implementation and repository branch policy (#1179).
  EXECUTOR_IMPLEMENTATION_CONTRACT_REQUIRED: reason(
    "denied",
    "The selected Issue is not a governed Implementation contract; a Source Issue or branch name is not an execution contract.",
  ),
  EXECUTOR_IMPLEMENTATION_REPOSITORY_MISMATCH: reason(
    "denied",
    "The Implementation contract names a different repository.",
  ),
  EXECUTOR_BRANCH_POLICY_UNAVAILABLE: reason(
    "unavailable",
    "The repository branch policy could not be acquired from the default branch.",
  ),
  // Implementation admission and capability authorization.
  ADMISSION_TASK_MISMATCH: reason("denied", "The operation repository or task does not match the Session."),
  ADMISSION_IMPLEMENTATION_UNAUTHORIZED: reason("denied", "The current Implementation is not authorized."),
  ADMISSION_IMPLEMENTATION_SCOPE_UNAVAILABLE: reason("denied", "The current Implementation scope is unavailable."),
  ADMISSION_CAPABILITY_DENIED: reason("denied", "The Session capability does not authorize this operation."),
  ADMISSION_BRANCH_SCOPE_DENIED: reason("denied", "The branch operation is outside the authorized Session scope."),
  // Executor wire from Admission.
  EXECUTOR_UNAVAILABLE: reason("unavailable", "The configured Executor is unavailable."),
  EXECUTOR_IDENTITY_MISMATCH: reason(
    "binding-mismatch",
    "The Executor endpoint identity does not match the Admission configuration.",
  ),
  EXECUTOR_PROTOCOL_INVALID: reason("internal", "The Executor response did not match the wire protocol."),
  // Provider execution.
  EXECUTOR_EXECUTION_FAILED: reason("unavailable", "The Executor could not complete the authorized provider effect."),
  // Generic fallbacks.
  RUNTIME_OWNER_UNAVAILABLE: reason("unavailable", "The Runtime owner is unavailable."),
  RUNTIME_INTERNAL_FAILURE: reason("internal", "The Runtime owner failed internally."),
} satisfies Record<string, RuntimeFailureReasonEntry>);
export type RuntimeFailureReason = keyof typeof RUNTIME_FAILURE_REASONS;

export interface RuntimeFailure {
  readonly stage: RuntimeFailureStage;
  readonly reason: RuntimeFailureReason;
  readonly category: RuntimeFailureCategory;
  readonly message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRuntimeFailureReason(value: unknown): value is RuntimeFailureReason {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(RUNTIME_FAILURE_REASONS, value);
}

export function isRuntimeFailureStage(value: unknown): value is RuntimeFailureStage {
  return RUNTIME_FAILURE_STAGES.includes(value as RuntimeFailureStage);
}

export function runtimeFailure(stage: RuntimeFailureStage, code: RuntimeFailureReason): RuntimeFailure {
  const entry = RUNTIME_FAILURE_REASONS[code];
  return Object.freeze({ stage, reason: code, category: entry.category, message: entry.message });
}

const CREDENTIAL_STAGE_REASONS: Readonly<Record<string, RuntimeFailureReason>> = Object.freeze({
  "issuer-configuration": "GITHUB_APP_ISSUER_CONFIGURATION_INVALID",
  "installation-token": "GITHUB_APP_INSTALLATION_TOKEN_FAILED",
  "installation-scope": "GITHUB_APP_INSTALLATION_SCOPE_MISMATCH",
  "repository-read": "GITHUB_APP_PROVIDER_UNAVAILABLE",
  "projection-execution": "GITHUB_APP_PROVIDER_UNAVAILABLE",
});

/**
 * Project an owner failure to the bounded diagnostic. A value that already
 * carries a validated `runtimeFailure` (forwarded from a downstream owner)
 * keeps that owner's stage and reason. Otherwise only the error `code` (and
 * the Issuer credential broker `stage`) is read; the message, cause, details
 * and any provider data are never consulted.
 */
export function runtimeFailureFromError(
  error: unknown,
  stage: RuntimeFailureStage,
  fallback: RuntimeFailureReason = "RUNTIME_INTERNAL_FAILURE",
): RuntimeFailure {
  if (isRecord(error)) {
    const forwarded = validateRuntimeFailure(error.runtimeFailure);
    if (forwarded !== undefined) return forwarded;
    if (error.code === "GITHUB_APP_CREDENTIAL_BROKER_FAILED" && typeof error.stage === "string") {
      const mapped = CREDENTIAL_STAGE_REASONS[error.stage];
      if (mapped !== undefined) return runtimeFailure(stage, mapped);
    }
    if (isRuntimeFailureReason(error.code)) return runtimeFailure(stage, error.code);
  }
  return runtimeFailure(stage, fallback);
}

/** Validate a wire value; anything outside the catalog is rejected. */
export function validateRuntimeFailure(value: unknown): RuntimeFailure | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !["stage", "reason", "category", "message"].includes(key)) ||
    !isRuntimeFailureStage(value.stage) ||
    !isRuntimeFailureReason(value.reason)
  )
    return undefined;
  const expected = runtimeFailure(value.stage, value.reason);
  if (value.category !== expected.category || value.message !== expected.message) return undefined;
  return expected;
}

/** HTTP status an owner uses for a bounded failure. */
export function runtimeFailureHttpStatus(failure: RuntimeFailure): number {
  switch (failure.category) {
    case "denied":
    case "session":
    case "trust":
      return 403;
    case "configuration":
    case "binding-mismatch":
      return 409;
    case "unavailable":
      return 503;
    case "internal":
      return 500;
  }
}
