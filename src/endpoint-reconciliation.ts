/**
 * Transport-neutral Endpoint observation reconciliation.
 *
 * Webhook input is treated as a hint only. A GitHub-owned observation becomes
 * current only after an authoritative reread supplies a revision and time.
 * This module owns no transport, persistence, or repository semantics.
 */

export const ENDPOINT_RECONCILIATION_VERSION = 1 as const;
export type EndpointReconciliationVersion = typeof ENDPOINT_RECONCILIATION_VERSION;

export const ENDPOINT_RECONCILIATION_LIMITS = Object.freeze({
  keyBytes: 512,
  hintIdBytes: 256,
  revisionBytes: 256,
  timestampBytes: 128,
  diagnostics: 16,
  diagnosticMessageBytes: 512,
  pendingHints: 64,
  seenHintIds: 256,
  maxRereadAttempts: 3,
  defaultFreshnessMs: 300_000,
} as const);

export type EndpointObservationState = "fresh" | "stale" | "unavailable" | "reconciling";
export type EndpointObservationSource = "github-authoritative";
export type EndpointRevision = string | number;

export interface EndpointObservationProvenance {
  readonly source: EndpointObservationSource;
  readonly authoritative: true;
  readonly revision: EndpointRevision;
  readonly observedAt: string;
}

export interface EndpointAuthoritativeObservation<T> {
  readonly value: T;
  readonly provenance: EndpointObservationProvenance;
}

/** A webhook event is intentionally only a bounded invalidation hint. */
export interface EndpointWebhookHint {
  readonly id: string;
  readonly revision?: EndpointRevision;
  readonly occurredAt?: string;
}

export type EndpointReconciliationDiagnosticCode =
  | "ENDPOINT_RECONCILIATION_STALE_SNAPSHOT"
  | "ENDPOINT_RECONCILIATION_REREAD_FAILED"
  | "ENDPOINT_RECONCILIATION_REREAD_EXHAUSTED";

export interface EndpointReconciliationDiagnostic {
  readonly code: EndpointReconciliationDiagnosticCode;
  readonly message: string;
}

export interface EndpointObservationRecord<T> {
  readonly version: EndpointReconciliationVersion;
  readonly key: string;
  readonly state: EndpointObservationState;
  /** Only an authoritative reread can populate this field. */
  readonly authoritative: EndpointAuthoritativeObservation<T> | null;
  /** Hints that have not yet been covered by an authoritative snapshot. */
  readonly pendingHints: readonly EndpointWebhookHint[];
  /** Bounded ids make duplicate/replayed hints idempotent. */
  readonly seenHintIds: readonly string[];
  readonly diagnostics: readonly EndpointReconciliationDiagnostic[];
}

export interface CreateEndpointObservationOptions {
  readonly key: string;
}

export interface EndpointFreshnessPolicy {
  readonly now?: string | Date;
  readonly maxAgeMs?: number;
}

export interface EndpointAuthoritativeSnapshot<T> {
  readonly value: T;
  readonly revision: EndpointRevision;
  readonly observedAt: string | Date;
}

export interface EndpointRereadRequest<T> {
  readonly key: string;
  readonly previous: EndpointAuthoritativeObservation<T> | null;
  readonly pendingHints: readonly EndpointWebhookHint[];
  readonly attempt: number;
}

export type EndpointAuthoritativeReread<T> = (
  request: EndpointRereadRequest<T>,
) => Promise<EndpointAuthoritativeSnapshot<T>> | EndpointAuthoritativeSnapshot<T>;

export interface ReconcileEndpointObservationOptions extends EndpointFreshnessPolicy {
  readonly maxAttempts?: number;
}

export class EndpointReconciliationError extends TypeError {
  readonly code: "ENDPOINT_RECONCILIATION_INVALID_INPUT" | "ENDPOINT_RECONCILIATION_INVALID_SNAPSHOT";
  readonly path: string;

  constructor(
    code: "ENDPOINT_RECONCILIATION_INVALID_INPUT" | "ENDPOINT_RECONCILIATION_INVALID_SNAPSHOT",
    path: string,
    message: string,
  ) {
    super(message);
    this.name = "EndpointReconciliationError";
    this.code = code;
    this.path = path;
  }
}

const encoder = new TextEncoder();
const unsafeText = /[\u0000-\u001f\u007f]/u;
type ValidationCode = "ENDPOINT_RECONCILIATION_INVALID_INPUT" | "ENDPOINT_RECONCILIATION_INVALID_SNAPSHOT";

function fail(code: ValidationCode, path: string, message: string): never {
  throw new EndpointReconciliationError(code, path, message);
}

function text(value: unknown, path: string, limit: number, code: ValidationCode): string {
  if (typeof value !== "string" || value.length === 0) fail(code, path, "Expected a non-empty string.");
  const normalized = value.normalize("NFC");
  if (unsafeText.test(normalized) || /[\ud800-\udfff]/u.test(normalized))
    fail(code, path, "Text contains unsafe or unpaired Unicode characters.");
  if (encoder.encode(normalized).byteLength > limit) fail(code, path, "Text exceeds its byte limit.");
  return normalized;
}

function revision(value: unknown, path: string, code: ValidationCode): EndpointRevision {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0)
      fail(code, path, "Revision numbers must be non-negative safe integers.");
    return value;
  }
  return text(value, path, ENDPOINT_RECONCILIATION_LIMITS.revisionBytes, code);
}

function timestamp(value: unknown, path: string, code: ValidationCode): string {
  const source =
    value instanceof Date
      ? value.toISOString()
      : text(value, path, ENDPOINT_RECONCILIATION_LIMITS.timestampBytes, code);
  const parsed = Date.parse(source);
  if (!Number.isFinite(parsed)) fail(code, path, "Timestamp must be a valid date.");
  return new Date(parsed).toISOString();
}

function freshnessPolicy(options: EndpointFreshnessPolicy = {}): { readonly nowMs: number; readonly maxAgeMs: number } {
  const now =
    options.now === undefined
      ? Date.now()
      : Date.parse(timestamp(options.now, "$.now", "ENDPOINT_RECONCILIATION_INVALID_INPUT"));
  if (!Number.isFinite(now)) fail("ENDPOINT_RECONCILIATION_INVALID_INPUT", "$.now", "Now must be a valid date.");
  const maxAgeMs = options.maxAgeMs ?? ENDPOINT_RECONCILIATION_LIMITS.defaultFreshnessMs;
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) {
    fail("ENDPOINT_RECONCILIATION_INVALID_INPUT", "$.maxAgeMs", "Freshness age must be a non-negative safe integer.");
  }
  return { nowMs: now, maxAgeMs };
}

function compareRevision(left: EndpointRevision, right: EndpointRevision): number {
  if (typeof left === "number" && typeof right === "number") return Math.sign(left - right);
  const leftText = String(left);
  const rightText = String(right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

function compareEvidence(
  left: { readonly revision: EndpointRevision; readonly observedAt: string },
  right: { readonly revision: EndpointRevision; readonly observedAt: string },
): number {
  const leftTime = Date.parse(left.observedAt);
  const rightTime = Date.parse(right.observedAt);
  if (leftTime !== rightTime) return Math.sign(leftTime - rightTime);
  return compareRevision(left.revision, right.revision);
}

function compareHints(left: EndpointWebhookHint, right: EndpointWebhookHint): number {
  if (left.revision !== undefined && right.revision !== undefined) {
    const compared = compareRevision(left.revision, right.revision);
    if (compared !== 0) return compared;
  } else if (left.revision !== undefined) return 1;
  else if (right.revision !== undefined) return -1;
  if (left.occurredAt !== undefined && right.occurredAt !== undefined) {
    const compared = Math.sign(Date.parse(left.occurredAt) - Date.parse(right.occurredAt));
    if (compared !== 0) return compared;
  } else if (left.occurredAt !== undefined) return 1;
  else if (right.occurredAt !== undefined) return -1;
  return left.id.localeCompare(right.id, "en-US");
}

function normalizeHint(value: EndpointWebhookHint): EndpointWebhookHint {
  const id = text(
    value?.id,
    "$.id",
    ENDPOINT_RECONCILIATION_LIMITS.hintIdBytes,
    "ENDPOINT_RECONCILIATION_INVALID_INPUT",
  );
  return Object.freeze({
    id,
    ...(value.revision === undefined
      ? {}
      : { revision: revision(value.revision, "$.revision", "ENDPOINT_RECONCILIATION_INVALID_INPUT") }),
    ...(value.occurredAt === undefined
      ? {}
      : { occurredAt: timestamp(value.occurredAt, "$.occurredAt", "ENDPOINT_RECONCILIATION_INVALID_INPUT") }),
  });
}

function diagnostic(code: EndpointReconciliationDiagnosticCode, message: string): EndpointReconciliationDiagnostic {
  return Object.freeze({
    code,
    message: text(
      message,
      "$.diagnostic",
      ENDPOINT_RECONCILIATION_LIMITS.diagnosticMessageBytes,
      "ENDPOINT_RECONCILIATION_INVALID_INPUT",
    ),
  });
}

function appendDiagnostic(
  diagnostics: readonly EndpointReconciliationDiagnostic[],
  entry: EndpointReconciliationDiagnostic,
): readonly EndpointReconciliationDiagnostic[] {
  return Object.freeze([...diagnostics, entry].slice(-ENDPOINT_RECONCILIATION_LIMITS.diagnostics));
}

function stateFor<T>(
  authoritative: EndpointAuthoritativeObservation<T> | null,
  policy: { readonly nowMs: number; readonly maxAgeMs: number },
): EndpointObservationState {
  if (authoritative === null) return "unavailable";
  return policy.nowMs - Date.parse(authoritative.provenance.observedAt) <= policy.maxAgeMs ? "fresh" : "stale";
}

function freezeRecord<T>(record: EndpointObservationRecord<T>): EndpointObservationRecord<T> {
  return Object.freeze({
    ...record,
    pendingHints: Object.freeze([...record.pendingHints]),
    seenHintIds: Object.freeze([...record.seenHintIds]),
    diagnostics: Object.freeze([...record.diagnostics]),
  });
}

function validRecord<T>(record: EndpointObservationRecord<T>): EndpointObservationRecord<T> {
  if (record.version !== ENDPOINT_RECONCILIATION_VERSION || typeof record.key !== "string" || record.key.length === 0) {
    fail("ENDPOINT_RECONCILIATION_INVALID_INPUT", "$.record", "Observation record is invalid.");
  }
  return record;
}

/** Create an explicit unavailable record before any authoritative evidence exists. */
export function createEndpointObservation<T = unknown>(
  options: CreateEndpointObservationOptions,
): EndpointObservationRecord<T> {
  const key = text(
    options?.key,
    "$.key",
    ENDPOINT_RECONCILIATION_LIMITS.keyBytes,
    "ENDPOINT_RECONCILIATION_INVALID_INPUT",
  );
  return freezeRecord({
    version: ENDPOINT_RECONCILIATION_VERSION,
    key,
    state: "unavailable",
    authoritative: null,
    pendingHints: [],
    seenHintIds: [],
    diagnostics: [],
  });
}

/**
 * Apply a webhook hint without accepting its payload as current state.
 * Duplicate ids are idempotent, including after a hint has been satisfied.
 */
export function applyEndpointWebhookHint<T>(
  input: EndpointObservationRecord<T>,
  value: EndpointWebhookHint,
): EndpointObservationRecord<T> {
  const record = validRecord(input);
  const hint = normalizeHint(value);
  if (record.seenHintIds.includes(hint.id)) return record;
  const seenHintIds = [...record.seenHintIds, hint.id].sort((left, right) => left.localeCompare(right, "en-US"));
  const pendingHints = [...record.pendingHints, hint]
    .sort(compareHints)
    .slice(-ENDPOINT_RECONCILIATION_LIMITS.pendingHints);
  return freezeRecord({
    ...record,
    state: "reconciling",
    pendingHints,
    seenHintIds: seenHintIds.slice(-ENDPOINT_RECONCILIATION_LIMITS.seenHintIds),
  });
}

/** Mark a record as requiring a reread while preserving the last known authority. */
export function beginEndpointReconciliation<T>(input: EndpointObservationRecord<T>): EndpointObservationRecord<T> {
  const record = validRecord(input);
  return freezeRecord({ ...record, state: "reconciling" });
}

function hintSatisfied(hint: EndpointWebhookHint, snapshot: EndpointAuthoritativeObservation<unknown>): boolean {
  if (hint.revision !== undefined) {
    return (
      compareEvidence(snapshot.provenance, {
        revision: hint.revision,
        observedAt: hint.occurredAt ?? snapshot.provenance.observedAt,
      }) >= 0
    );
  }
  if (hint.occurredAt !== undefined) return Date.parse(snapshot.provenance.observedAt) >= Date.parse(hint.occurredAt);
  return false;
}

/**
 * Accept one provider-authoritative snapshot. Older snapshots cannot replace
 * newer authority; they remain visible as an explicit diagnostic instead.
 */
export function applyEndpointAuthoritativeSnapshot<T>(
  input: EndpointObservationRecord<T>,
  snapshot: EndpointAuthoritativeSnapshot<T>,
  options: EndpointFreshnessPolicy = {},
): EndpointObservationRecord<T> {
  const record = validRecord(input);
  const normalized: EndpointAuthoritativeObservation<T> = Object.freeze({
    value: snapshot?.value as T,
    provenance: Object.freeze({
      source: "github-authoritative",
      authoritative: true,
      revision: revision(snapshot?.revision, "$.revision", "ENDPOINT_RECONCILIATION_INVALID_SNAPSHOT"),
      observedAt: timestamp(snapshot?.observedAt, "$.observedAt", "ENDPOINT_RECONCILIATION_INVALID_SNAPSHOT"),
    }),
  });
  const current = record.authoritative;
  if (current !== null && compareEvidence(normalized.provenance, current.provenance) < 0) {
    const policy = freshnessPolicy(options);
    return freezeRecord({
      ...record,
      state: record.pendingHints.length > 0 ? "reconciling" : stateFor(current, policy),
      diagnostics: appendDiagnostic(
        record.diagnostics,
        diagnostic("ENDPOINT_RECONCILIATION_STALE_SNAPSHOT", "An older authoritative snapshot was ignored."),
      ),
    });
  }
  const pendingHints = record.pendingHints.filter((hint) => !hintSatisfied(hint, normalized));
  const policy = freshnessPolicy(options);
  return freezeRecord({
    ...record,
    state: pendingHints.length > 0 ? "reconciling" : stateFor(normalized, policy),
    authoritative: normalized,
    pendingHints,
    diagnostics: [],
  });
}

/**
 * Perform a bounded authoritative reread. Transport adapters supply the
 * reader; failures become explicit stale/unavailable records and are never
 * mistaken for fresh state.
 */
export async function reconcileEndpointObservation<T>(
  input: EndpointObservationRecord<T>,
  reread: EndpointAuthoritativeReread<T>,
  options: ReconcileEndpointObservationOptions = {},
): Promise<EndpointObservationRecord<T>> {
  const initial = beginEndpointReconciliation(input);
  if (typeof reread !== "function")
    fail("ENDPOINT_RECONCILIATION_INVALID_INPUT", "$.reread", "An authoritative reread function is required.");
  const maxAttempts = options.maxAttempts ?? 1;
  if (
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > ENDPOINT_RECONCILIATION_LIMITS.maxRereadAttempts
  ) {
    fail(
      "ENDPOINT_RECONCILIATION_INVALID_INPUT",
      "$.maxAttempts",
      "Reread attempts must be between one and the bounded maximum.",
    );
  }
  let last: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const snapshot = await reread({
        key: initial.key,
        previous: initial.authoritative,
        pendingHints: initial.pendingHints,
        attempt,
      });
      return applyEndpointAuthoritativeSnapshot(initial, snapshot, options);
    } catch (error: unknown) {
      last = error;
    }
  }
  const staleOrUnavailable = initial.authoritative === null ? "unavailable" : "stale";
  return freezeRecord({
    ...initial,
    state: staleOrUnavailable,
    diagnostics: appendDiagnostic(
      initial.diagnostics,
      diagnostic(
        maxAttempts === 1 ? "ENDPOINT_RECONCILIATION_REREAD_FAILED" : "ENDPOINT_RECONCILIATION_REREAD_EXHAUSTED",
        last instanceof Error && last.message.length > 0
          ? `Authoritative reread failed: ${last.message}`
          : "Authoritative reread failed.",
      ),
    ),
  });
}

export const createEndpointObservationRecord = createEndpointObservation;
export const applyEndpointWebhook = applyEndpointWebhookHint;
export const reconcileEndpoint = reconcileEndpointObservation;
