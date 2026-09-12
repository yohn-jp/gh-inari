/**
 * Transport-independent V1 Session proof-of-possession request envelope.
 *
 * The envelope is deliberately the only owner of the request signing format:
 * semantic request -> RFC 8785 JCS -> SHA-256 lowercase hexadecimal digest ->
 * the exact `INARI-REQUEST-V1` line format. A ManagedSession signs only the
 * resulting bytes through its public `sign(Uint8Array)` seam.
 *
 * This module verifies the request proof and the structural/canonical shape of
 * the Session Certificate. Runtime trust lookup and Runtime signature
 * verification remain later admission responsibilities.
 */

import { createHash, createPublicKey, verify as ed25519Verify } from "node:crypto";
import { base64UrlDecodeToBytes, base64UrlEncodeBytes } from "./codec.js";
import {
  decodeSessionCertificateCompact,
  encodeSessionCertificateCompact,
  MAX_UNIX_TIME_SECONDS,
  type DecodedSessionCertificate,
  type SessionCertificatePayload,
} from "./session-certificate.js";
import { MAX_MANAGED_SESSION_SIGN_INPUT_BYTES } from "./session-issuance.js";
import type { ManagedSession, ManagedSessionCertificate } from "./session-issuance.js";

export const SESSION_REQUEST_ENVELOPE_VERSION = 1 as const;
export type SessionRequestEnvelopeVersion = typeof SESSION_REQUEST_ENVELOPE_VERSION;

/** The only V1 request signature algorithm. */
export const SESSION_REQUEST_ALGORITHM = "EdDSA" as const;
export const SESSION_REQUEST_DOMAIN = "INARI-REQUEST-V1" as const;

/** Maximum canonical semantic-request UTF-8 size accepted by the V1 seam. */
export const MAX_SESSION_REQUEST_BYTES = 64 * 1024;
/** A request is a short freshness proof, not a durable replay-consumption record. */
export const MAX_SESSION_REQUEST_TTL_SECONDS = 300;
export const MAX_SESSION_REQUEST_ID_LENGTH = 128;
export const MAX_SESSION_OPERATION_LENGTH = 128;

const REQUEST_KEYS = new Set([
  "version",
  "alg",
  "certificate",
  "request",
  "certificateJti",
  "repositoryId",
  "operation",
  "requestId",
  "issuedAt",
  "expiresAt",
  "signature",
]);
const REPOSITORY_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;
const LINE_TOKEN_PATTERN = /^[\x21-\x7e]+$/u;
const MAX_CANONICAL_JSON_DEPTH = 32;

/** JSON values accepted as a semantic request. The root request must be an object. */
export type SessionRequestJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly SessionRequestJsonValue[]
  | { readonly [key: string]: SessionRequestJsonValue };

export type SemanticSessionRequest = { readonly [key: string]: SessionRequestJsonValue };

export interface SessionRequestEnvelope {
  readonly version: SessionRequestEnvelopeVersion;
  readonly alg: typeof SESSION_REQUEST_ALGORITHM;
  /** Canonical compact JWS Session Certificate from #367. */
  readonly certificate: string;
  /** The semantic request object; transport fields must not be placed here. */
  readonly request: SemanticSessionRequest;
  readonly certificateJti: string;
  readonly repositoryId: string;
  readonly operation: string;
  readonly requestId: string;
  /** Unix timestamp in whole seconds. */
  readonly issuedAt: number;
  /** Unix timestamp in whole seconds, strictly after issuedAt. */
  readonly expiresAt: number;
  /** Unpadded base64url Ed25519 signature over the exact V1 signing bytes. */
  readonly signature: string;
}

export interface SessionRequestSigningFields {
  readonly certificateJti: string;
  readonly repositoryId: string;
  readonly operation: string;
  readonly request: SemanticSessionRequest;
  readonly requestId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface SessionRequestSigningInput {
  /** JCS UTF-8 text before hashing. */
  readonly canonicalRequest: string;
  /** Lowercase hexadecimal SHA-256 of canonicalRequest's UTF-8 bytes. */
  readonly requestDigest: string;
  /** Exact domain-separated UTF-8 text signed by the Session. */
  readonly signingInput: string;
  /** Exact bytes corresponding to signingInput; no trailing newline. */
  readonly signingInputBytes: Uint8Array;
}

export interface SignSessionRequestOptions {
  readonly session: ManagedSession;
  /** Defaults to the certificate accepted by session. */
  readonly certificate?: ManagedSessionCertificate;
  readonly request: SemanticSessionRequest;
  readonly operation: string;
  readonly requestId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  /** Optional assertions; the certificate remains the source of truth. */
  readonly certificateJti?: string;
  readonly repositoryId?: string;
}

export type SessionRequestDiagnosticCode =
  | "SESSION_REQUEST_INVALID_ROOT"
  | "SESSION_REQUEST_MISSING_PROPERTY"
  | "SESSION_REQUEST_UNKNOWN_PROPERTY"
  | "SESSION_REQUEST_UNSUPPORTED_VERSION"
  | "SESSION_REQUEST_INVALID_ALGORITHM"
  | "SESSION_REQUEST_INVALID_CERTIFICATE"
  | "SESSION_REQUEST_INVALID_REQUEST"
  | "SESSION_REQUEST_INVALID_CERTIFICATE_JTI"
  | "SESSION_REQUEST_INVALID_REPOSITORY_ID"
  | "SESSION_REQUEST_INVALID_OPERATION"
  | "SESSION_REQUEST_INVALID_REQUEST_ID"
  | "SESSION_REQUEST_INVALID_TIMESTAMP"
  | "SESSION_REQUEST_INVALID_SIGNATURE"
  | "SESSION_REQUEST_CERTIFICATE_JTI_MISMATCH"
  | "SESSION_REQUEST_REPOSITORY_MISMATCH"
  | "SESSION_REQUEST_SESSION_KEY_MISMATCH"
  | "SESSION_REQUEST_SESSION_SUBJECT_MISMATCH"
  | "SESSION_REQUEST_CERTIFICATE_TIME_MISMATCH"
  | "SESSION_REQUEST_FRESHNESS_INVALID"
  | "SESSION_REQUEST_EXPIRED"
  | "SESSION_REQUEST_NOT_YET_VALID"
  | "SESSION_REQUEST_SIGNATURE_INVALID";

export interface SessionRequestDiagnostic {
  readonly code: SessionRequestDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface SessionRequestValidationResult<T> {
  readonly valid: boolean;
  readonly value?: T;
  readonly diagnostics: readonly SessionRequestDiagnostic[];
}

export interface VerifiedSessionRequest {
  readonly envelope: SessionRequestEnvelope;
  readonly certificate: DecodedSessionCertificate;
  readonly requestDigest: string;
  readonly signingInput: string;
  readonly signingInputBytes: Uint8Array;
}

export interface VerifySessionRequestOptions {
  /** Verification time as Unix whole seconds or a Date; defaults to current time. */
  readonly now?: number | Date;
}

export interface SessionRequestVerificationResult {
  readonly valid: boolean;
  readonly value?: VerifiedSessionRequest;
  readonly diagnostics: readonly SessionRequestDiagnostic[];
}

export class SessionRequestEnvelopeError extends Error {
  readonly diagnostics: readonly SessionRequestDiagnostic[];

  constructor(message: string, diagnostics: readonly SessionRequestDiagnostic[]) {
    super(message);
    this.name = "SessionRequestEnvelopeError";
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function diagnostic(code: SessionRequestDiagnosticCode, path: string, message: string): SessionRequestDiagnostic {
  return { code, path, message };
}

function requireProperty(
  input: Record<string, unknown>,
  key: string,
  diagnostics: SessionRequestDiagnostic[],
): boolean {
  if (key in input) return true;
  diagnostics.push(diagnostic("SESSION_REQUEST_MISSING_PROPERTY", `$.${key}`, "Property is required."));
  return false;
}

function addUnknownProperties(input: Record<string, unknown>, diagnostics: SessionRequestDiagnostic[]): void {
  for (const key of Object.keys(input).sort()) {
    if (!REQUEST_KEYS.has(key)) {
      diagnostics.push(diagnostic("SESSION_REQUEST_UNKNOWN_PROPERTY", `$.${key}`, "Property is not accepted."));
    }
  }
}

function isLineToken(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maximumLength && LINE_TOKEN_PATTERN.test(value)
  );
}

function isUnixTime(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_UNIX_TIME_SECONDS;
}

function compareUtf16CodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const LONE_SURROGATE_PATTERN = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;

function assertNoLoneSurrogates(value: string, description: string): void {
  if (LONE_SURROGATE_PATTERN.test(value)) {
    throw new TypeError(
      `Semantic request ${description} contains an unpaired UTF-16 surrogate, which RFC 8785 forbids.`,
    );
  }
}

function serializeJcsString(value: string): string {
  assertNoLoneSurrogates(value, "string value");
  return JSON.stringify(value);
}

function serializeJcs(value: unknown, depth: number, ancestors: Set<object>): string {
  if (depth > MAX_CANONICAL_JSON_DEPTH) {
    throw new TypeError(`Semantic request exceeds the maximum nesting depth of ${MAX_CANONICAL_JSON_DEPTH}.`);
  }
  if (value === null) return "null";
  if (typeof value === "string") return serializeJcsString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Semantic request contains a non-finite number.");
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("Semantic request contains an unsupported number.");
    return serialized;
  }
  if (typeof value !== "object" || value === undefined) {
    throw new TypeError("Semantic request contains a value that is not JSON-compatible.");
  }
  if (ancestors.has(value)) throw new TypeError("Semantic request must not contain cyclic references.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new TypeError("Semantic request arrays must not contain holes.");
        }
        entries.push(serializeJcs(value[index], depth + 1, ancestors));
      }
      return `[${entries.join(",")}]`;
    }
    if (!isRecord(value)) throw new TypeError("Semantic request contains a non-plain object.");
    const keys = Object.keys(value).sort(compareUtf16CodeUnits);
    return `{${keys.map((key) => `${serializeJcsString(key)}:${serializeJcs(value[key], depth + 1, ancestors)}`).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function deepFreezeJson(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) {
    for (const entry of value) deepFreezeJson(entry);
  } else if (isRecord(value)) {
    for (const entry of Object.values(value)) deepFreezeJson(entry);
  }
  return Object.freeze(value);
}

function normalizeSemanticRequest(input: unknown): {
  readonly request: SemanticSessionRequest;
  readonly canonical: string;
} {
  if (!isRecord(input)) throw new TypeError("Semantic request must be a plain JSON object.");
  const canonical = serializeJcs(input, 0, new Set<object>());
  const bytes = Buffer.byteLength(canonical, "utf8");
  if (bytes > MAX_SESSION_REQUEST_BYTES) {
    throw new TypeError(`Semantic request exceeds ${MAX_SESSION_REQUEST_BYTES} UTF-8 bytes.`);
  }
  const normalized = deepFreezeJson(JSON.parse(canonical)) as SemanticSessionRequest;
  return { request: normalized, canonical };
}

/** Return the one RFC 8785 JCS representation used by the V1 request digest. */
export function canonicalizeSemanticRequest(input: unknown): string {
  return normalizeSemanticRequest(input).canonical;
}

/** Hash canonical semantic-request UTF-8 bytes with SHA-256 as lowercase hex. */
export function semanticRequestDigest(input: unknown): string {
  const canonical = normalizeSemanticRequest(input).canonical;
  return createHash("sha256").update(Buffer.from(canonical, "utf8")).digest("hex");
}

function assertCommonSigningFields(fields: SessionRequestSigningFields): void {
  const diagnostics: SessionRequestDiagnostic[] = [];
  if (!isLineToken(fields.certificateJti, MAX_SESSION_REQUEST_ID_LENGTH)) {
    diagnostics.push(
      diagnostic(
        "SESSION_REQUEST_INVALID_CERTIFICATE_JTI",
        "$.certificateJti",
        "certificateJti must be a bounded ASCII token.",
      ),
    );
  }
  if (!REPOSITORY_ID_PATTERN.test(fields.repositoryId)) {
    diagnostics.push(
      diagnostic(
        "SESSION_REQUEST_INVALID_REPOSITORY_ID",
        "$.repositoryId",
        "repositoryId must be a positive decimal ID.",
      ),
    );
  }
  if (!isLineToken(fields.operation, MAX_SESSION_OPERATION_LENGTH)) {
    diagnostics.push(
      diagnostic("SESSION_REQUEST_INVALID_OPERATION", "$.operation", "operation must be a bounded ASCII token."),
    );
  }
  if (!isLineToken(fields.requestId, MAX_SESSION_REQUEST_ID_LENGTH)) {
    diagnostics.push(
      diagnostic("SESSION_REQUEST_INVALID_REQUEST_ID", "$.requestId", "requestId must be a bounded ASCII token."),
    );
  }
  if (!isUnixTime(fields.issuedAt)) {
    diagnostics.push(
      diagnostic("SESSION_REQUEST_INVALID_TIMESTAMP", "$.issuedAt", "issuedAt must be a bounded Unix timestamp."),
    );
  }
  if (!isUnixTime(fields.expiresAt)) {
    diagnostics.push(
      diagnostic("SESSION_REQUEST_INVALID_TIMESTAMP", "$.expiresAt", "expiresAt must be a bounded Unix timestamp."),
    );
  }
  if (isUnixTime(fields.issuedAt) && isUnixTime(fields.expiresAt)) {
    if (fields.expiresAt <= fields.issuedAt || fields.expiresAt - fields.issuedAt > MAX_SESSION_REQUEST_TTL_SECONDS) {
      diagnostics.push(
        diagnostic(
          "SESSION_REQUEST_FRESHNESS_INVALID",
          "$.expiresAt",
          `Request freshness window must be 1-${MAX_SESSION_REQUEST_TTL_SECONDS} seconds.`,
        ),
      );
    }
  }
  if (diagnostics.length > 0)
    throw new SessionRequestEnvelopeError("Session request signing fields are invalid.", diagnostics);
}

/** Build the exact bytes shared by signer and verifier. There is no trailing newline. */
export function sessionRequestSigningInput(fields: SessionRequestSigningFields): SessionRequestSigningInput {
  assertCommonSigningFields(fields);
  const { canonical } = normalizeSemanticRequest(fields.request);
  const requestDigest = createHash("sha256").update(Buffer.from(canonical, "utf8")).digest("hex");
  const signingInput = [
    SESSION_REQUEST_DOMAIN,
    fields.certificateJti,
    fields.repositoryId,
    fields.operation,
    requestDigest,
    fields.requestId,
    String(fields.issuedAt),
    String(fields.expiresAt),
  ].join("\n");
  const signingInputBytes = Uint8Array.from(Buffer.from(signingInput, "utf8"));
  if (signingInputBytes.byteLength > MAX_MANAGED_SESSION_SIGN_INPUT_BYTES) {
    throw new SessionRequestEnvelopeError("Session request signing input is too large.", [
      diagnostic(
        "SESSION_REQUEST_INVALID_REQUEST",
        "$.request",
        "Signing input exceeds the ManagedSession seam bound.",
      ),
    ]);
  }
  return { canonicalRequest: canonical, requestDigest, signingInput, signingInputBytes };
}

function certificateCompact(value: ManagedSessionCertificate): string {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.compact === "string") return value.compact;
  throw new TypeError("Session Certificate must be a canonical compact certificate.");
}

function compactFromDecoded(certificate: DecodedSessionCertificate): string {
  return encodeSessionCertificateCompact(certificate.header, certificate.payload, certificate.signature);
}

function publicKeysMatch(left: SessionCertificatePayload["sessionKey"], right: ManagedSession["publicKey"]): boolean {
  return left.kty === right.kty && left.crv === right.crv && left.x === right.x;
}

function decodeCertificate(
  compact: unknown,
):
  | { readonly valid: true; readonly compact: string; readonly certificate: DecodedSessionCertificate }
  | { readonly valid: false; readonly diagnostics: readonly SessionRequestDiagnostic[] } {
  const decoded = decodeSessionCertificateCompact(compact);
  if (!decoded.valid || decoded.value === undefined) {
    return {
      valid: false,
      diagnostics: decoded.diagnostics.map((entry) =>
        diagnostic("SESSION_REQUEST_INVALID_CERTIFICATE", entry.path, entry.message),
      ),
    };
  }
  try {
    const canonicalSignature = base64UrlEncodeBytes(base64UrlDecodeToBytes(decoded.value.signature));
    if (canonicalSignature !== decoded.value.signature) {
      return {
        valid: false,
        diagnostics: [
          diagnostic(
            "SESSION_REQUEST_INVALID_CERTIFICATE",
            "$.certificate.signature",
            "Session Certificate signature encoding is not canonical.",
          ),
        ],
      };
    }
  } catch {
    return {
      valid: false,
      diagnostics: [
        diagnostic(
          "SESSION_REQUEST_INVALID_CERTIFICATE",
          "$.certificate.signature",
          "Session Certificate signature encoding is invalid.",
        ),
      ],
    };
  }
  return { valid: true, compact: compact as string, certificate: decoded.value };
}

function signerCertificate(
  session: ManagedSession,
  provided: ManagedSessionCertificate | undefined,
): { readonly compact: string; readonly certificate: DecodedSessionCertificate } {
  let compact: string;
  if (provided !== undefined) {
    compact = certificateCompact(provided);
  } else if (session.certificate !== undefined) {
    compact = compactFromDecoded(session.certificate);
  } else {
    throw new SessionRequestEnvelopeError("Managed Session has not accepted a Session Certificate.", [
      diagnostic(
        "SESSION_REQUEST_INVALID_CERTIFICATE",
        "$.certificate",
        "A Session Certificate is required before signing.",
      ),
    ]);
  }
  const decoded = decodeCertificate(compact);
  if (!decoded.valid) throw new SessionRequestEnvelopeError("Session Certificate is invalid.", decoded.diagnostics);
  if (!publicKeysMatch(decoded.certificate.payload.sessionKey, session.publicKey)) {
    throw new SessionRequestEnvelopeError("Session Certificate public key does not identify this Session.", [
      diagnostic(
        "SESSION_REQUEST_SESSION_KEY_MISMATCH",
        "$.certificate.payload.sessionKey",
        "Session Certificate substitution rejected.",
      ),
    ]);
  }
  if (decoded.certificate.payload.sub !== `session:${session.sessionId}`) {
    throw new SessionRequestEnvelopeError("Session Certificate subject does not identify this Session.", [
      diagnostic(
        "SESSION_REQUEST_SESSION_SUBJECT_MISMATCH",
        "$.certificate.payload.sub",
        "Session Certificate substitution rejected.",
      ),
    ]);
  }
  return decoded;
}

/** Construct and sign a V1 envelope using only ManagedSession.sign(bytes). */
export function signSessionRequest(options: SignSessionRequestOptions): SessionRequestEnvelope {
  const { compact, certificate } = signerCertificate(options.session, options.certificate);
  if (options.certificateJti !== undefined && options.certificateJti !== certificate.payload.jti) {
    throw new SessionRequestEnvelopeError("certificateJti does not match the Session Certificate.", [
      diagnostic(
        "SESSION_REQUEST_CERTIFICATE_JTI_MISMATCH",
        "$.certificateJti",
        "certificateJti substitution rejected.",
      ),
    ]);
  }
  if (options.repositoryId !== undefined && options.repositoryId !== certificate.payload.repository.id) {
    throw new SessionRequestEnvelopeError("repositoryId does not match the Session Certificate.", [
      diagnostic("SESSION_REQUEST_REPOSITORY_MISMATCH", "$.repositoryId", "repositoryId substitution rejected."),
    ]);
  }
  const fields: SessionRequestSigningFields = {
    certificateJti: certificate.payload.jti,
    repositoryId: certificate.payload.repository.id,
    operation: options.operation,
    request: options.request,
    requestId: options.requestId,
    issuedAt: options.issuedAt,
    expiresAt: options.expiresAt,
  };
  const input = sessionRequestSigningInput(fields);
  const signature = options.session.sign(input.signingInputBytes);
  if (!(signature instanceof Uint8Array) || signature.byteLength !== 64) {
    throw new SessionRequestEnvelopeError("ManagedSession.sign returned an invalid Ed25519 signature.", [
      diagnostic("SESSION_REQUEST_INVALID_SIGNATURE", "$.signature", "Signature must contain 64 raw bytes."),
    ]);
  }
  const normalizedRequest = JSON.parse(input.canonicalRequest) as SemanticSessionRequest;
  deepFreezeJson(normalizedRequest);
  return Object.freeze({
    version: SESSION_REQUEST_ENVELOPE_VERSION,
    alg: SESSION_REQUEST_ALGORITHM,
    certificate: compact,
    request: normalizedRequest,
    certificateJti: certificate.payload.jti,
    repositoryId: certificate.payload.repository.id,
    operation: options.operation,
    requestId: options.requestId,
    issuedAt: options.issuedAt,
    expiresAt: options.expiresAt,
    signature: base64UrlEncodeBytes(signature),
  });
}

function validateEnvelopeShape(input: unknown): SessionRequestValidationResult<SessionRequestEnvelope> {
  const diagnostics: SessionRequestDiagnostic[] = [];
  if (!isRecord(input)) {
    return {
      valid: false,
      diagnostics: [diagnostic("SESSION_REQUEST_INVALID_ROOT", "$", "Request envelope must be an object.")],
    };
  }
  addUnknownProperties(input, diagnostics);
  if (requireProperty(input, "version", diagnostics) && input.version !== SESSION_REQUEST_ENVELOPE_VERSION) {
    diagnostics.push(
      diagnostic(
        "SESSION_REQUEST_UNSUPPORTED_VERSION",
        "$.version",
        "Session request envelope version is unsupported.",
      ),
    );
  }
  if (requireProperty(input, "alg", diagnostics) && input.alg !== SESSION_REQUEST_ALGORITHM) {
    diagnostics.push(
      diagnostic("SESSION_REQUEST_INVALID_ALGORITHM", "$.alg", `alg must be "${SESSION_REQUEST_ALGORITHM}".`),
    );
  }

  let certificate: string | undefined;
  let decodedCertificate: DecodedSessionCertificate | undefined;
  if (requireProperty(input, "certificate", diagnostics)) {
    const decoded = decodeCertificate(input.certificate);
    if (!decoded.valid) diagnostics.push(...decoded.diagnostics);
    else {
      certificate = decoded.compact;
      decodedCertificate = decoded.certificate;
    }
  }

  let request: SemanticSessionRequest | undefined;
  if (requireProperty(input, "request", diagnostics)) {
    try {
      request = normalizeSemanticRequest(input.request).request;
    } catch (error: unknown) {
      diagnostics.push(
        diagnostic(
          "SESSION_REQUEST_INVALID_REQUEST",
          "$.request",
          error instanceof Error ? error.message : "request must be a canonicalizable JSON object.",
        ),
      );
    }
  }

  let certificateJti: string | undefined;
  if (requireProperty(input, "certificateJti", diagnostics)) {
    if (!isLineToken(input.certificateJti, MAX_SESSION_REQUEST_ID_LENGTH)) {
      diagnostics.push(
        diagnostic(
          "SESSION_REQUEST_INVALID_CERTIFICATE_JTI",
          "$.certificateJti",
          "certificateJti must be a bounded ASCII token.",
        ),
      );
    } else certificateJti = input.certificateJti;
  }
  let repositoryId: string | undefined;
  if (requireProperty(input, "repositoryId", diagnostics)) {
    if (typeof input.repositoryId !== "string" || !REPOSITORY_ID_PATTERN.test(input.repositoryId)) {
      diagnostics.push(
        diagnostic(
          "SESSION_REQUEST_INVALID_REPOSITORY_ID",
          "$.repositoryId",
          "repositoryId must be a positive decimal ID.",
        ),
      );
    } else repositoryId = input.repositoryId;
  }
  let operation: string | undefined;
  if (requireProperty(input, "operation", diagnostics)) {
    if (!isLineToken(input.operation, MAX_SESSION_OPERATION_LENGTH)) {
      diagnostics.push(
        diagnostic("SESSION_REQUEST_INVALID_OPERATION", "$.operation", "operation must be a bounded ASCII token."),
      );
    } else operation = input.operation;
  }
  let requestId: string | undefined;
  if (requireProperty(input, "requestId", diagnostics)) {
    if (!isLineToken(input.requestId, MAX_SESSION_REQUEST_ID_LENGTH)) {
      diagnostics.push(
        diagnostic("SESSION_REQUEST_INVALID_REQUEST_ID", "$.requestId", "requestId must be a bounded ASCII token."),
      );
    } else requestId = input.requestId;
  }
  let issuedAt: number | undefined;
  if (requireProperty(input, "issuedAt", diagnostics)) {
    if (!isUnixTime(input.issuedAt)) {
      diagnostics.push(
        diagnostic("SESSION_REQUEST_INVALID_TIMESTAMP", "$.issuedAt", "issuedAt must be a bounded Unix timestamp."),
      );
    } else issuedAt = input.issuedAt;
  }
  let expiresAt: number | undefined;
  if (requireProperty(input, "expiresAt", diagnostics)) {
    if (!isUnixTime(input.expiresAt)) {
      diagnostics.push(
        diagnostic("SESSION_REQUEST_INVALID_TIMESTAMP", "$.expiresAt", "expiresAt must be a bounded Unix timestamp."),
      );
    } else expiresAt = input.expiresAt;
  }
  if (issuedAt !== undefined && expiresAt !== undefined) {
    if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_SESSION_REQUEST_TTL_SECONDS) {
      diagnostics.push(
        diagnostic(
          "SESSION_REQUEST_FRESHNESS_INVALID",
          "$.expiresAt",
          `Request freshness window must be 1-${MAX_SESSION_REQUEST_TTL_SECONDS} seconds.`,
        ),
      );
    }
  }

  let signature: string | undefined;
  if (requireProperty(input, "signature", diagnostics)) {
    try {
      const bytes = typeof input.signature === "string" ? base64UrlDecodeToBytes(input.signature) : undefined;
      if (
        typeof input.signature !== "string" ||
        bytes === undefined ||
        bytes.byteLength !== 64 ||
        base64UrlEncodeBytes(bytes) !== input.signature
      ) {
        throw new TypeError("Signature must be canonical unpadded base64url encoding of 64 raw bytes.");
      }
      signature = input.signature;
    } catch (error: unknown) {
      diagnostics.push(
        diagnostic(
          "SESSION_REQUEST_INVALID_SIGNATURE",
          "$.signature",
          error instanceof Error ? error.message : "Signature is invalid.",
        ),
      );
    }
  }

  if (
    decodedCertificate !== undefined &&
    certificateJti !== undefined &&
    certificateJti !== decodedCertificate.payload.jti
  ) {
    diagnostics.push(
      diagnostic(
        "SESSION_REQUEST_CERTIFICATE_JTI_MISMATCH",
        "$.certificateJti",
        "certificateJti must match the decoded Session Certificate.",
      ),
    );
  }
  if (
    decodedCertificate !== undefined &&
    repositoryId !== undefined &&
    repositoryId !== decodedCertificate.payload.repository.id
  ) {
    diagnostics.push(
      diagnostic(
        "SESSION_REQUEST_REPOSITORY_MISMATCH",
        "$.repositoryId",
        "repositoryId must match the decoded Session Certificate.",
      ),
    );
  }

  if (
    diagnostics.length > 0 ||
    certificate === undefined ||
    decodedCertificate === undefined ||
    request === undefined ||
    certificateJti === undefined ||
    repositoryId === undefined ||
    operation === undefined ||
    requestId === undefined ||
    issuedAt === undefined ||
    expiresAt === undefined ||
    signature === undefined
  ) {
    return { valid: false, diagnostics };
  }
  return {
    valid: true,
    value: Object.freeze({
      version: SESSION_REQUEST_ENVELOPE_VERSION,
      alg: SESSION_REQUEST_ALGORITHM,
      certificate,
      request,
      certificateJti,
      repositoryId,
      operation,
      requestId,
      issuedAt,
      expiresAt,
      signature,
    }),
    diagnostics: [],
  };
}

/** Validate the fixed V1 envelope shape and its certificate/request bindings. */
export function validateSessionRequestEnvelope(input: unknown): SessionRequestValidationResult<SessionRequestEnvelope> {
  return validateEnvelopeShape(input);
}

function verificationNow(input: number | Date | undefined): number {
  if (input === undefined) return Math.floor(Date.now() / 1000);
  if (input instanceof Date) {
    const milliseconds = input.getTime();
    if (!Number.isFinite(milliseconds)) throw new RangeError("Verification time must be a valid Date.");
    return Math.floor(milliseconds / 1000);
  }
  if (!isUnixTime(input)) throw new RangeError("Verification time must be a bounded Unix timestamp.");
  return input;
}

/**
 * Verify a signed envelope's PoP and all V1 freshness/binding invariants.
 * This does not consult Runtime trust or a replay seen-set.
 */
export function verifySessionRequest(
  input: unknown,
  options: VerifySessionRequestOptions = {},
): SessionRequestVerificationResult {
  const shape = validateEnvelopeShape(input);
  if (!shape.valid || shape.value === undefined) {
    return { valid: false, diagnostics: shape.diagnostics };
  }
  const envelope = shape.value;
  const decoded = decodeSessionCertificateCompact(envelope.certificate);
  if (!decoded.valid || decoded.value === undefined) {
    return {
      valid: false,
      diagnostics: [diagnostic("SESSION_REQUEST_INVALID_CERTIFICATE", "$.certificate", "Certificate decoding failed.")],
    };
  }
  const certificate = decoded.value;
  const diagnostics: SessionRequestDiagnostic[] = [];
  if (envelope.issuedAt < certificate.payload.iat || envelope.issuedAt < certificate.payload.nbf) {
    diagnostics.push(
      diagnostic(
        "SESSION_REQUEST_CERTIFICATE_TIME_MISMATCH",
        "$.issuedAt",
        "Request issuedAt must not precede the Session Certificate validity window.",
      ),
    );
  }
  if (envelope.expiresAt > certificate.payload.exp) {
    diagnostics.push(
      diagnostic(
        "SESSION_REQUEST_CERTIFICATE_TIME_MISMATCH",
        "$.expiresAt",
        "Request expiresAt must not outlive the Session Certificate.",
      ),
    );
  }
  let now: number;
  try {
    now = verificationNow(options.now);
  } catch (error: unknown) {
    return {
      valid: false,
      diagnostics: [
        diagnostic(
          "SESSION_REQUEST_INVALID_TIMESTAMP",
          "$.now",
          error instanceof Error ? error.message : "Verification time is invalid.",
        ),
      ],
    };
  }
  if (now < envelope.issuedAt || now < certificate.payload.nbf) {
    diagnostics.push(
      diagnostic("SESSION_REQUEST_NOT_YET_VALID", "$.issuedAt", "Request or Session Certificate is not yet valid."),
    );
  }
  if (now >= envelope.expiresAt || now >= certificate.payload.exp) {
    diagnostics.push(
      diagnostic("SESSION_REQUEST_EXPIRED", "$.expiresAt", "Request or Session Certificate is expired."),
    );
  }
  if (diagnostics.length > 0) return { valid: false, diagnostics };

  let signing: SessionRequestSigningInput;
  try {
    signing = sessionRequestSigningInput({
      certificateJti: envelope.certificateJti,
      repositoryId: envelope.repositoryId,
      operation: envelope.operation,
      request: envelope.request,
      requestId: envelope.requestId,
      issuedAt: envelope.issuedAt,
      expiresAt: envelope.expiresAt,
    });
  } catch (error: unknown) {
    return {
      valid: false,
      diagnostics: [
        diagnostic(
          "SESSION_REQUEST_INVALID_REQUEST",
          "$",
          error instanceof Error ? error.message : "Signing input could not be reconstructed.",
        ),
      ],
    };
  }

  let validSignature = false;
  try {
    const publicKey = createPublicKey({ key: certificate.payload.sessionKey, format: "jwk" });
    validSignature = ed25519Verify(
      null,
      signing.signingInputBytes,
      publicKey,
      base64UrlDecodeToBytes(envelope.signature),
    );
  } catch {
    validSignature = false;
  }
  if (!validSignature) {
    return {
      valid: false,
      diagnostics: [
        diagnostic(
          "SESSION_REQUEST_SIGNATURE_INVALID",
          "$.signature",
          "Session signature does not verify against the certificate Session public key.",
        ),
      ],
    };
  }
  const signingInputBytes = Uint8Array.from(signing.signingInputBytes);
  return {
    valid: true,
    value: Object.freeze({
      envelope,
      certificate,
      requestDigest: signing.requestDigest,
      signingInput: signing.signingInput,
      signingInputBytes,
    }),
    diagnostics: [],
  };
}

/** Throwing counterpart for consumers that require a verified result. */
export function assertVerifiedSessionRequest(
  input: unknown,
  options: VerifySessionRequestOptions = {},
): VerifiedSessionRequest {
  const result = verifySessionRequest(input, options);
  if (!result.valid || result.value === undefined) {
    throw new SessionRequestEnvelopeError("Session request verification failed.", result.diagnostics);
  }
  return result.value;
}
