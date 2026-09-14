/**
 * Operator-facing Delegator operations.
 *
 * This module composes the existing key, schema, trust, and provenance
 * authorities.  It constructs public trust records and verifies a deployment
 * against the protected repository ref; it never writes GitHub state, writes
 * deployment secrets, or returns private key material in an operation result.
 */

import { type KeyObject } from "node:crypto";
import {
  assertDelegator,
  DELEGATOR_CONTRACT_VERSION,
  DELEGATOR_KIND,
  DELEGATOR_ID_PATTERN,
  type Delegator,
} from "./delegator.js";
import {
  exportDelegatorPublicKey,
  importDelegatorPrivateKey,
  loadDelegatorKeyPair,
  delegatorPublicKeyFingerprint,
  type DelegatorKeyPair,
} from "./delegator-key.js";
import { assertEd25519PublicJwk, type Ed25519PublicJwk } from "./ed25519-jwk.js";
import { isCapabilityKind, type CapabilityKind } from "./capability.js";
import {
  resolveDelegator,
  DelegatorTrustError,
  type DelegatorSourceReader,
  type LoadedDelegator,
} from "./delegator-trust.js";
import {
  ChangeProvenanceRecordError,
  createChangeProvenanceRecord,
  renderChangeProvenanceRecord,
  verifyChangeProvenanceRecord,
  type SignedChangeProvenanceRecord,
} from "../change-provenance-record.js";

export type DelegatorPublicKeyInput = Ed25519PublicJwk | KeyObject | DelegatorKeyPair;

export interface CreateDelegatorRecordOptions {
  readonly id: string;
  /** A public JWK, public/private KeyObject, or generated local keypair. */
  readonly key: DelegatorPublicKeyInput;
  readonly status?: Delegator["status"];
  /** An RFC 3339 timestamp or Date; omitted values use the current instant. */
  readonly notBefore?: string | Date;
  /** An RFC 3339 timestamp, Date, or null; omitted values have no expiry. */
  readonly notAfter?: string | Date | null;
  readonly maxSessionTtlSeconds: number;
  readonly capabilityCeiling: readonly CapabilityKind[];
}

export interface DelegatorIdentity {
  readonly authorityId: string;
  readonly publicKey: Delegator["key"];
  readonly publicKeyFingerprint: string;
}

export type DelegatorReadinessState =
  | "ready"
  | "missing-deployment-binding"
  | "unknown-authority"
  | "inactive-authority"
  | "invalid-private-key"
  | "key-mismatch"
  | "ambiguous-authority"
  | "canonical-trust-unavailable"
  | "ttl-exceeds-ceiling"
  | "capability-exceeds-ceiling"
  | "signer-probe-failed";

export type DelegatorReadinessDiagnosticCode =
  | "RUNTIME_AUTHORITY_READINESS_MISSING_DEPLOYMENT_BINDING"
  | "RUNTIME_AUTHORITY_READINESS_UNKNOWN_AUTHORITY"
  | "RUNTIME_AUTHORITY_READINESS_INACTIVE_AUTHORITY"
  | "RUNTIME_AUTHORITY_READINESS_PRIVATE_KEY_INVALID"
  | "RUNTIME_AUTHORITY_READINESS_KEY_MISMATCH"
  | "RUNTIME_AUTHORITY_READINESS_AMBIGUOUS_AUTHORITY"
  | "RUNTIME_AUTHORITY_READINESS_CANONICAL_TRUST_UNAVAILABLE"
  | "RUNTIME_AUTHORITY_READINESS_TTL_EXCEEDS_CEILING"
  | "RUNTIME_AUTHORITY_READINESS_CAPABILITY_EXCEEDS_CEILING"
  | "RUNTIME_AUTHORITY_READINESS_SIGNER_PROBE_FAILED"
  | "RUNTIME_AUTHORITY_READINESS_ROTATION_ORDER_BLOCKED";

export interface DelegatorReadinessDiagnostic {
  readonly code: DelegatorReadinessDiagnosticCode;
  readonly message: string;
}

export interface DelegatorReadinessCanonicalEvidence {
  readonly ref: string;
  readonly policySha: string;
  readonly treeSha: string;
  readonly path: string;
  readonly authorityId: string;
  readonly publicKeyFingerprint: string;
}

export interface DelegatorReadinessProbe {
  readonly operation: "change.issue";
  readonly issue: number;
  readonly verified: true;
}

export interface DelegatorReadinessResult {
  readonly ok: boolean;
  readonly state: DelegatorReadinessState;
  readonly authorityId?: string;
  readonly publicKeyFingerprint?: string;
  readonly canonical?: DelegatorReadinessCanonicalEvidence;
  readonly probe?: DelegatorReadinessProbe;
  /** This projection is deliberately public-only and contains no key bytes. */
  readonly diagnostics: readonly DelegatorReadinessDiagnostic[];
}

export type DelegatorReadinessPrivateKey = string | KeyObject | DelegatorKeyPair;

/** Runtime-local signer configuration used only before a fresh Change issue. */
export interface DelegatorChangeProvenanceSignerOptions {
  /** The exact Delegator ID selected by this initiating Runtime. */
  readonly authorityId?: string;
  /** PEM, private KeyObject, or local keypair held by the signer only. */
  readonly privateKey?: DelegatorReadinessPrivateKey;
  /** Secure local key path, useful for file-backed Runtime configuration. */
  readonly privateKeyPath?: string;
  readonly now?: Date;
}

export interface VerifyDelegatorReadinessOptions {
  /** Authority ID selected by the initiating Runtime. */
  readonly authorityId?: string;
  /** PEM, private KeyObject, or generated keypair held by the signer only. */
  readonly privateKey?: DelegatorReadinessPrivateKey;
  /** Secure local key path, useful for operator CLI verification. */
  readonly privateKeyPath?: string;
  readonly now?: Date;
  /** Positive Issue used only for the bounded change.issue signature probe. */
  readonly probeIssue?: number;
  /** Optional intended Session TTL to check against the trusted ceiling. */
  readonly sessionTtlSeconds?: number;
  /** Optional intended semantic capabilities to check against the ceiling. */
  readonly capabilities?: readonly unknown[];
}

export type DelegatorRotationPhase = "activate" | "revoke";

export interface DelegatorRotationOrderOptions {
  readonly currentAuthorityId: string;
  readonly nextAuthorityId: string;
  readonly phase: DelegatorRotationPhase;
  /** The deployment's current configured authority ID, when known. */
  readonly signerAuthorityId?: string;
  /** Readiness result obtained against the canonical protected ref. */
  readonly nextReadiness: Pick<DelegatorReadinessResult, "ok" | "state" | "authorityId">;
}

export type DelegatorRotationOrderState = "ready-to-activate" | "ready-to-revoke" | "blocked";

export interface DelegatorRotationOrderResult {
  readonly ok: boolean;
  readonly state: DelegatorRotationOrderState;
  readonly diagnostic?: DelegatorReadinessDiagnostic;
}

const MAX_READINESS_DIAGNOSTICS = 2;
const MAX_PRIVATE_KEY_ENV_BYTES = 16_384;

function isAuthorityId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && DELEGATOR_ID_PATTERN.test(value);
}

function isKeyPair(value: unknown): value is DelegatorKeyPair {
  return typeof value === "object" && value !== null && "privateKey" in value && "publicKey" in value;
}

function isPrivateKeyObject(value: unknown): value is KeyObject {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "asymmetricKeyType" in value &&
    (value as KeyObject).type === "private" &&
    (value as KeyObject).asymmetricKeyType === "ed25519"
  );
}

function isPublicJwk(value: DelegatorPublicKeyInput): value is Ed25519PublicJwk {
  return typeof value === "object" && value !== null && "kty" in value;
}

function timestamp(value: string | Date | undefined): string {
  if (value === undefined) return new Date().toISOString();
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError("Delegator timestamp is invalid.");
    return value.toISOString();
  }
  return value;
}

function diagnostic(code: DelegatorReadinessDiagnosticCode, message: string): DelegatorReadinessDiagnostic {
  return { code, message };
}

function readinessFailure(
  state: DelegatorReadinessState,
  failure: DelegatorReadinessDiagnostic,
  authorityId?: string,
  publicKeyFingerprint?: string,
  canonical?: DelegatorReadinessCanonicalEvidence,
): DelegatorReadinessResult {
  return Object.freeze({
    ok: false,
    state,
    ...(authorityId === undefined ? {} : { authorityId }),
    ...(publicKeyFingerprint === undefined ? {} : { publicKeyFingerprint }),
    ...(canonical === undefined ? {} : { canonical }),
    diagnostics: Object.freeze([failure].slice(0, MAX_READINESS_DIAGNOSTICS)),
  });
}

function readinessCanonical(loaded: LoadedDelegator): DelegatorReadinessCanonicalEvidence {
  return Object.freeze({
    ref: loaded.provenance.ref,
    policySha: loaded.provenance.policySha,
    treeSha: loaded.provenance.treeSha,
    path: loaded.path,
    authorityId: loaded.authority.id,
    publicKeyFingerprint: delegatorPublicKeyFingerprint(loaded.authority.key),
  });
}

function privateKeyFromOptions(options: {
  readonly privateKey?: DelegatorReadinessPrivateKey;
  readonly privateKeyPath?: string;
}): KeyObject | undefined {
  if (options.privateKey !== undefined && options.privateKeyPath !== undefined) return undefined;
  if (options.privateKeyPath !== undefined) {
    try {
      return loadDelegatorKeyPair(options.privateKeyPath).privateKey;
    } catch {
      return undefined;
    }
  }
  const input = options.privateKey;
  if (typeof input === "string") {
    if (input.length === 0 || Buffer.byteLength(input, "utf8") > MAX_PRIVATE_KEY_ENV_BYTES) return undefined;
    try {
      return importDelegatorPrivateKey(input);
    } catch {
      return undefined;
    }
  }
  if (isKeyPair(input)) return isPrivateKeyObject(input.privateKey) ? input.privateKey : undefined;
  return isPrivateKeyObject(input) ? input : undefined;
}

function trustFailure(error: unknown, authorityId: string): DelegatorReadinessResult {
  if (!(error instanceof DelegatorTrustError)) {
    return readinessFailure(
      "canonical-trust-unavailable",
      diagnostic(
        "RUNTIME_AUTHORITY_READINESS_CANONICAL_TRUST_UNAVAILABLE",
        "Canonical Delegator trust could not be read or validated.",
      ),
      authorityId,
    );
  }
  switch (error.code) {
    case "RUNTIME_AUTHORITY_NOT_FOUND":
      return readinessFailure(
        "unknown-authority",
        diagnostic(
          "RUNTIME_AUTHORITY_READINESS_UNKNOWN_AUTHORITY",
          "Authority ID is not trusted on the canonical ref.",
        ),
        authorityId,
      );
    case "RUNTIME_AUTHORITY_INACTIVE":
      return readinessFailure(
        "inactive-authority",
        diagnostic(
          "RUNTIME_AUTHORITY_READINESS_INACTIVE_AUTHORITY",
          "The canonical Delegator is disabled or outside its validity window.",
        ),
        authorityId,
      );
    case "RUNTIME_AUTHORITY_AMBIGUOUS":
      return readinessFailure(
        "ambiguous-authority",
        diagnostic(
          "RUNTIME_AUTHORITY_READINESS_AMBIGUOUS_AUTHORITY",
          "Authority ID does not resolve to one unambiguous canonical trust record.",
        ),
        authorityId,
      );
    default:
      return readinessFailure(
        "canonical-trust-unavailable",
        diagnostic(
          "RUNTIME_AUTHORITY_READINESS_CANONICAL_TRUST_UNAVAILABLE",
          "Canonical Delegator trust could not be read or validated.",
        ),
        authorityId,
      );
  }
}

/** Derive a public, deterministic Delegator identity from key material. */
export function deriveDelegatorIdentity(authorityId: string, key: DelegatorPublicKeyInput): DelegatorIdentity {
  const publicKey = isPublicJwk(key) ? assertEd25519PublicJwk(key) : exportDelegatorPublicKey(key);
  return Object.freeze({
    authorityId,
    publicKey,
    publicKeyFingerprint: delegatorPublicKeyFingerprint(publicKey),
  });
}

/** Derive the same public identity from a canonical trust record. */
export function delegatorIdentity(authority: Delegator): DelegatorIdentity {
  const validated = assertDelegator(authority);
  return deriveDelegatorIdentity(validated.id, validated.key);
}

/** Construct a canonical public trust record without hand-authoring JWK JSON. */
export function createDelegatorRecord(options: CreateDelegatorRecordOptions): Delegator {
  const identity = deriveDelegatorIdentity(options.id, options.key);
  const record = {
    version: DELEGATOR_CONTRACT_VERSION,
    kind: DELEGATOR_KIND,
    id: options.id,
    key: identity.publicKey,
    status: options.status ?? "active",
    notBefore: timestamp(options.notBefore),
    notAfter: options.notAfter === undefined || options.notAfter === null ? null : timestamp(options.notAfter),
    maxSessionTtlSeconds: options.maxSessionTtlSeconds,
    capabilityCeiling: options.capabilityCeiling,
  };
  return assertDelegator(record);
}

/** Verify a Delegator signer against the current canonical protected-ref trust root. */
export async function verifyDelegatorReadiness(
  reader: DelegatorSourceReader,
  options: VerifyDelegatorReadinessOptions,
): Promise<DelegatorReadinessResult> {
  const authorityId = options.authorityId;
  if (!isAuthorityId(authorityId) || (options.privateKey === undefined && options.privateKeyPath === undefined)) {
    return readinessFailure(
      "missing-deployment-binding",
      diagnostic(
        "RUNTIME_AUTHORITY_READINESS_MISSING_DEPLOYMENT_BINDING",
        "Signer deployment must provide an authority ID and a Runtime private key.",
      ),
      isAuthorityId(authorityId) ? authorityId : undefined,
    );
  }
  const runtimeKey = privateKeyFromOptions(options);
  if (runtimeKey === undefined) {
    return readinessFailure(
      "invalid-private-key",
      diagnostic(
        "RUNTIME_AUTHORITY_READINESS_PRIVATE_KEY_INVALID",
        "Configured Delegator private key is missing, malformed, or not Ed25519 PKCS#8.",
      ),
      authorityId,
    );
  }

  let derived: DelegatorIdentity;
  try {
    derived = deriveDelegatorIdentity(authorityId, runtimeKey);
  } catch {
    return readinessFailure(
      "invalid-private-key",
      diagnostic(
        "RUNTIME_AUTHORITY_READINESS_PRIVATE_KEY_INVALID",
        "Configured Delegator private key is missing, malformed, or not Ed25519 PKCS#8.",
      ),
      authorityId,
    );
  }
  let loaded: LoadedDelegator;
  try {
    loaded = await resolveDelegator(reader, authorityId, { now: options.now });
  } catch (error: unknown) {
    return trustFailure(error, authorityId);
  }
  const canonical = readinessCanonical(loaded);
  if (derived.publicKey.x !== loaded.authority.key.x) {
    return readinessFailure(
      "key-mismatch",
      diagnostic(
        "RUNTIME_AUTHORITY_READINESS_KEY_MISMATCH",
        "Configured Delegator private key does not match the canonical public trust record.",
      ),
      authorityId,
      derived.publicKeyFingerprint,
      canonical,
    );
  }

  if (
    options.sessionTtlSeconds !== undefined &&
    (!Number.isSafeInteger(options.sessionTtlSeconds) ||
      options.sessionTtlSeconds < 1 ||
      options.sessionTtlSeconds > loaded.authority.maxSessionTtlSeconds)
  ) {
    return readinessFailure(
      "ttl-exceeds-ceiling",
      diagnostic(
        "RUNTIME_AUTHORITY_READINESS_TTL_EXCEEDS_CEILING",
        "Intended Session TTL exceeds the canonical Delegator ceiling.",
      ),
      authorityId,
      derived.publicKeyFingerprint,
      canonical,
    );
  }
  if (
    options.capabilities !== undefined &&
    options.capabilities.some(
      (capability) => !isCapabilityKind(capability) || !loaded.authority.capabilityCeiling.includes(capability),
    )
  ) {
    return readinessFailure(
      "capability-exceeds-ceiling",
      diagnostic(
        "RUNTIME_AUTHORITY_READINESS_CAPABILITY_EXCEEDS_CEILING",
        "Intended semantic capability is outside the canonical Delegator ceiling.",
      ),
      authorityId,
      derived.publicKeyFingerprint,
      canonical,
    );
  }

  const probeIssue = options.probeIssue ?? 1;
  if (!Number.isSafeInteger(probeIssue) || probeIssue < 1) {
    return readinessFailure(
      "signer-probe-failed",
      diagnostic(
        "RUNTIME_AUTHORITY_READINESS_SIGNER_PROBE_FAILED",
        "The bounded signer probe could not be constructed for a valid Issue number.",
      ),
      authorityId,
      derived.publicKeyFingerprint,
      canonical,
    );
  }
  try {
    const record = createChangeProvenanceRecord({
      rootIssue: probeIssue,
      runtimeAuthority: loaded.authority,
      runtimeKey,
      now: options.now,
    });
    verifyChangeProvenanceRecord(renderChangeProvenanceRecord(record), loaded.authority);
  } catch {
    return readinessFailure(
      "signer-probe-failed",
      diagnostic(
        "RUNTIME_AUTHORITY_READINESS_SIGNER_PROBE_FAILED",
        "The signer could not produce a bounded record verified by canonical trust.",
      ),
      authorityId,
      derived.publicKeyFingerprint,
      canonical,
    );
  }

  return Object.freeze({
    ok: true,
    state: "ready",
    authorityId,
    publicKeyFingerprint: derived.publicKeyFingerprint,
    canonical,
    probe: Object.freeze({ operation: "change.issue", issue: probeIssue, verified: true as const }),
    diagnostics: Object.freeze([]),
  });
}

/**
 * Create the caller-owned provenance record for one fresh `change.issue`.
 *
 * This is the Runtime-side signing seam: local signer configuration is read
 * here, canonical protected-ref trust is resolved here, and only the signed
 * public record is returned to the Change transport boundary.
 */
export async function createDelegatorSignedChangeProvenanceRecord(
  reader: DelegatorSourceReader,
  rootIssue: number,
  options: DelegatorChangeProvenanceSignerOptions,
): Promise<SignedChangeProvenanceRecord> {
  if (!Number.isSafeInteger(rootIssue) || rootIssue < 1) {
    throw new ChangeProvenanceRecordError(
      "CHANGE_PROVENANCE_RECORD_INVALID",
      "Root Issue must be a positive safe integer.",
    );
  }
  if (
    !isAuthorityId(options.authorityId) ||
    (options.privateKey === undefined && options.privateKeyPath === undefined)
  ) {
    throw new ChangeProvenanceRecordError(
      "CHANGE_PROVENANCE_RECORD_SIGNING_FAILED",
      "Runtime signer configuration must provide an authority ID and private key.",
    );
  }
  const runtimeKey = privateKeyFromOptions(options);
  if (runtimeKey === undefined) {
    throw new ChangeProvenanceRecordError(
      "CHANGE_PROVENANCE_RECORD_SIGNING_FAILED",
      "Runtime signer private key is missing, malformed, or not Ed25519 PKCS#8.",
    );
  }
  const loaded = await resolveDelegator(reader, options.authorityId, { now: options.now });
  const record = createChangeProvenanceRecord({
    rootIssue,
    runtimeAuthority: loaded.authority,
    runtimeKey,
    now: options.now,
  });
  const payload = verifyChangeProvenanceRecord(renderChangeProvenanceRecord(record), loaded.authority);
  if (payload.rootIssue !== rootIssue || payload.operation !== "change.issue") {
    throw new ChangeProvenanceRecordError(
      "CHANGE_PROVENANCE_RECORD_SIGNING_FAILED",
      "Runtime provenance record is not bound to the requested Change issue.",
    );
  }
  return record;
}

/**
 * Enforce the only safe overlap ordering at the operator boundary.  This is a
 * pure guard: it does not publish trust or mutate deployment configuration.
 */
export function checkDelegatorRotationOrder(options: DelegatorRotationOrderOptions): DelegatorRotationOrderResult {
  const blocked = (message: string): DelegatorRotationOrderResult =>
    Object.freeze({
      ok: false,
      state: "blocked",
      diagnostic: diagnostic("RUNTIME_AUTHORITY_READINESS_ROTATION_ORDER_BLOCKED", message),
    });
  if (
    !isAuthorityId(options.currentAuthorityId) ||
    !isAuthorityId(options.nextAuthorityId) ||
    options.currentAuthorityId === options.nextAuthorityId
  ) {
    return blocked("Rotation requires two distinct valid Delegator IDs.");
  }
  if (!options.nextReadiness.ok || options.nextReadiness.authorityId !== options.nextAuthorityId) {
    return blocked("The replacement signer is not ready against canonical trust.");
  }
  if (options.phase === "activate") return Object.freeze({ ok: true, state: "ready-to-activate" });
  if (options.signerAuthorityId !== options.nextAuthorityId) {
    return blocked("The signer must resolve to the replacement authority before revoking the old authority.");
  }
  return Object.freeze({ ok: true, state: "ready-to-revoke" });
}

/** Public-only projection used by deployment diagnostics and tests. */
export function projectRuntimeSigningEnvironment(environment: NodeJS.ProcessEnv = process.env): {
  readonly environment: "runtime-signing";
  readonly authorityId?: string;
  readonly privateKeyConfigured: boolean;
  readonly privateKeyExposed: false;
} {
  const authorityId = environment.INARI_RUNTIME_AUTHORITY_ID;
  const privateKey = environment.INARI_RUNTIME_AUTHORITY_PRIVATE_KEY;
  return Object.freeze({
    environment: "runtime-signing",
    ...(isAuthorityId(authorityId) ? { authorityId } : {}),
    privateKeyConfigured:
      typeof privateKey === "string" && privateKey.length > 0 && privateKey.length <= MAX_PRIVATE_KEY_ENV_BYTES,
    privateKeyExposed: false as const,
  });
}

/** Compatibility aliases for the pre-Delegator operator API. */
export type RuntimeAuthorityPublicKeyInput = DelegatorPublicKeyInput;
export type CreateRuntimeAuthorityRecordOptions = CreateDelegatorRecordOptions;
export type RuntimeAuthorityIdentity = DelegatorIdentity;
export type RuntimeAuthorityReadinessState = DelegatorReadinessState;
export type RuntimeAuthorityReadinessDiagnosticCode = DelegatorReadinessDiagnosticCode;
export type RuntimeAuthorityReadinessDiagnostic = DelegatorReadinessDiagnostic;
export type RuntimeAuthorityReadinessCanonicalEvidence = DelegatorReadinessCanonicalEvidence;
export type RuntimeAuthorityReadinessProbe = DelegatorReadinessProbe;
export type RuntimeAuthorityReadinessResult = DelegatorReadinessResult;
export type RuntimeAuthorityReadinessPrivateKey = DelegatorReadinessPrivateKey;
export type RuntimeChangeProvenanceSignerOptions = DelegatorChangeProvenanceSignerOptions;
export type VerifyRuntimeAuthorityReadinessOptions = VerifyDelegatorReadinessOptions;
export type RuntimeAuthorityRotationPhase = DelegatorRotationPhase;
export type RuntimeAuthorityRotationOrderOptions = DelegatorRotationOrderOptions;
export type RuntimeAuthorityRotationOrderState = DelegatorRotationOrderState;
export type RuntimeAuthorityRotationOrderResult = DelegatorRotationOrderResult;
export const deriveRuntimeAuthorityIdentity = deriveDelegatorIdentity;
export const runtimeAuthorityIdentity = delegatorIdentity;
export const createRuntimeAuthorityRecord = createDelegatorRecord;
export const verifyRuntimeAuthorityReadiness = verifyDelegatorReadiness;
export const createRuntimeSignedChangeProvenanceRecord = createDelegatorSignedChangeProvenanceRecord;
export const checkRuntimeAuthorityRotationOrder = checkDelegatorRotationOrder;
