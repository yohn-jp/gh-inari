/**
 * Managed Agent Session bootstrap and Runtime-signed Session Certificate
 * issuance.
 *
 * The managed boundary is deliberately split into two values:
 *
 * - `ManagedSession` owns the freshly generated private key and exposes only
 *   its public JWK through an issuance request;
 * - `issueSessionCertificate` runs on the Runtime side and accepts a request
 *   containing no private Session material, then signs the existing #367
 *   canonical JWS input with the #368 Runtime key.
 *
 * This module does not package credentials, transport requests, verify App
 * authentication, or integrate a managed Runtime. It only implements the
 * managed bootstrap/delegation boundary needed by those later slices.
 */

import { generateKeyPairSync, sign as ed25519Sign, type KeyObject } from "node:crypto";
import { randomBytes } from "node:crypto";
import {
  MAX_OPAQUE_ID_LENGTH,
  MAX_UNIX_TIME_SECONDS,
  SESSION_CERTIFICATE_ALG,
  SESSION_CERTIFICATE_CONTRACT_VERSION,
  SESSION_CERTIFICATE_TYP,
  decodeSessionCertificateCompact,
  encodeSessionCertificateCompact,
  sessionCertificateSigningInput,
  validateSessionCertificatePayload,
  type DecodedSessionCertificate,
  type SessionCertificateHeader,
  type SessionCertificatePayload,
  type SessionCertificateRepository,
  type SessionCertificateTask,
} from "./session-certificate.js";
import {
  MIN_SESSION_TTL_SECONDS,
  MAX_SESSION_TTL_SECONDS,
  assertRuntimeAuthority,
  isRuntimeAuthorityActive,
  type RuntimeAuthority,
} from "./runtime-authority.js";
import { exportRuntimeAuthorityPublicKey, type RuntimeAuthorityKeyPair } from "./runtime-key.js";
import { assertEd25519PublicJwk, type Ed25519PublicJwk } from "./ed25519-jwk.js";
import { canonicalJsonString, type CanonicalJsonValue } from "./codec.js";
import { capabilityClaimWithinCeiling, type CapabilityClaim } from "./capability.js";

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;
const SESSION_ID_BYTES = 18;
const CERTIFICATE_ID_BYTES = 18;
const VALIDATION_RUNTIME_ID = "session-issuance-validation-runtime";
const VALIDATION_CERTIFICATE_ID = "session-issuance-validation-certificate";

const REQUEST_KEYS = new Set(["sessionId", "sessionKey", "repository", "task", "capabilities", "ttlSeconds"]);

export interface ManagedSessionIssuanceRequestInput {
  readonly repository: SessionCertificateRepository;
  readonly task?: SessionCertificateTask;
  readonly capabilities: readonly CapabilityClaim[];
  /** Requested certificate validity in whole seconds. */
  readonly ttlSeconds: number;
}

/**
 * The only Session value crossing to Runtime during managed issuance.
 * There is intentionally no private-key or KeyObject field in this type.
 */
export interface ManagedSessionIssuanceRequest {
  readonly sessionId: string;
  readonly sessionKey: Ed25519PublicJwk;
  readonly repository: SessionCertificateRepository;
  readonly task?: SessionCertificateTask;
  readonly capabilities: readonly CapabilityClaim[];
  readonly ttlSeconds: number;
}

export type ManagedSessionCertificate = string | IssuedSessionCertificate;

export interface ManagedSession {
  /** Opaque identity bound to the certificate `sub` claim. */
  readonly sessionId: string;
  /** Public-only Ed25519 JWK; the private key is not an object property. */
  readonly publicKey: Ed25519PublicJwk;
  /** The last accepted certificate, if this Session has received one. */
  readonly certificate: DecodedSessionCertificate | undefined;
  /** Sign exactly the supplied bytes with this Session's module-owned key. */
  sign(bytes: Uint8Array): Uint8Array;
  createIssuanceRequest(input: ManagedSessionIssuanceRequestInput): ManagedSessionIssuanceRequest;
  /** Accept only a certificate issued for this exact Session identity/key. */
  acceptCertificate(certificate: ManagedSessionCertificate): DecodedSessionCertificate;
}

/** Maximum raw input accepted by the opaque Session signing seam. */
export const MAX_MANAGED_SESSION_SIGN_INPUT_BYTES = 64 * 1024;

export type ManagedSessionSigningErrorCode = "MANAGED_SESSION_SIGN_INVALID_INPUT";

/** Deterministic, non-secret error for invalid or oversized Session signing input. */
export class ManagedSessionSigningError extends Error {
  readonly code: ManagedSessionSigningErrorCode;

  constructor(code: ManagedSessionSigningErrorCode, message: string) {
    super(message);
    this.name = "ManagedSessionSigningError";
    this.code = code;
  }
}

export type SessionBootstrapErrorCode =
  | "SESSION_BOOTSTRAP_INVALID_SESSION_ID"
  | "SESSION_BOOTSTRAP_INVALID_REQUEST"
  | "SESSION_BOOTSTRAP_INVALID_CERTIFICATE"
  | "SESSION_BOOTSTRAP_CERTIFICATE_SESSION_MISMATCH"
  | "SESSION_BOOTSTRAP_CERTIFICATE_KEY_MISMATCH";

export interface SessionBootstrapDiagnostic {
  readonly code: SessionBootstrapErrorCode;
  readonly path: string;
  readonly message: string;
}

export class SessionBootstrapError extends Error {
  readonly code: SessionBootstrapErrorCode;
  readonly diagnostics: readonly SessionBootstrapDiagnostic[];

  constructor(
    code: SessionBootstrapErrorCode,
    message: string,
    diagnostics: readonly SessionBootstrapDiagnostic[] = [],
  ) {
    super(message);
    this.name = "SessionBootstrapError";
    this.code = code;
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

export interface RuntimeSessionCertificateIssuanceOptions {
  /** Repository identity resolved by the Runtime, not supplied by the Session. */
  readonly repository: SessionCertificateRepository;
  readonly runtimeAuthority: RuntimeAuthority;
  /** #368 Runtime private key or the keypair returned by its machinery. */
  readonly runtimeKey: KeyObject | RuntimeAuthorityKeyPair;
  readonly request: ManagedSessionIssuanceRequest;
  readonly now?: Date;
}

export interface IssuedSessionCertificate {
  /** Canonical three-segment JWS from #367. */
  readonly compact: string;
  readonly header: SessionCertificateHeader;
  readonly payload: SessionCertificatePayload;
  readonly signingInput: string;
  readonly signature: string;
}

export type SessionCertificateIssuanceErrorCode =
  | "SESSION_CERTIFICATE_ISSUANCE_INVALID_REQUEST"
  | "SESSION_CERTIFICATE_ISSUANCE_INVALID_RUNTIME_AUTHORITY"
  | "SESSION_CERTIFICATE_ISSUANCE_RUNTIME_NOT_ACTIVE"
  | "SESSION_CERTIFICATE_ISSUANCE_RUNTIME_KEY_INVALID"
  | "SESSION_CERTIFICATE_ISSUANCE_RUNTIME_KEY_MISMATCH"
  | "SESSION_CERTIFICATE_REPOSITORY_MISMATCH"
  | "SESSION_CERTIFICATE_TTL_EXCEEDS_RUNTIME_CEILING"
  | "SESSION_CERTIFICATE_CAPABILITY_EXCEEDS_RUNTIME_CEILING"
  | "SESSION_CERTIFICATE_ISSUANCE_RUNTIME_EXPIRY"
  | "SESSION_CERTIFICATE_ISSUANCE_SIGNING_FAILED";

export interface SessionCertificateIssuanceDiagnostic {
  readonly code: SessionCertificateIssuanceErrorCode;
  readonly path: string;
  readonly message: string;
}

export class SessionCertificateIssuanceError extends Error {
  readonly code: SessionCertificateIssuanceErrorCode;
  readonly diagnostics: readonly SessionCertificateIssuanceDiagnostic[];

  constructor(
    code: SessionCertificateIssuanceErrorCode,
    message: string,
    diagnostics: readonly SessionCertificateIssuanceDiagnostic[] = [],
  ) {
    super(message);
    this.name = "SessionCertificateIssuanceError";
    this.code = code;
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

interface SessionState {
  readonly privateKey: KeyObject;
}

const sessionStates = new WeakMap<ManagedSession, SessionState>();

function assertManagedSessionSigningInput(value: unknown): asserts value is Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    !ArrayBuffer.isView(value) ||
    value.byteLength > MAX_MANAGED_SESSION_SIGN_INPUT_BYTES
  ) {
    throw new ManagedSessionSigningError(
      "MANAGED_SESSION_SIGN_INVALID_INPUT",
      `Managed Session signing input must be a Uint8Array no larger than ${MAX_MANAGED_SESSION_SIGN_INPUT_BYTES} bytes.`,
    );
  }
}

function signManagedSessionBytes(session: ManagedSession, bytes: Uint8Array): Uint8Array {
  assertManagedSessionSigningInput(bytes);
  const state = sessionStates.get(session);
  if (state === undefined) {
    throw new ManagedSessionSigningError(
      "MANAGED_SESSION_SIGN_INVALID_INPUT",
      "Managed Session signing state is unavailable.",
    );
  }
  return Uint8Array.from(ed25519Sign(null, bytes, state.privateKey));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function opaqueId(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_OPAQUE_ID_LENGTH && OPAQUE_ID_PATTERN.test(value);
}

function bootstrapDiagnostic(
  code: SessionBootstrapErrorCode,
  path: string,
  message: string,
): SessionBootstrapDiagnostic {
  return { code, path, message };
}

function issuanceDiagnostic(
  code: SessionCertificateIssuanceErrorCode,
  path: string,
  message: string,
): SessionCertificateIssuanceDiagnostic {
  return { code, path, message };
}

function freezeRepository(value: SessionCertificateRepository): SessionCertificateRepository {
  return Object.freeze({ id: value.id, name: value.name });
}

function freezeTask(value: SessionCertificateTask | undefined): SessionCertificateTask | undefined {
  return value === undefined ? undefined : Object.freeze({ kind: "issue", number: value.number });
}

function freezeCapability(value: CapabilityClaim): CapabilityClaim {
  return Object.freeze({ ...value }) as CapabilityClaim;
}

function freezeRequest(
  sessionId: string,
  sessionKey: Ed25519PublicJwk,
  input: ManagedSessionIssuanceRequestInput,
): ManagedSessionIssuanceRequest {
  const task = freezeTask(input.task);
  return Object.freeze({
    sessionId,
    sessionKey,
    repository: freezeRepository(input.repository),
    ...(task === undefined ? {} : { task }),
    capabilities: Object.freeze(input.capabilities.map(freezeCapability)),
    ttlSeconds: input.ttlSeconds,
  });
}

function validateSessionRequestShape(request: unknown): void {
  if (!isRecord(request)) {
    throw new SessionCertificateIssuanceError(
      "SESSION_CERTIFICATE_ISSUANCE_INVALID_REQUEST",
      "Managed Session issuance request must be an object.",
    );
  }
  for (const key of Object.keys(request)) {
    if (!REQUEST_KEYS.has(key)) {
      throw new SessionCertificateIssuanceError(
        "SESSION_CERTIFICATE_ISSUANCE_INVALID_REQUEST",
        `Managed Session issuance request contains an unsupported property: ${key}.`,
        [
          issuanceDiagnostic(
            "SESSION_CERTIFICATE_ISSUANCE_INVALID_REQUEST",
            `$.request.${key}`,
            "Property is not accepted.",
          ),
        ],
      );
    }
  }
  for (const key of REQUEST_KEYS) {
    if (key === "task") continue;
    if (!(key in request)) {
      throw new SessionCertificateIssuanceError(
        "SESSION_CERTIFICATE_ISSUANCE_INVALID_REQUEST",
        `Managed Session issuance request is missing ${key}.`,
        [
          issuanceDiagnostic(
            "SESSION_CERTIFICATE_ISSUANCE_INVALID_REQUEST",
            `$.request.${key}`,
            "Property is required.",
          ),
        ],
      );
    }
  }
  if (!isOpaqueId(request.sessionId)) {
    throw new SessionCertificateIssuanceError(
      "SESSION_CERTIFICATE_ISSUANCE_INVALID_REQUEST",
      "Managed Session issuance request has an invalid sessionId.",
      [
        issuanceDiagnostic(
          "SESSION_CERTIFICATE_ISSUANCE_INVALID_REQUEST",
          "$.request.sessionId",
          "sessionId must be an opaque identifier.",
        ),
      ],
    );
  }
  if (
    typeof request.ttlSeconds !== "number" ||
    !Number.isInteger(request.ttlSeconds) ||
    request.ttlSeconds < MIN_SESSION_TTL_SECONDS ||
    request.ttlSeconds > MAX_SESSION_TTL_SECONDS
  ) {
    throw new SessionCertificateIssuanceError(
      "SESSION_CERTIFICATE_ISSUANCE_INVALID_REQUEST",
      `ttlSeconds must be an integer between ${MIN_SESSION_TTL_SECONDS} and ${MAX_SESSION_TTL_SECONDS}.`,
      [
        issuanceDiagnostic(
          "SESSION_CERTIFICATE_ISSUANCE_INVALID_REQUEST",
          "$.request.ttlSeconds",
          "TTL is outside the contract bounds.",
        ),
      ],
    );
  }
}

function validationPayload(
  request: ManagedSessionIssuanceRequest,
  repository: SessionCertificateRepository,
  authorityId: string,
  jti: string,
  nowSeconds: number,
): Record<string, unknown> {
  return {
    ver: SESSION_CERTIFICATE_CONTRACT_VERSION,
    iss: `runtime:${authorityId}`,
    sub: `session:${request.sessionId}`,
    jti,
    repository,
    sessionKey: request.sessionKey,
    ...(request.task === undefined ? {} : { task: request.task }),
    capabilities: request.capabilities,
    iat: nowSeconds,
    nbf: nowSeconds,
    exp: nowSeconds + request.ttlSeconds,
  };
}

function runtimeSigningKey(input: KeyObject | RuntimeAuthorityKeyPair): KeyObject {
  if (isRecord(input) && "privateKey" in input) return input.privateKey as KeyObject;
  return input as KeyObject;
}

function ensureRuntimeSigningKey(input: KeyObject | RuntimeAuthorityKeyPair, authority: RuntimeAuthority): KeyObject {
  const privateKey = runtimeSigningKey(input);
  if (
    typeof privateKey !== "object" ||
    privateKey === null ||
    privateKey.type !== "private" ||
    privateKey.asymmetricKeyType !== "ed25519"
  ) {
    throw new SessionCertificateIssuanceError(
      "SESSION_CERTIFICATE_ISSUANCE_RUNTIME_KEY_INVALID",
      "Runtime signing key must be an Ed25519 private key.",
    );
  }
  let publicKey: Ed25519PublicJwk;
  try {
    publicKey = exportRuntimeAuthorityPublicKey(privateKey);
  } catch {
    throw new SessionCertificateIssuanceError(
      "SESSION_CERTIFICATE_ISSUANCE_RUNTIME_KEY_INVALID",
      "Runtime signing key does not contain a valid Ed25519 public key.",
    );
  }
  if (publicKey.x !== authority.key.x) {
    throw new SessionCertificateIssuanceError(
      "SESSION_CERTIFICATE_ISSUANCE_RUNTIME_KEY_MISMATCH",
      "Runtime signing key does not match the trusted Runtime Authority public key.",
    );
  }
  return privateKey;
}

function assertManagedRequest(request: ManagedSessionIssuanceRequest, repository: SessionCertificateRepository): void {
  validateSessionRequestShape(request);
  if (!isRecord(request.sessionKey)) {
    throw new SessionCertificateIssuanceError(
      "SESSION_CERTIFICATE_ISSUANCE_INVALID_REQUEST",
      "Managed Session request must contain a public Session key.",
    );
  }
  try {
    assertEd25519PublicJwk(request.sessionKey, "$.request.sessionKey");
  } catch (error: unknown) {
    throw new SessionCertificateIssuanceError(
      "SESSION_CERTIFICATE_ISSUANCE_INVALID_REQUEST",
      error instanceof Error ? error.message : "Managed Session request contains an invalid public key.",
      [
        issuanceDiagnostic(
          "SESSION_CERTIFICATE_ISSUANCE_INVALID_REQUEST",
          "$.request.sessionKey",
          "Only an Ed25519 public JWK is accepted.",
        ),
      ],
    );
  }
  if (!isRecord(repository) || !isRecord(request.repository) || request.repository.id !== repository.id) {
    throw new SessionCertificateIssuanceError(
      "SESSION_CERTIFICATE_REPOSITORY_MISMATCH",
      "Managed Session request repository ID does not match the Runtime repository identity.",
      [
        issuanceDiagnostic(
          "SESSION_CERTIFICATE_REPOSITORY_MISMATCH",
          "$.request.repository.id",
          "Immutable repository IDs must match.",
        ),
      ],
    );
  }
}

function nowSeconds(now: Date): number {
  if (!(now instanceof Date)) {
    throw new SessionCertificateIssuanceError(
      "SESSION_CERTIFICATE_ISSUANCE_INVALID_REQUEST",
      "Issuance time must be a Date.",
      [issuanceDiagnostic("SESSION_CERTIFICATE_ISSUANCE_INVALID_REQUEST", "$.now", "now must be a Date.")],
    );
  }
  const milliseconds = now.getTime();
  const seconds = Math.floor(milliseconds / 1000);
  if (!Number.isFinite(milliseconds) || seconds < 0 || seconds > MAX_UNIX_TIME_SECONDS) {
    throw new SessionCertificateIssuanceError(
      "SESSION_CERTIFICATE_ISSUANCE_INVALID_REQUEST",
      "Issuance time must be a bounded Unix timestamp.",
      [
        issuanceDiagnostic(
          "SESSION_CERTIFICATE_ISSUANCE_INVALID_REQUEST",
          "$.now",
          "now is outside the certificate time range.",
        ),
      ],
    );
  }
  return seconds;
}

function certificateCompact(value: ManagedSessionCertificate): string {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.compact === "string") return value.compact;
  throw new SessionBootstrapError(
    "SESSION_BOOTSTRAP_INVALID_CERTIFICATE",
    "Managed Session certificate must be a canonical compact certificate.",
  );
}

/**
 * Create a managed Session. The private key is retained only in module-owned
 * state keyed by the returned Session object; it is never part of the object,
 * request, or certificate returned by this module.
 */
export function createManagedSession(): ManagedSession {
  const sessionId = opaqueId(SESSION_ID_BYTES);
  if (!isOpaqueId(sessionId)) {
    throw new SessionBootstrapError(
      "SESSION_BOOTSTRAP_INVALID_SESSION_ID",
      "Managed Session id must be a bounded opaque identifier.",
      [bootstrapDiagnostic("SESSION_BOOTSTRAP_INVALID_SESSION_ID", "$.sessionId", "sessionId is invalid.")],
    );
  }

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyJwk = exportRuntimeAuthorityPublicKey(publicKey);
  let acceptedCertificate: DecodedSessionCertificate | undefined;

  const createRequest = (input: ManagedSessionIssuanceRequestInput): ManagedSessionIssuanceRequest => {
    if (!isRecord(input)) {
      throw new SessionBootstrapError(
        "SESSION_BOOTSTRAP_INVALID_REQUEST",
        "Managed Session issuance context must be an object.",
      );
    }
    try {
      const request = freezeRequest(sessionId, publicKeyJwk, input);
      validateSessionRequestShape(request);
      const result = validateSessionCertificatePayload(
        validationPayload(request, request.repository, VALIDATION_RUNTIME_ID, VALIDATION_CERTIFICATE_ID, 0),
      );
      if (!result.valid || result.value === undefined) {
        throw new SessionCertificateIssuanceError(
          "SESSION_CERTIFICATE_ISSUANCE_INVALID_REQUEST",
          "Managed Session issuance context is not a valid certificate claim set.",
          result.diagnostics.map((diagnostic) =>
            issuanceDiagnostic("SESSION_CERTIFICATE_ISSUANCE_INVALID_REQUEST", diagnostic.path, diagnostic.message),
          ),
        );
      }
      return request;
    } catch (error: unknown) {
      if (error instanceof SessionBootstrapError) throw error;
      if (error instanceof SessionCertificateIssuanceError) {
        throw new SessionBootstrapError(
          "SESSION_BOOTSTRAP_INVALID_REQUEST",
          error.message,
          error.diagnostics.map((diagnostic) =>
            bootstrapDiagnostic("SESSION_BOOTSTRAP_INVALID_REQUEST", diagnostic.path, diagnostic.message),
          ),
        );
      }
      throw new SessionBootstrapError(
        "SESSION_BOOTSTRAP_INVALID_REQUEST",
        "Managed Session issuance context is invalid.",
      );
    }
  };

  const acceptCertificate = (certificate: ManagedSessionCertificate): DecodedSessionCertificate => {
    const compact = certificateCompact(certificate);
    const decoded = decodeSessionCertificateCompact(compact);
    if (!decoded.valid || decoded.value === undefined) {
      throw new SessionBootstrapError(
        "SESSION_BOOTSTRAP_INVALID_CERTIFICATE",
        "Managed Session received a structurally invalid certificate.",
        decoded.diagnostics.map((diagnostic) =>
          bootstrapDiagnostic("SESSION_BOOTSTRAP_INVALID_CERTIFICATE", diagnostic.path, diagnostic.message),
        ),
      );
    }
    if (decoded.value.payload.sub !== `session:${sessionId}`) {
      throw new SessionBootstrapError(
        "SESSION_BOOTSTRAP_CERTIFICATE_SESSION_MISMATCH",
        "Certificate subject does not identify this Managed Session.",
        [
          bootstrapDiagnostic(
            "SESSION_BOOTSTRAP_CERTIFICATE_SESSION_MISMATCH",
            "$.payload.sub",
            "Session certificate substitution rejected.",
          ),
        ],
      );
    }
    if (
      canonicalJsonString(decoded.value.payload.sessionKey as unknown as CanonicalJsonValue) !==
      canonicalJsonString(publicKeyJwk as unknown as CanonicalJsonValue)
    ) {
      throw new SessionBootstrapError(
        "SESSION_BOOTSTRAP_CERTIFICATE_KEY_MISMATCH",
        "Certificate public key does not identify this Managed Session.",
        [
          bootstrapDiagnostic(
            "SESSION_BOOTSTRAP_CERTIFICATE_KEY_MISMATCH",
            "$.payload.sessionKey",
            "Session certificate substitution rejected.",
          ),
        ],
      );
    }
    acceptedCertificate = decoded.value;
    return decoded.value;
  };

  const session: ManagedSession = {
    sessionId,
    publicKey: publicKeyJwk,
    get certificate() {
      return acceptedCertificate;
    },
    sign: (bytes) => signManagedSessionBytes(session, bytes),
    createIssuanceRequest: createRequest,
    acceptCertificate,
  };
  Object.freeze(session);
  sessionStates.set(session, Object.freeze({ privateKey }));
  return session;
}

/**
 * Issue a Runtime-signed certificate from a public-only Session request.
 * The request's repository name is diagnostic input; the certificate uses the
 * Runtime-resolved repository identity and compares its immutable ID.
 */
export function issueSessionCertificate(options: RuntimeSessionCertificateIssuanceOptions): IssuedSessionCertificate {
  let authority: RuntimeAuthority;
  try {
    authority = assertRuntimeAuthority(options.runtimeAuthority);
  } catch (error: unknown) {
    throw new SessionCertificateIssuanceError(
      "SESSION_CERTIFICATE_ISSUANCE_INVALID_RUNTIME_AUTHORITY",
      error instanceof Error ? error.message : "Runtime Authority record is invalid.",
    );
  }

  const now = options.now ?? new Date();
  const issuedAt = nowSeconds(now);
  if (!isRuntimeAuthorityActive(authority, now)) {
    throw new SessionCertificateIssuanceError(
      "SESSION_CERTIFICATE_ISSUANCE_RUNTIME_NOT_ACTIVE",
      "The Runtime Authority is not active at issuance time.",
    );
  }

  assertManagedRequest(options.request, options.repository);
  if (options.request.ttlSeconds > authority.maxSessionTtlSeconds) {
    throw new SessionCertificateIssuanceError(
      "SESSION_CERTIFICATE_TTL_EXCEEDS_RUNTIME_CEILING",
      "Requested Session Certificate TTL exceeds the Runtime Authority ceiling.",
      [
        issuanceDiagnostic(
          "SESSION_CERTIFICATE_TTL_EXCEEDS_RUNTIME_CEILING",
          "$.request.ttlSeconds",
          "TTL exceeds maxSessionTtlSeconds.",
        ),
      ],
    );
  }
  if (authority.notAfter !== null && (issuedAt + options.request.ttlSeconds) * 1000 > Date.parse(authority.notAfter)) {
    throw new SessionCertificateIssuanceError(
      "SESSION_CERTIFICATE_ISSUANCE_RUNTIME_EXPIRY",
      "Requested Session Certificate would outlive the Runtime Authority trust window.",
    );
  }
  const privateKey = ensureRuntimeSigningKey(options.runtimeKey, authority);
  const jti = opaqueId(CERTIFICATE_ID_BYTES);
  const payloadInput = validationPayload(options.request, options.repository, authority.id, jti, issuedAt);
  const payloadResult = validateSessionCertificatePayload(payloadInput);
  if (!payloadResult.valid || payloadResult.value === undefined) {
    throw new SessionCertificateIssuanceError(
      "SESSION_CERTIFICATE_ISSUANCE_INVALID_REQUEST",
      "Managed Session request cannot be issued as a Session Certificate.",
      payloadResult.diagnostics.map((diagnostic) =>
        issuanceDiagnostic("SESSION_CERTIFICATE_ISSUANCE_INVALID_REQUEST", diagnostic.path, diagnostic.message),
      ),
    );
  }
  const payload = payloadResult.value;
  for (const [index, claim] of payload.capabilities.entries()) {
    if (!capabilityClaimWithinCeiling(claim, authority.capabilityCeiling)) {
      throw new SessionCertificateIssuanceError(
        "SESSION_CERTIFICATE_CAPABILITY_EXCEEDS_RUNTIME_CEILING",
        "Requested capability is outside the Runtime Authority ceiling.",
        [
          issuanceDiagnostic(
            "SESSION_CERTIFICATE_CAPABILITY_EXCEEDS_RUNTIME_CEILING",
            `$.payload.capabilities[${index}].kind`,
            "Capability exceeds capabilityCeiling.",
          ),
        ],
      );
    }
  }

  const header: SessionCertificateHeader = Object.freeze({
    alg: SESSION_CERTIFICATE_ALG,
    typ: SESSION_CERTIFICATE_TYP,
    kid: authority.id,
  });
  const { signingInput } = sessionCertificateSigningInput(header, payload);
  let signature: string;
  try {
    signature = ed25519Sign(null, Buffer.from(signingInput, "utf8"), privateKey).toString("base64url");
  } catch {
    throw new SessionCertificateIssuanceError(
      "SESSION_CERTIFICATE_ISSUANCE_SIGNING_FAILED",
      "Runtime failed to sign the Session Certificate.",
    );
  }
  const compact = encodeSessionCertificateCompact(header, payload, signature);
  return Object.freeze({
    compact,
    header,
    payload,
    signingInput,
    signature,
  });
}

/** Explicit name for callers that want to distinguish managed bootstrap from manual issuance. */
export const issueManagedSessionCertificate = issueSessionCertificate;
