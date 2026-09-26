/**
 * Owner-bound streaming secret enrollment (#1098).
 *
 * Secrets never travel as setup JSON. A frontend or upload transport hands the
 * bounded byte stream to the owning component's `SecretEnrollmentPort`, which
 * alone parses, validates and stores it, and returns a secret-free public
 * receipt. The port must be usable before normal Executor/Admission readiness:
 * enrollment is how an unconfigured owner becomes configurable, so an
 * implementation must not require health, provider binding or trust first.
 */
import type { RepositoryIdentity } from "../github/effect-authorizer.js";
import type { RuntimeComponent } from "./components.js";
import { invalid } from "./errors.js";
import { assertSecretFreeSetupJson } from "./secret-material.js";
import {
  SETUP_CONTRACT_VERSION,
  requireMembers,
  validateOperationId,
  validateRepositoryIdentity,
  validateSetupDiagnostics,
  validateText,
  type SetupDiagnostic,
} from "./setup-primitives.js";

export const SECRET_ENROLLMENT_KINDS = Object.freeze(["executor-issuer-private-key"] as const);
export type SecretEnrollmentKind = (typeof SECRET_ENROLLMENT_KINDS)[number];

/** The only component that may receive each enrollment kind. */
export const SECRET_ENROLLMENT_OWNERS: Readonly<Record<SecretEnrollmentKind, RuntimeComponent>> = Object.freeze({
  "executor-issuer-private-key": "executor",
});

/** Upper bound of one enrolled secret; matches the existing Issuer key file bound. */
export const MAX_SECRET_ENROLLMENT_BYTES = 64 * 1024;

export interface SecretEnrollmentRequest {
  readonly version: typeof SETUP_CONTRACT_VERSION;
  readonly kind: SecretEnrollmentKind;
  /** Setup operation identity, reused for duplicate/unknown-outcome reconciliation. */
  readonly operationId: string;
  readonly repository: RepositoryIdentity;
  /** Byte length announced by the transport; the stream must not exceed it. */
  readonly declaredBytes: number;
  /**
   * Already validated, secret-free, non-enrollment inputs of the same setup
   * action and generation (for example the Issuer App ID an owner needs
   * before it can authorize custody). Never carries secret bytes, file
   * content or file paths; absent for callers without such inputs.
   */
  readonly inputs?: Readonly<Record<string, string | boolean>>;
}

/** Bound of the secret-free action inputs carried beside an enrollment. */
export const MAX_SECRET_ENROLLMENT_INPUTS = 16;

export const SECRET_ENROLLMENT_OUTCOMES = Object.freeze(["enrolled", "rejected"] as const);
export type SecretEnrollmentOutcome = (typeof SECRET_ENROLLMENT_OUTCOMES)[number];

/** Public, secret-free result of an enrollment. */
export interface SecretEnrollmentReceipt {
  readonly version: typeof SETUP_CONTRACT_VERSION;
  readonly kind: SecretEnrollmentKind;
  readonly operationId: string;
  readonly repository: RepositoryIdentity;
  readonly outcome: SecretEnrollmentOutcome;
  /** `sha256:<hex>` fingerprint of the public half, present when enrolled. */
  readonly publicFingerprint?: string;
  readonly diagnostics: readonly SetupDiagnostic[];
}

export interface SecretEnrollmentPort {
  readonly owner: RuntimeComponent;
  readonly kinds: readonly SecretEnrollmentKind[];
  /**
   * Consumes at most `request.declaredBytes` (never more than
   * `MAX_SECRET_ENROLLMENT_BYTES`) from `secret`. The bytes are owned by the
   * implementation from the first chunk; callers must not retain them.
   */
  enroll(
    request: SecretEnrollmentRequest,
    secret: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<SecretEnrollmentReceipt>;
}

const FINGERPRINT = /^sha256:[0-9a-f]{64}$/u;

function validateInputs(value: unknown, path: string): Readonly<Record<string, string | boolean>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid(path, "must be an object.");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_SECRET_ENROLLMENT_INPUTS) {
    throw invalid(path, `must have at most ${MAX_SECRET_ENROLLMENT_INPUTS} values.`);
  }
  const inputs: Record<string, string | boolean> = {};
  for (const [id, item] of entries) {
    validateOperationId(id, `${path}.${id}`);
    inputs[id] = typeof item === "boolean" ? item : validateText(item, `${path}.${id}`);
  }
  return Object.freeze(inputs);
}

function validateKind(value: unknown, path: string): SecretEnrollmentKind {
  if (!SECRET_ENROLLMENT_KINDS.includes(value as SecretEnrollmentKind))
    throw invalid(path, "is not an enrollment kind.");
  return value as SecretEnrollmentKind;
}

export function validateSecretEnrollmentRequest(input: unknown): SecretEnrollmentRequest {
  assertSecretFreeSetupJson(input);
  const record = requireMembers(input, "$", [
    "version",
    "kind",
    "operationId",
    "repository",
    "declaredBytes",
    "inputs",
  ]);
  if (record.version !== SETUP_CONTRACT_VERSION) throw invalid("$.version", "is unsupported.");
  const declaredBytes = record.declaredBytes;
  if (
    typeof declaredBytes !== "number" ||
    !Number.isSafeInteger(declaredBytes) ||
    declaredBytes < 1 ||
    declaredBytes > MAX_SECRET_ENROLLMENT_BYTES
  ) {
    throw invalid("$.declaredBytes", `must be an integer between 1 and ${MAX_SECRET_ENROLLMENT_BYTES}.`);
  }
  return Object.freeze({
    version: SETUP_CONTRACT_VERSION,
    kind: validateKind(record.kind, "$.kind"),
    operationId: validateOperationId(record.operationId, "$.operationId"),
    repository: validateRepositoryIdentity(record.repository, "$.repository"),
    declaredBytes,
    ...(record.inputs === undefined ? {} : { inputs: validateInputs(record.inputs, "$.inputs") }),
  });
}

export function validateSecretEnrollmentReceipt(input: unknown, path = "$"): SecretEnrollmentReceipt {
  assertSecretFreeSetupJson(input, path);
  const record = requireMembers(input, path, [
    "version",
    "kind",
    "operationId",
    "repository",
    "outcome",
    "publicFingerprint",
    "diagnostics",
  ]);
  if (record.version !== SETUP_CONTRACT_VERSION) throw invalid(`${path}.version`, "is unsupported.");
  const outcome = record.outcome;
  if (!SECRET_ENROLLMENT_OUTCOMES.includes(outcome as SecretEnrollmentOutcome)) {
    throw invalid(`${path}.outcome`, "is not an enrollment outcome.");
  }
  const fingerprint = record.publicFingerprint;
  if (
    outcome === "enrolled"
      ? typeof fingerprint !== "string" || !FINGERPRINT.test(fingerprint)
      : fingerprint !== undefined
  ) {
    throw invalid(`${path}.publicFingerprint`, "must be a sha256 public fingerprint exactly when enrolled.");
  }
  return Object.freeze({
    version: SETUP_CONTRACT_VERSION,
    kind: validateKind(record.kind, `${path}.kind`),
    operationId: validateOperationId(record.operationId, `${path}.operationId`),
    repository: validateRepositoryIdentity(record.repository, `${path}.repository`),
    outcome: outcome as SecretEnrollmentOutcome,
    ...(fingerprint === undefined ? {} : { publicFingerprint: fingerprint as string }),
    diagnostics: validateSetupDiagnostics(record.diagnostics, `${path}.diagnostics`),
  });
}
