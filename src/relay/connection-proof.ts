/**
 * Transport-only proof that a Runtime connection possesses an Ed25519 key.
 *
 * This module deliberately does not consult Delegator trust, current status,
 * capabilities, or GitHub.  The proof identifies a cryptographic connection;
 * authorization remains in the user-owned Runtime executor.
 */

import {
  createPublicKey,
  randomBytes,
  type KeyObject,
  sign as ed25519Sign,
  verify as ed25519Verify,
} from "node:crypto";
import {
  decodeSessionCertificateCompact,
  type DecodedSessionCertificate,
} from "../agent-authority/session-certificate.js";
import {
  base64UrlDecodeToBytes,
  base64UrlEncodeBytes,
  canonicalJsonString,
  isBase64UrlText,
  type CanonicalJsonValue,
} from "../agent-authority/codec.js";
import { validateEd25519PublicJwk, type Ed25519PublicJwk } from "../agent-authority/ed25519-jwk.js";
import { exportDelegatorPublicKey } from "../agent-authority/delegator-key.js";
import { RELAY_CONTRACT_VERSION } from "./contract.js";

export const RELAY_POSSESSION_PROOF_VERSION = 1 as const;
export type RelayPossessionProofVersion = typeof RELAY_POSSESSION_PROOF_VERSION;
export const MAX_RELAY_POSSESSION_PROOF_TTL_MS = 30_000 as const;
export const MAX_RELAY_POSSESSION_PROOF_NONCE_BYTES = 64 as const;
export const MAX_RELAY_POSSESSION_PROOF_BYTES = 16_384 as const;

const JSON_ENCODER = new TextEncoder();
const DECIMAL_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const DELEGATOR_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;
const NONCE_PATTERN = /^[A-Za-z0-9_-]+$/u;

export interface RelayPossessionProofChallenge {
  readonly version: RelayPossessionProofVersion;
  readonly relayProtocolVersion: number;
  readonly repositoryId: string;
  readonly delegatorId: string;
  readonly nonce: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export interface RelayPossessionProofResponse {
  readonly version: RelayPossessionProofVersion;
  readonly challenge: RelayPossessionProofChallenge;
  readonly publicKey: Ed25519PublicJwk;
  readonly signature: string;
}

export interface RelayConnectionKeyBinding {
  readonly repositoryId: string;
  readonly delegatorId: string;
  readonly publicKey: Ed25519PublicJwk;
}

export type RelayPossessionProofDiagnosticCode =
  | "RELAY_PROOF_INVALID_CHALLENGE"
  | "RELAY_PROOF_INVALID_RESPONSE"
  | "RELAY_PROOF_UNKNOWN_FIELD"
  | "RELAY_PROOF_MISSING_FIELD"
  | "RELAY_PROOF_UNSUPPORTED_VERSION"
  | "RELAY_PROOF_INVALID_REPOSITORY"
  | "RELAY_PROOF_INVALID_DELEGATOR"
  | "RELAY_PROOF_INVALID_NONCE"
  | "RELAY_PROOF_INVALID_TIME"
  | "RELAY_PROOF_INVALID_PROTOCOL_VERSION"
  | "RELAY_PROOF_INVALID_KEY"
  | "RELAY_PROOF_INVALID_SIGNATURE"
  | "RELAY_PROOF_EXPIRED"
  | "RELAY_PROOF_NOT_YET_VALID"
  | "RELAY_PROOF_REPLAYED_NONCE"
  | "RELAY_PROOF_CHALLENGE_MISMATCH"
  | "RELAY_PROOF_REPOSITORY_MISMATCH"
  | "RELAY_PROOF_DELEGATOR_MISMATCH"
  | "RELAY_PROOF_CERTIFICATE_INVALID"
  | "RELAY_PROOF_CERTIFICATE_REPOSITORY_MISMATCH"
  | "RELAY_PROOF_CERTIFICATE_DELEGATOR_MISMATCH"
  | "RELAY_PROOF_REPLAY_STATE_REQUIRED";

export interface RelayPossessionProofDiagnostic {
  readonly code: RelayPossessionProofDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface RelayPossessionProofValidationResult<T> {
  readonly valid: boolean;
  readonly value?: T;
  readonly diagnostics: readonly RelayPossessionProofDiagnostic[];
}

export interface VerifyRelayPossessionProofOptions {
  /** Wall-clock time in milliseconds, injected for deterministic verification. */
  readonly nowMs?: number;
  /** Required nonce cache owned by the relay connection layer. Successful proofs consume a nonce. */
  readonly usedNonces: Set<string>;
}

export interface VerifySessionCertificateConnectionBindingResult {
  readonly valid: boolean;
  readonly certificate?: DecodedSessionCertificate;
  readonly diagnostics: readonly RelayPossessionProofDiagnostic[];
}

function diagnostic(
  code: RelayPossessionProofDiagnosticCode,
  path: string,
  message: string,
): RelayPossessionProofDiagnostic {
  return { code, path, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertClosedObject(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  diagnostics: RelayPossessionProofDiagnostic[],
): void {
  for (const key of Object.keys(value).sort()) {
    if (!allowed.includes(key))
      diagnostics.push(diagnostic("RELAY_PROOF_UNKNOWN_FIELD", `${path}.${key}`, "Field is not accepted."));
  }
}

function requireFields(
  value: Record<string, unknown>,
  required: readonly string[],
  path: string,
  diagnostics: RelayPossessionProofDiagnostic[],
): void {
  for (const key of required) {
    if (!(key in value))
      diagnostics.push(diagnostic("RELAY_PROOF_MISSING_FIELD", `${path}.${key}`, "Field is required."));
  }
}

function normalizeChallenge(input: unknown): RelayPossessionProofValidationResult<RelayPossessionProofChallenge> {
  const diagnostics: RelayPossessionProofDiagnostic[] = [];
  if (!isRecord(input)) {
    return {
      valid: false,
      diagnostics: [diagnostic("RELAY_PROOF_INVALID_CHALLENGE", "$", "Challenge must be a plain object.")],
    };
  }
  const keys = [
    "delegatorId",
    "expiresAtMs",
    "issuedAtMs",
    "nonce",
    "relayProtocolVersion",
    "repositoryId",
    "version",
  ] as const;
  assertClosedObject(input, keys, "$", diagnostics);
  requireFields(input, keys, "$", diagnostics);
  if (input.version !== RELAY_POSSESSION_PROOF_VERSION) {
    diagnostics.push(diagnostic("RELAY_PROOF_UNSUPPORTED_VERSION", "$.version", "Proof version is unsupported."));
  }
  if (input.relayProtocolVersion !== RELAY_CONTRACT_VERSION) {
    diagnostics.push(
      diagnostic(
        "RELAY_PROOF_INVALID_PROTOCOL_VERSION",
        "$.relayProtocolVersion",
        "Relay protocol version is unsupported.",
      ),
    );
  }
  if (typeof input.repositoryId !== "string" || !DECIMAL_ID_PATTERN.test(input.repositoryId)) {
    diagnostics.push(
      diagnostic("RELAY_PROOF_INVALID_REPOSITORY", "$.repositoryId", "Repository ID must be a positive decimal ID."),
    );
  }
  if (typeof input.delegatorId !== "string" || !DELEGATOR_ID_PATTERN.test(input.delegatorId)) {
    diagnostics.push(diagnostic("RELAY_PROOF_INVALID_DELEGATOR", "$.delegatorId", "Delegator ID is invalid."));
  }
  if (
    typeof input.nonce !== "string" ||
    !NONCE_PATTERN.test(input.nonce) ||
    input.nonce.length > Math.ceil((MAX_RELAY_POSSESSION_PROOF_NONCE_BYTES * 4) / 3)
  ) {
    diagnostics.push(
      diagnostic("RELAY_PROOF_INVALID_NONCE", "$.nonce", "Nonce must be bounded unpadded base64url text."),
    );
  }
  if (!Number.isSafeInteger(input.issuedAtMs) || (input.issuedAtMs as number) < 0) {
    diagnostics.push(
      diagnostic("RELAY_PROOF_INVALID_TIME", "$.issuedAtMs", "Issued time must be a non-negative safe integer."),
    );
  }
  if (!Number.isSafeInteger(input.expiresAtMs) || (input.expiresAtMs as number) <= 0) {
    diagnostics.push(
      diagnostic("RELAY_PROOF_INVALID_TIME", "$.expiresAtMs", "Expiry time must be a positive safe integer."),
    );
  }
  if (Number.isSafeInteger(input.issuedAtMs) && Number.isSafeInteger(input.expiresAtMs)) {
    const ttl = (input.expiresAtMs as number) - (input.issuedAtMs as number);
    if (ttl <= 0 || ttl > MAX_RELAY_POSSESSION_PROOF_TTL_MS) {
      diagnostics.push(
        diagnostic("RELAY_PROOF_INVALID_TIME", "$.expiresAtMs", "Challenge lifetime exceeds its bounded ceiling."),
      );
    }
  }
  if (diagnostics.length > 0) return { valid: false, diagnostics };
  return {
    valid: true,
    value: Object.freeze({
      version: RELAY_POSSESSION_PROOF_VERSION,
      relayProtocolVersion: RELAY_CONTRACT_VERSION,
      repositoryId: input.repositoryId as string,
      delegatorId: input.delegatorId as string,
      nonce: input.nonce as string,
      issuedAtMs: input.issuedAtMs as number,
      expiresAtMs: input.expiresAtMs as number,
    }),
    diagnostics: [],
  };
}

function normalizePublicKey(input: unknown): RelayPossessionProofValidationResult<Ed25519PublicJwk> {
  const result = validateEd25519PublicJwk(input, "$.publicKey");
  if (result.valid && result.value !== undefined) return { valid: true, value: result.value, diagnostics: [] };
  return {
    valid: false,
    diagnostics: result.diagnostics.map((entry) => diagnostic("RELAY_PROOF_INVALID_KEY", entry.path, entry.message)),
  };
}

function normalizeResponse(input: unknown): RelayPossessionProofValidationResult<RelayPossessionProofResponse> {
  const diagnostics: RelayPossessionProofDiagnostic[] = [];
  if (!isRecord(input)) {
    return {
      valid: false,
      diagnostics: [diagnostic("RELAY_PROOF_INVALID_RESPONSE", "$", "Response must be a plain object.")],
    };
  }
  const keys = ["challenge", "publicKey", "signature", "version"] as const;
  assertClosedObject(input, keys, "$", diagnostics);
  requireFields(input, keys, "$", diagnostics);
  if (input.version !== RELAY_POSSESSION_PROOF_VERSION) {
    diagnostics.push(diagnostic("RELAY_PROOF_UNSUPPORTED_VERSION", "$.version", "Proof version is unsupported."));
  }
  const challenge = normalizeChallenge(input.challenge);
  diagnostics.push(...challenge.diagnostics);
  const publicKey = normalizePublicKey(input.publicKey);
  diagnostics.push(...publicKey.diagnostics);
  if (!isBase64UrlText(input.signature) || base64UrlDecodeSafely(input.signature).byteLength !== 64) {
    diagnostics.push(
      diagnostic(
        "RELAY_PROOF_INVALID_SIGNATURE",
        "$.signature",
        "Signature must be 64 raw bytes in unpadded base64url.",
      ),
    );
  }
  if (diagnostics.length > 0 || challenge.value === undefined || publicKey.value === undefined) {
    return { valid: false, diagnostics };
  }
  return {
    valid: true,
    value: Object.freeze({
      version: RELAY_POSSESSION_PROOF_VERSION,
      challenge: challenge.value,
      publicKey: publicKey.value,
      signature: input.signature as string,
    }),
    diagnostics: [],
  };
}

function base64UrlDecodeSafely(value: unknown): Buffer {
  if (typeof value !== "string") return Buffer.alloc(0);
  try {
    return base64UrlDecodeToBytes(value);
  } catch {
    return Buffer.alloc(0);
  }
}

function challengeSigningBytes(challenge: RelayPossessionProofChallenge): Uint8Array {
  return JSON_ENCODER.encode(canonicalJsonString(challenge as unknown as CanonicalJsonValue));
}

function challengeKey(challenge: RelayPossessionProofChallenge): string {
  return canonicalJsonString(challenge as unknown as CanonicalJsonValue);
}

export function validateRelayPossessionProofChallenge(
  input: unknown,
): RelayPossessionProofValidationResult<RelayPossessionProofChallenge> {
  return normalizeChallenge(input);
}

export function validateRelayPossessionProofResponse(
  input: unknown,
): RelayPossessionProofValidationResult<RelayPossessionProofResponse> {
  return normalizeResponse(input);
}

export function createRelayPossessionProofChallenge(options: {
  readonly repositoryId: string;
  readonly delegatorId: string;
  readonly nonce?: string;
  readonly issuedAtMs?: number;
  readonly expiresAtMs?: number;
}): RelayPossessionProofChallenge {
  const issuedAtMs = options.issuedAtMs ?? Date.now();
  const expiresAtMs = options.expiresAtMs ?? issuedAtMs + MAX_RELAY_POSSESSION_PROOF_TTL_MS;
  const nonce = options.nonce ?? base64UrlEncodeBytes(cryptoRandomBytes(24));
  const result = normalizeChallenge({
    version: RELAY_POSSESSION_PROOF_VERSION,
    relayProtocolVersion: RELAY_CONTRACT_VERSION,
    repositoryId: options.repositoryId,
    delegatorId: options.delegatorId,
    nonce,
    issuedAtMs,
    expiresAtMs,
  });
  if (!result.valid || result.value === undefined) {
    throw new TypeError(result.diagnostics[0]?.message ?? "Relay possession challenge is invalid.");
  }
  return result.value;
}

function cryptoRandomBytes(size: number): Uint8Array {
  return randomBytes(size);
}

export function signRelayPossessionProof(
  challenge: RelayPossessionProofChallenge,
  privateKey: KeyObject,
): RelayPossessionProofResponse {
  const normalized = normalizeChallenge(challenge);
  if (!normalized.valid || normalized.value === undefined) {
    throw new TypeError(normalized.diagnostics[0]?.message ?? "Relay possession challenge is invalid.");
  }
  const signature = ed25519Sign(null, challengeSigningBytes(normalized.value), privateKey);
  return Object.freeze({
    version: RELAY_POSSESSION_PROOF_VERSION,
    challenge: normalized.value,
    publicKey: exportDelegatorPublicKey(privateKey),
    signature: base64UrlEncodeBytes(signature),
  });
}

export function encodeRelayPossessionProofChallenge(challenge: RelayPossessionProofChallenge): Uint8Array {
  const normalized = normalizeChallenge(challenge);
  if (!normalized.valid || normalized.value === undefined) {
    throw new TypeError(normalized.diagnostics[0]?.message ?? "Relay possession challenge is invalid.");
  }
  return JSON_ENCODER.encode(challengeKey(normalized.value));
}

export function encodeRelayPossessionProofResponse(response: RelayPossessionProofResponse): Uint8Array {
  const normalized = normalizeResponse(response);
  if (!normalized.valid || normalized.value === undefined) {
    throw new TypeError(normalized.diagnostics[0]?.message ?? "Relay possession response is invalid.");
  }
  return JSON_ENCODER.encode(canonicalJsonString(normalized.value as unknown as CanonicalJsonValue));
}

function decodeCanonicalJson(input: string | Uint8Array): unknown {
  const text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
  if (JSON_ENCODER.encode(text).byteLength > MAX_RELAY_POSSESSION_PROOF_BYTES)
    throw new TypeError("Proof exceeds its byte ceiling.");
  const value = JSON.parse(text) as unknown;
  if (canonicalJsonString(value as CanonicalJsonValue) !== text) throw new TypeError("Proof JSON is not canonical.");
  return value;
}

export function decodeRelayPossessionProofChallenge(input: string | Uint8Array): RelayPossessionProofChallenge {
  const result = normalizeChallenge(decodeCanonicalJson(input));
  if (!result.valid || result.value === undefined)
    throw new TypeError(result.diagnostics[0]?.message ?? "Challenge is invalid.");
  return result.value;
}

export function decodeRelayPossessionProofResponse(input: string | Uint8Array): RelayPossessionProofResponse {
  const result = normalizeResponse(decodeCanonicalJson(input));
  if (!result.valid || result.value === undefined)
    throw new TypeError(result.diagnostics[0]?.message ?? "Response is invalid.");
  return result.value;
}

export function verifyRelayPossessionProof(
  expectedChallenge: RelayPossessionProofChallenge,
  response: unknown,
  options: VerifyRelayPossessionProofOptions,
): RelayPossessionProofValidationResult<RelayConnectionKeyBinding> {
  if (!(options?.usedNonces instanceof Set)) {
    return {
      valid: false,
      diagnostics: [
        diagnostic(
          "RELAY_PROOF_REPLAY_STATE_REQUIRED",
          "$.usedNonces",
          "Replay-state participation is required for possession-proof admission.",
        ),
      ],
    };
  }
  const diagnostics: RelayPossessionProofDiagnostic[] = [];
  const expected = normalizeChallenge(expectedChallenge);
  diagnostics.push(...expected.diagnostics);
  const actual = normalizeResponse(response);
  diagnostics.push(...actual.diagnostics);
  if (expected.value !== undefined && actual.value !== undefined) {
    if (challengeKey(expected.value) !== challengeKey(actual.value.challenge)) {
      diagnostics.push(
        diagnostic("RELAY_PROOF_CHALLENGE_MISMATCH", "$.challenge", "Response is for another challenge."),
      );
    }
    const nowMs = options.nowMs ?? Date.now();
    if (!Number.isSafeInteger(nowMs))
      diagnostics.push(diagnostic("RELAY_PROOF_INVALID_TIME", "$.nowMs", "Verification time must be a safe integer."));
    else if (nowMs < expected.value.issuedAtMs)
      diagnostics.push(diagnostic("RELAY_PROOF_NOT_YET_VALID", "$.challenge.issuedAtMs", "Proof is not yet valid."));
    else if (nowMs >= expected.value.expiresAtMs)
      diagnostics.push(diagnostic("RELAY_PROOF_EXPIRED", "$.challenge.expiresAtMs", "Proof has expired."));
    if (options.usedNonces.has(expected.value.nonce))
      diagnostics.push(
        diagnostic("RELAY_PROOF_REPLAYED_NONCE", "$.challenge.nonce", "Proof nonce was already consumed."),
      );
    if (diagnostics.length === 0) {
      try {
        const publicKey = createPublicKey({ key: actual.value.publicKey, format: "jwk" });
        if (
          !ed25519Verify(
            null,
            challengeSigningBytes(expected.value),
            publicKey,
            base64UrlDecodeToBytes(actual.value.signature),
          )
        ) {
          diagnostics.push(
            diagnostic(
              "RELAY_PROOF_INVALID_SIGNATURE",
              "$.signature",
              "Signature does not prove possession of the supplied key.",
            ),
          );
        }
      } catch {
        diagnostics.push(diagnostic("RELAY_PROOF_INVALID_SIGNATURE", "$.signature", "Signature verification failed."));
      }
    }
    if (diagnostics.length === 0) options.usedNonces.add(expected.value.nonce);
  }
  if (diagnostics.length > 0 || expected.value === undefined || actual.value === undefined)
    return { valid: false, diagnostics };
  return {
    valid: true,
    value: Object.freeze({
      repositoryId: expected.value.repositoryId,
      delegatorId: expected.value.delegatorId,
      publicKey: actual.value.publicKey,
    }),
    diagnostics: [],
  };
}

export function verifySessionCertificateConnectionBinding(
  compactCertificate: unknown,
  connection: RelayConnectionKeyBinding,
): VerifySessionCertificateConnectionBindingResult {
  const diagnostics: RelayPossessionProofDiagnostic[] = [];
  const keyResult = normalizePublicKey(connection.publicKey);
  if (!DECIMAL_ID_PATTERN.test(connection.repositoryId))
    diagnostics.push(diagnostic("RELAY_PROOF_INVALID_REPOSITORY", "$.repositoryId", "Repository ID is invalid."));
  if (!DELEGATOR_ID_PATTERN.test(connection.delegatorId))
    diagnostics.push(diagnostic("RELAY_PROOF_INVALID_DELEGATOR", "$.delegatorId", "Delegator ID is invalid."));
  diagnostics.push(...keyResult.diagnostics);
  const certificate = decodeSessionCertificateCompact(compactCertificate);
  if (!certificate.valid || certificate.value === undefined) {
    diagnostics.push(
      diagnostic("RELAY_PROOF_CERTIFICATE_INVALID", "$", "Session Certificate is not canonical or structurally valid."),
    );
    return { valid: false, diagnostics };
  }
  const decoded = certificate.value;
  if (decoded.payload.repository.id !== connection.repositoryId) {
    diagnostics.push(
      diagnostic(
        "RELAY_PROOF_CERTIFICATE_REPOSITORY_MISMATCH",
        "$.payload.repository.id",
        "Certificate belongs to another repository.",
      ),
    );
  }
  if (decoded.header.kid !== connection.delegatorId) {
    diagnostics.push(
      diagnostic(
        "RELAY_PROOF_CERTIFICATE_DELEGATOR_MISMATCH",
        "$.header.kid",
        "Certificate belongs to another Delegator.",
      ),
    );
  }
  if (diagnostics.length === 0 && keyResult.value !== undefined) {
    try {
      const publicKey = createPublicKey({ key: keyResult.value, format: "jwk" });
      if (
        !ed25519Verify(
          null,
          JSON_ENCODER.encode(decoded.signingInput),
          publicKey,
          base64UrlDecodeToBytes(decoded.signature),
        )
      ) {
        diagnostics.push(
          diagnostic(
            "RELAY_PROOF_INVALID_SIGNATURE",
            "$.signature",
            "Certificate signature does not match the proved connection key.",
          ),
        );
      }
    } catch {
      diagnostics.push(
        diagnostic("RELAY_PROOF_INVALID_SIGNATURE", "$.signature", "Certificate signature verification failed."),
      );
    }
  }
  return diagnostics.length > 0
    ? { valid: false, diagnostics }
    : { valid: true, certificate: decoded, diagnostics: [] };
}

export const verifyCanonicalSessionCertificateForConnection = verifySessionCertificateConnectionBinding;
