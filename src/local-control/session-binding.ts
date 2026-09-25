/**
 * Immutable, locally issued Admission Session bindings.
 *
 * Bindings use a separate versioned payload from Session Certificate V1. The
 * shared Session Certificate validator is used only for the repository, task,
 * capability, and time claim vocabulary; its Session key field is populated
 * with a schema-only public key and is never serialized into this binding.
 */

import { createPublicKey, sign as ed25519Sign, verify as ed25519Verify, type KeyObject } from "node:crypto";
import {
  MAX_SESSION_TTL_SECONDS,
  MIN_SESSION_TTL_SECONDS,
  assertDelegator,
  isDelegatorActive,
  type Delegator,
} from "../agent-authority/delegator.js";
import {
  delegatorPublicKeyFingerprint,
  exportDelegatorPublicKey,
  type DelegatorKeyPair,
} from "../agent-authority/delegator-key.js";
import {
  MAX_UNIX_TIME_SECONDS,
  SESSION_CERTIFICATE_CONTRACT_VERSION,
  validateSessionCertificatePayload,
  type SessionCertificateRepository,
  type SessionCertificateTask,
} from "../agent-authority/session-certificate.js";
import { capabilityClaimWithinCeiling, type CapabilityClaim } from "../agent-authority/capability.js";
import { canonicalJsonString, type CanonicalJsonValue } from "../agent-authority/codec.js";
import type { Ed25519PublicJwk } from "../agent-authority/ed25519-jwk.js";
import { validateLocalBranchObservation, type LocalBranchObservation } from "../cli/runtime/branch-observation.js";
import { validateBranchName } from "../branch-naming.js";

export const LOCAL_SESSION_BINDING_VERSION = 1 as const;
export const MAX_LOCAL_SESSION_BINDING_BYTES = 16 * 1024;

const SIGNING_DOMAIN = "urn:inari:local-admission-session-binding:v1\n";
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/u;
const SCHEMA_ONLY_PUBLIC_KEY: Ed25519PublicJwk = Object.freeze({
  kty: "OKP",
  crv: "Ed25519",
  x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
});
const BINDING_KEYS = new Set([
  "version",
  "sessionId",
  "repository",
  "task",
  "capabilities",
  "authority",
  "iat",
  "nbf",
  "exp",
  "signature",
  "branchObservation",
]);
const AUTHORITY_KEYS = new Set(["id", "publicKeyFingerprint"]);

export interface LocalSessionBindingAuthority {
  readonly id: string;
  readonly publicKeyFingerprint: string;
}

export interface LocalSessionBinding {
  readonly version: typeof LOCAL_SESSION_BINDING_VERSION;
  readonly sessionId: string;
  readonly repository: SessionCertificateRepository;
  readonly task: SessionCertificateTask;
  readonly capabilities: readonly CapabilityClaim[];
  readonly authority: LocalSessionBindingAuthority;
  /** Issuance time in Unix seconds. */
  readonly iat: number;
  /** Inclusive validity start in Unix seconds. */
  readonly nbf: number;
  /** Exclusive validity end in Unix seconds. */
  readonly exp: number;
  /** Ed25519 signature over the domain-separated canonical payload. */
  readonly signature: string;
  /** Additive signed repository-policy observation; absent on legacy Sessions. */
  readonly branchObservation?: LocalBranchObservation;
}

export interface CreateLocalSessionBindingOptions {
  readonly sessionId: string;
  /** Repository identity resolved by Runtime, never a Session-provided selector. */
  readonly repository: SessionCertificateRepository;
  readonly task: SessionCertificateTask;
  readonly capabilities: readonly CapabilityClaim[];
  readonly ttlSeconds: number;
  readonly runtimeAuthority: Delegator;
  /** Runtime Authority key only. No Agent Session key is accepted here. */
  readonly runtimeKey: KeyObject | DelegatorKeyPair;
  readonly now?: Date;
  readonly branchObservation?: LocalBranchObservation;
}

export type LocalSessionBindingDiagnosticCode =
  | "LOCAL_SESSION_BINDING_INVALID"
  | "LOCAL_SESSION_BINDING_UNSUPPORTED_VERSION"
  | "LOCAL_SESSION_BINDING_TRUST_MISMATCH"
  | "LOCAL_SESSION_BINDING_SIGNATURE_INVALID"
  | "LOCAL_SESSION_BINDING_AUTHORITY_INACTIVE"
  | "LOCAL_SESSION_BINDING_NOT_YET_VALID"
  | "LOCAL_SESSION_BINDING_CAPABILITY_EXCEEDS_CEILING"
  | "LOCAL_SESSION_BINDING_TTL_EXCEEDS_CEILING";

export interface LocalSessionBindingDiagnostic {
  readonly code: LocalSessionBindingDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface LocalSessionBindingValidationResult {
  readonly valid: boolean;
  readonly value?: LocalSessionBinding;
  readonly diagnostics: readonly LocalSessionBindingDiagnostic[];
}

export interface LocalSessionBindingVerificationResult extends LocalSessionBindingValidationResult {
  readonly status?: "active" | "expired";
}

export type LocalSessionBindingErrorCode =
  | "LOCAL_SESSION_BINDING_INVALID_INPUT"
  | "LOCAL_SESSION_BINDING_AUTHORITY_INACTIVE"
  | "LOCAL_SESSION_BINDING_SIGNING_KEY_INVALID"
  | "LOCAL_SESSION_BINDING_SIGNING_KEY_MISMATCH"
  | "LOCAL_SESSION_BINDING_TTL_EXCEEDS_CEILING"
  | "LOCAL_SESSION_BINDING_CAPABILITY_EXCEEDS_CEILING"
  | "LOCAL_SESSION_BINDING_SIGNING_FAILED";

export class LocalSessionBindingError extends Error {
  readonly code: LocalSessionBindingErrorCode;

  constructor(code: LocalSessionBindingErrorCode, message: string) {
    super(message);
    this.name = "LocalSessionBindingError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diagnostic(code: LocalSessionBindingDiagnosticCode, message: string): LocalSessionBindingDiagnostic {
  return Object.freeze({ code, path: "$", message });
}

function invalidResult(message = "Session binding is malformed."): LocalSessionBindingValidationResult {
  return Object.freeze({
    valid: false,
    diagnostics: Object.freeze([diagnostic("LOCAL_SESSION_BINDING_INVALID", message)]),
  });
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function payloadOf(binding: LocalSessionBinding): Omit<LocalSessionBinding, "signature"> {
  return {
    version: binding.version,
    sessionId: binding.sessionId,
    repository: binding.repository,
    task: binding.task,
    capabilities: binding.capabilities,
    authority: binding.authority,
    iat: binding.iat,
    nbf: binding.nbf,
    exp: binding.exp,
    ...(binding.branchObservation === undefined ? {} : { branchObservation: binding.branchObservation }),
  };
}

function signingInput(binding: LocalSessionBinding): string {
  return `${SIGNING_DOMAIN}${canonicalJsonString(payloadOf(binding) as unknown as CanonicalJsonValue)}`;
}

function schemaPayload(input: Record<string, unknown>, authorityId: string): unknown {
  return {
    ver: SESSION_CERTIFICATE_CONTRACT_VERSION,
    iss: `runtime:${authorityId}`,
    sub: `session:${String(input.sessionId ?? "")}`,
    jti: String(input.sessionId ?? ""),
    repository: input.repository,
    sessionKey: SCHEMA_ONLY_PUBLIC_KEY,
    ...(input.task === undefined ? {} : { task: input.task }),
    capabilities: input.capabilities,
    iat: input.iat,
    nbf: input.nbf,
    exp: input.exp,
  };
}

/** Validate a closed local binding shape and normalize its shared claims. */
export function validateLocalSessionBinding(input: unknown): LocalSessionBindingValidationResult {
  if (!isRecord(input) || !hasOnlyKeys(input, BINDING_KEYS)) return invalidResult();
  if (input.version !== LOCAL_SESSION_BINDING_VERSION) {
    return Object.freeze({
      valid: false,
      diagnostics: Object.freeze([
        diagnostic("LOCAL_SESSION_BINDING_UNSUPPORTED_VERSION", "Session binding version is unsupported."),
      ]),
    });
  }
  if (!isRecord(input.authority) || !hasOnlyKeys(input.authority, AUTHORITY_KEYS)) return invalidResult();
  const authorityId = input.authority.id;
  const fingerprint = input.authority.publicKeyFingerprint;
  if (
    typeof authorityId !== "string" ||
    typeof fingerprint !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(fingerprint)
  ) {
    return invalidResult();
  }
  const claims = validateSessionCertificatePayload(schemaPayload(input, authorityId));
  if (!claims.valid || claims.value === undefined || claims.value.task === undefined) return invalidResult();
  const branchObservation =
    input.branchObservation === undefined ? undefined : validateLocalBranchObservation(input.branchObservation);
  if (input.branchObservation !== undefined && branchObservation === undefined) return invalidResult();
  if (
    branchObservation === undefined &&
    claims.value.capabilities.some(
      (claim) => claim.kind === "branch.advance" && validateBranchName(claim.branch).length > 0,
    )
  )
    return invalidResult();
  if (branchObservation !== undefined) {
    if (
      branchObservation.repository.repositoryHost !== "github.com" ||
      branchObservation.repository.repositoryId !== claims.value.repository.id ||
      branchObservation.implementation !== claims.value.task.number ||
      claims.value.capabilities.some(
        (claim) => claim.kind === "branch.advance" && claim.branch !== branchObservation.expectedBranch,
      )
    )
      return invalidResult();
  }
  if (input.nbf !== input.iat || !Number.isInteger(input.iat) || !Number.isInteger(input.exp)) return invalidResult();
  if (typeof input.signature !== "string" || !SIGNATURE_PATTERN.test(input.signature)) return invalidResult();

  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(input.signature, "base64url");
  } catch {
    return invalidResult();
  }
  if (signatureBytes.byteLength !== 64 || signatureBytes.toString("base64url") !== input.signature)
    return invalidResult();

  const value: LocalSessionBinding = Object.freeze({
    version: LOCAL_SESSION_BINDING_VERSION,
    sessionId: claims.value.sub.slice("session:".length),
    repository: claims.value.repository,
    task: claims.value.task,
    capabilities: claims.value.capabilities,
    authority: Object.freeze({ id: authorityId, publicKeyFingerprint: fingerprint }),
    iat: claims.value.iat,
    nbf: claims.value.nbf,
    exp: claims.value.exp,
    signature: input.signature,
    ...(branchObservation === undefined ? {} : { branchObservation }),
  });
  const serialized = canonicalJsonString(value as unknown as CanonicalJsonValue);
  if (Buffer.byteLength(serialized, "utf8") > MAX_LOCAL_SESSION_BINDING_BYTES) return invalidResult();
  return Object.freeze({ valid: true, value, diagnostics: Object.freeze([]) });
}

function runtimePrivateKey(input: KeyObject | DelegatorKeyPair): KeyObject {
  if (isRecord(input) && "privateKey" in input) return input.privateKey as KeyObject;
  return input as KeyObject;
}

function unixSeconds(now: Date): number {
  if (!(now instanceof Date))
    throw new LocalSessionBindingError("LOCAL_SESSION_BINDING_INVALID_INPUT", "Issuance clock is invalid.");
  const milliseconds = now.getTime();
  const seconds = Math.floor(milliseconds / 1000);
  if (!Number.isFinite(milliseconds) || seconds < 0 || seconds > MAX_UNIX_TIME_SECONDS) {
    throw new LocalSessionBindingError(
      "LOCAL_SESSION_BINDING_INVALID_INPUT",
      "Issuance clock is outside the supported range.",
    );
  }
  return seconds;
}

/** Issue a canonical binding with the trusted Runtime Authority Ed25519 key. */
export function createLocalSessionBinding(options: CreateLocalSessionBindingOptions): LocalSessionBinding {
  let authority: Delegator;
  try {
    authority = assertDelegator(options.runtimeAuthority);
  } catch {
    throw new LocalSessionBindingError("LOCAL_SESSION_BINDING_INVALID_INPUT", "Runtime Authority record is invalid.");
  }
  const now = options.now ?? new Date();
  const iat = unixSeconds(now);
  if (!isDelegatorActive(authority, now)) {
    throw new LocalSessionBindingError("LOCAL_SESSION_BINDING_AUTHORITY_INACTIVE", "Runtime Authority is not active.");
  }
  if (
    !Number.isInteger(options.ttlSeconds) ||
    options.ttlSeconds < MIN_SESSION_TTL_SECONDS ||
    options.ttlSeconds > MAX_SESSION_TTL_SECONDS ||
    options.ttlSeconds > authority.maxSessionTtlSeconds
  ) {
    throw new LocalSessionBindingError(
      "LOCAL_SESSION_BINDING_TTL_EXCEEDS_CEILING",
      "Session TTL exceeds the Authority ceiling.",
    );
  }
  const exp = iat + options.ttlSeconds;
  if (authority.notAfter !== null && exp * 1000 > Date.parse(authority.notAfter)) {
    throw new LocalSessionBindingError(
      "LOCAL_SESSION_BINDING_TTL_EXCEEDS_CEILING",
      "Session would outlive the Authority trust window.",
    );
  }
  const candidate = {
    version: LOCAL_SESSION_BINDING_VERSION,
    sessionId: options.sessionId,
    repository: options.repository,
    task: options.task,
    capabilities: options.capabilities,
    authority: {
      id: authority.id,
      publicKeyFingerprint: delegatorPublicKeyFingerprint(authority.key),
    },
    iat,
    nbf: iat,
    exp,
    signature: "",
    ...(options.branchObservation === undefined ? {} : { branchObservation: options.branchObservation }),
  };
  const unsignedValidation = validateLocalSessionBinding({ ...candidate, signature: "A".repeat(86) });
  if (!unsignedValidation.valid || unsignedValidation.value === undefined) {
    throw new LocalSessionBindingError("LOCAL_SESSION_BINDING_INVALID_INPUT", "Session binding claims are invalid.");
  }
  const payload = {
    version: unsignedValidation.value.version,
    sessionId: unsignedValidation.value.sessionId,
    repository: unsignedValidation.value.repository,
    task: unsignedValidation.value.task,
    capabilities: unsignedValidation.value.capabilities,
    authority: unsignedValidation.value.authority,
    iat: unsignedValidation.value.iat,
    nbf: unsignedValidation.value.nbf,
    exp: unsignedValidation.value.exp,
    ...(unsignedValidation.value.branchObservation === undefined
      ? {}
      : { branchObservation: unsignedValidation.value.branchObservation }),
  } as Omit<LocalSessionBinding, "signature">;
  for (const claim of unsignedValidation.value.capabilities) {
    if (!capabilityClaimWithinCeiling(claim, authority.capabilityCeiling)) {
      throw new LocalSessionBindingError(
        "LOCAL_SESSION_BINDING_CAPABILITY_EXCEEDS_CEILING",
        "Session capability exceeds the Authority ceiling.",
      );
    }
  }
  const privateKey = runtimePrivateKey(options.runtimeKey);
  if (
    typeof privateKey !== "object" ||
    privateKey === null ||
    privateKey.type !== "private" ||
    privateKey.asymmetricKeyType !== "ed25519"
  ) {
    throw new LocalSessionBindingError(
      "LOCAL_SESSION_BINDING_SIGNING_KEY_INVALID",
      "Runtime signing key must be an Ed25519 private key.",
    );
  }
  let publicKey: Ed25519PublicJwk;
  try {
    publicKey = exportDelegatorPublicKey(privateKey);
  } catch {
    throw new LocalSessionBindingError("LOCAL_SESSION_BINDING_SIGNING_KEY_INVALID", "Runtime signing key is invalid.");
  }
  if (publicKey.x !== authority.key.x) {
    throw new LocalSessionBindingError(
      "LOCAL_SESSION_BINDING_SIGNING_KEY_MISMATCH",
      "Runtime signing key does not match the trusted Authority.",
    );
  }
  let signature: string;
  try {
    signature = ed25519Sign(null, Buffer.from(signingInput(unsignedValidation.value), "utf8"), privateKey).toString(
      "base64url",
    );
  } catch {
    throw new LocalSessionBindingError(
      "LOCAL_SESSION_BINDING_SIGNING_FAILED",
      "Runtime failed to sign the Session binding.",
    );
  }
  const bindingValidation = validateLocalSessionBinding({ ...payload, signature });
  if (!bindingValidation.valid || bindingValidation.value === undefined) {
    throw new LocalSessionBindingError(
      "LOCAL_SESSION_BINDING_SIGNING_FAILED",
      "Runtime produced an invalid Session binding.",
    );
  }
  return bindingValidation.value;
}

/** Verify canonical structure, trust identity, current Authority status, and the Ed25519 signature. */
export function verifyLocalSessionBinding(
  input: unknown,
  runtimeAuthorityInput: Delegator,
  options: { readonly now?: Date } = {},
): LocalSessionBindingVerificationResult {
  const validation = validateLocalSessionBinding(input);
  if (!validation.valid || validation.value === undefined) return validation;
  let authority: Delegator;
  try {
    authority = assertDelegator(runtimeAuthorityInput);
  } catch {
    return Object.freeze({
      valid: false,
      diagnostics: Object.freeze([
        diagnostic("LOCAL_SESSION_BINDING_TRUST_MISMATCH", "Runtime Authority trust record is invalid."),
      ]),
    });
  }
  const binding = validation.value;
  if (
    binding.authority.id !== authority.id ||
    binding.authority.publicKeyFingerprint !== delegatorPublicKeyFingerprint(authority.key)
  ) {
    return Object.freeze({
      valid: false,
      diagnostics: Object.freeze([
        diagnostic("LOCAL_SESSION_BINDING_TRUST_MISMATCH", "Runtime Authority does not match the Session binding."),
      ]),
    });
  }
  const now = options.now ?? new Date();
  let nowSeconds: number;
  try {
    nowSeconds = unixSeconds(now);
  } catch {
    return Object.freeze({
      valid: false,
      diagnostics: Object.freeze([diagnostic("LOCAL_SESSION_BINDING_INVALID", "Verification clock is invalid.")]),
    });
  }
  if (!isDelegatorActive(authority, now)) {
    return Object.freeze({
      valid: false,
      diagnostics: Object.freeze([
        diagnostic("LOCAL_SESSION_BINDING_AUTHORITY_INACTIVE", "Runtime Authority is not active."),
      ]),
    });
  }
  if (
    binding.nbf !== binding.iat ||
    binding.exp - binding.iat > authority.maxSessionTtlSeconds ||
    (authority.notAfter !== null && binding.exp * 1000 > Date.parse(authority.notAfter)) ||
    binding.iat * 1000 < Date.parse(authority.notBefore)
  ) {
    return Object.freeze({
      valid: false,
      diagnostics: Object.freeze([
        diagnostic("LOCAL_SESSION_BINDING_TTL_EXCEEDS_CEILING", "Session validity exceeds the Authority ceiling."),
      ]),
    });
  }
  for (const claim of binding.capabilities) {
    if (!capabilityClaimWithinCeiling(claim, authority.capabilityCeiling)) {
      return Object.freeze({
        valid: false,
        diagnostics: Object.freeze([
          diagnostic(
            "LOCAL_SESSION_BINDING_CAPABILITY_EXCEEDS_CEILING",
            "Session capability exceeds the Authority ceiling.",
          ),
        ]),
      });
    }
  }
  if (nowSeconds < binding.nbf) {
    return Object.freeze({
      valid: false,
      diagnostics: Object.freeze([
        diagnostic("LOCAL_SESSION_BINDING_NOT_YET_VALID", "Session binding is not yet valid."),
      ]),
    });
  }
  let signatureValid = false;
  try {
    signatureValid = ed25519Verify(
      null,
      Buffer.from(signingInput(binding), "utf8"),
      createPublicKey({ key: authority.key, format: "jwk" }),
      Buffer.from(binding.signature, "base64url"),
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    return Object.freeze({
      valid: false,
      diagnostics: Object.freeze([
        diagnostic("LOCAL_SESSION_BINDING_SIGNATURE_INVALID", "Session binding signature is invalid."),
      ]),
    });
  }
  return Object.freeze({
    valid: true,
    value: binding,
    status: nowSeconds >= binding.exp ? "expired" : "active",
    diagnostics: Object.freeze([]),
  });
}
