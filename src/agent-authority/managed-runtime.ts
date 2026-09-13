/**
 * Public managed-runtime integration seam.
 *
 * This module deliberately keeps the Session-side and Runtime-side steps as
 * separate entry points instead of one function that can reach both private
 * key domains:
 *
 * - `beginManagedRuntimeSession` only calls `createManagedSession` and builds
 *   the public-only `ManagedSessionIssuanceRequest`.  It never receives a
 *   Runtime Authority or Runtime key, so it structurally cannot call
 *   `issueSessionCertificate`.
 * - The caller passes the resulting `issuanceRequest` to the existing
 *   `issueSessionCertificate` primitive (Runtime-side, in
 *   `./session-issuance.js`) on whatever boundary holds the Runtime key. This
 *   module does not wrap that call, so it never holds a `ManagedSession` and
 *   a Runtime key at once either.
 * - `completeManagedRuntimeSession` takes the Session created by
 *   `beginManagedRuntimeSession` and the certificate produced by
 *   `issueSessionCertificate`, has the Session accept it, and returns the
 *   Session-signing seam. It never accepts a Runtime Authority or Runtime
 *   key, so it cannot reach the Runtime private-key domain either.
 *
 * A caller that wants one call can compose these two functions and
 * `issueSessionCertificate` itself, but this module never introduces a
 * primitive that owns both private-key domains at once.
 */

import {
  createManagedSession,
  type IssuedSessionCertificate,
  type ManagedSession,
  type ManagedSessionIssuanceRequest,
} from "./session-issuance.js";
import { signSessionRequest, type SemanticSessionRequest, type SessionRequestEnvelope } from "./session-request.js";
import type { CapabilityClaim } from "./capability.js";
import type { SessionCertificateRepository, SessionCertificateTask } from "./session-certificate.js";

/** Provenance is diagnostic metadata only; it is not a Session principal. */
export interface ManagedRuntimeProvenance {
  /** Runtime implementation label, not a Runtime Authority identity. */
  readonly runtime?: string;
  /** Optional worktree label, not a repository or authorization identity. */
  readonly worktree?: string;
  /** Optional workspace spelling used by managed-runtime integrations. */
  readonly workspace?: string;
  /** Optional Session label, not the certificate Session subject. */
  readonly session?: string;
}

export const MAX_MANAGED_RUNTIME_PROVENANCE_KEYS = 4 as const;
export const MAX_MANAGED_RUNTIME_PROVENANCE_LABEL_LENGTH = 128 as const;

const MANAGED_RUNTIME_BEGIN_OPTION_KEYS = new Set(["repository", "task", "capabilities", "ttlSeconds", "provenance"]);
const MANAGED_RUNTIME_PROVENANCE_KEYS = new Set(["runtime", "worktree", "workspace", "session"]);
const SAFE_PROVENANCE_LABEL = /^[\x20-\x7e]+$/u;
const SENSITIVE_PROVENANCE_LABEL = /(?:private\s*key|secret|token|credential|jwt|installation|begin\s+[-a-z]+\s+key)/iu;

export type ManagedRuntimeSessionErrorCode =
  | "MANAGED_RUNTIME_INVALID_OPTIONS"
  | "MANAGED_RUNTIME_INVALID_PROVENANCE"
  | "MANAGED_RUNTIME_INVALID_CERTIFICATE";

export interface ManagedRuntimeSessionDiagnostic {
  readonly code: ManagedRuntimeSessionErrorCode;
  readonly path: string;
  readonly message: string;
}

/** Stable, bounded, secret-safe validation error for the composition seam. */
export class ManagedRuntimeSessionError extends Error {
  readonly code: ManagedRuntimeSessionErrorCode;
  readonly diagnostics: readonly ManagedRuntimeSessionDiagnostic[];

  constructor(
    code: ManagedRuntimeSessionErrorCode,
    message: string,
    diagnostics: readonly ManagedRuntimeSessionDiagnostic[] = [],
  ) {
    super(message);
    this.name = "ManagedRuntimeSessionError";
    this.code = code;
    this.diagnostics = Object.freeze([...diagnostics]);
  }
}

/**
 * Options for the Session-side half of the managed-runtime seam.
 *
 * There is deliberately no Runtime Authority or Runtime key field here: this
 * type, and the function it configures, cannot reach the Runtime private-key
 * domain.
 */
export interface ManagedRuntimeSessionBeginOptions {
  readonly repository: SessionCertificateRepository;
  readonly task?: SessionCertificateTask;
  readonly capabilities: readonly CapabilityClaim[];
  readonly ttlSeconds: number;
  readonly provenance?: ManagedRuntimeProvenance;
}

/**
 * Session-side result of `beginManagedRuntimeSession`.
 *
 * `session` owns the Session private key in module-private state (see
 * `createManagedSession`); this value only ever exposes its public seam.
 * `issuanceRequest` is the public-only value to hand to the Runtime-side
 * `issueSessionCertificate` primitive.
 */
export interface ManagedRuntimeSessionBegin {
  readonly session: ManagedSession;
  readonly issuanceRequest: ManagedSessionIssuanceRequest;
  readonly provenance?: ManagedRuntimeProvenance;
}

export interface ManagedRuntimeSessionRequestOptions {
  readonly request: SemanticSessionRequest;
  readonly operation: string;
  readonly requestId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/**
 * Options for the Session-side completion half of the managed-runtime seam.
 *
 * There is deliberately no Runtime Authority or Runtime key field here
 * either: this function only ever consumes the certificate already issued by
 * the Runtime-side `issueSessionCertificate` primitive.
 */
export interface ManagedRuntimeSessionCompleteOptions {
  readonly session: ManagedSession;
  readonly issuanceRequest: ManagedSessionIssuanceRequest;
  /** The exact value returned by the Runtime-side `issueSessionCertificate`. */
  readonly certificate: IssuedSessionCertificate;
  readonly provenance?: ManagedRuntimeProvenance;
}

/**
 * Agent-facing result of the managed-runtime seam.
 *
 * It contains the public-only issuance request, the canonical Runtime-signed
 * certificate, and the Session signing seam.  It intentionally has no
 * Runtime key, App credential, or serialized Session private key.
 */
export interface ManagedRuntimeSession {
  readonly session: ManagedSession;
  readonly issuanceRequest: ManagedSessionIssuanceRequest;
  readonly certificate: IssuedSessionCertificate;
  readonly provenance?: ManagedRuntimeProvenance;
  /** Sign the existing canonical Session request envelope. */
  readonly signRequest: (options: ManagedRuntimeSessionRequestOptions) => SessionRequestEnvelope;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function diagnostic(
  code: ManagedRuntimeSessionErrorCode,
  path: string,
  message: string,
): ManagedRuntimeSessionDiagnostic {
  return { code, path, message };
}

function fail(code: ManagedRuntimeSessionErrorCode, message: string, path: string): never {
  throw new ManagedRuntimeSessionError(code, message, [diagnostic(code, path, message)]);
}

function rejectUnknownProperties(
  input: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  code: ManagedRuntimeSessionErrorCode,
  path: string,
): void {
  for (const key of Object.keys(input).sort()) {
    if (!allowed.has(key)) {
      fail(code, "Managed-runtime input contains an unsupported property.", `${path}.${key}`);
    }
  }
}

function validateProvenance(input: unknown): ManagedRuntimeProvenance | undefined {
  if (input === undefined) return undefined;
  if (!isRecord(input)) {
    fail("MANAGED_RUNTIME_INVALID_PROVENANCE", "Managed-runtime provenance must be an object.", "$.provenance");
  }
  rejectUnknownProperties(input, MANAGED_RUNTIME_PROVENANCE_KEYS, "MANAGED_RUNTIME_INVALID_PROVENANCE", "$.provenance");
  const entries = Object.entries(input);
  if (entries.length === 0 || entries.length > MAX_MANAGED_RUNTIME_PROVENANCE_KEYS) {
    fail(
      "MANAGED_RUNTIME_INVALID_PROVENANCE",
      `Managed-runtime provenance must contain 1-${MAX_MANAGED_RUNTIME_PROVENANCE_KEYS} properties.`,
      "$.provenance",
    );
  }
  const normalized: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > MAX_MANAGED_RUNTIME_PROVENANCE_LABEL_LENGTH ||
      !SAFE_PROVENANCE_LABEL.test(value) ||
      SENSITIVE_PROVENANCE_LABEL.test(value)
    ) {
      fail(
        "MANAGED_RUNTIME_INVALID_PROVENANCE",
        `Provenance labels must be printable text of at most ${MAX_MANAGED_RUNTIME_PROVENANCE_LABEL_LENGTH} characters and must not contain credential material.`,
        `$.provenance.${key}`,
      );
    }
    normalized[key] = value;
  }
  return Object.freeze(normalized) as ManagedRuntimeProvenance;
}

function validateBeginOptions(input: unknown): ManagedRuntimeSessionBeginOptions {
  if (!isRecord(input)) {
    fail("MANAGED_RUNTIME_INVALID_OPTIONS", "Managed-runtime options must be an object.", "$");
  }
  rejectUnknownProperties(input, MANAGED_RUNTIME_BEGIN_OPTION_KEYS, "MANAGED_RUNTIME_INVALID_OPTIONS", "$");
  for (const key of ["repository", "capabilities", "ttlSeconds"] as const) {
    if (!(key in input)) {
      fail("MANAGED_RUNTIME_INVALID_OPTIONS", "Managed-runtime option is required.", `$.${key}`);
    }
  }
  const provenance = validateProvenance(input.provenance);
  return {
    repository: input.repository as SessionCertificateRepository,
    ...(input.task === undefined ? {} : { task: input.task as SessionCertificateTask }),
    capabilities: input.capabilities as readonly CapabilityClaim[],
    ttlSeconds: input.ttlSeconds as number,
    ...(provenance === undefined ? {} : { provenance }),
  };
}

function assertManagedSession(value: unknown): asserts value is ManagedSession {
  if (
    !isRecord(value) ||
    typeof value.sessionId !== "string" ||
    typeof value.sign !== "function" ||
    typeof value.createIssuanceRequest !== "function" ||
    typeof value.acceptCertificate !== "function"
  ) {
    fail("MANAGED_RUNTIME_INVALID_OPTIONS", "Managed-runtime session must be a ManagedSession.", "$.session");
  }
}

function assertIssuanceRequest(value: unknown): asserts value is ManagedSessionIssuanceRequest {
  if (!isRecord(value) || typeof value.sessionId !== "string" || !isRecord(value.sessionKey)) {
    fail(
      "MANAGED_RUNTIME_INVALID_OPTIONS",
      "Managed-runtime issuanceRequest must be a ManagedSessionIssuanceRequest.",
      "$.issuanceRequest",
    );
  }
}

function assertIssuedCertificate(value: unknown): asserts value is IssuedSessionCertificate {
  if (!isRecord(value) || typeof value.compact !== "string" || !isRecord(value.payload)) {
    fail(
      "MANAGED_RUNTIME_INVALID_CERTIFICATE",
      "Managed-runtime certificate must be the value returned by issueSessionCertificate.",
      "$.certificate",
    );
  }
}

/**
 * Session-side half of the managed-runtime seam.
 *
 * Creates one managed Session and its public-only issuance request. This
 * function has no Runtime Authority or Runtime key parameter, so it cannot
 * call the Runtime-side `issueSessionCertificate` itself — the caller must
 * pass `issuanceRequest` to that primitive on the Runtime-key boundary, then
 * pass the resulting certificate to `completeManagedRuntimeSession`.
 */
export function beginManagedRuntimeSession(options: ManagedRuntimeSessionBeginOptions): ManagedRuntimeSessionBegin {
  const normalized = validateBeginOptions(options);
  const session = createManagedSession();
  const issuanceRequest = session.createIssuanceRequest({
    repository: normalized.repository,
    ...(normalized.task === undefined ? {} : { task: normalized.task }),
    capabilities: normalized.capabilities,
    ttlSeconds: normalized.ttlSeconds,
  });

  return Object.freeze({
    session,
    issuanceRequest,
    ...(normalized.provenance === undefined ? {} : { provenance: normalized.provenance }),
  });
}

/**
 * Session-side completion half of the managed-runtime seam.
 *
 * Takes the Session from `beginManagedRuntimeSession` and the certificate
 * already issued by the Runtime-side `issueSessionCertificate`, has the
 * Session accept it, and returns the transport-neutral signing seam. This
 * function has no Runtime Authority or Runtime key parameter, so it cannot
 * reach the Runtime private-key domain.
 */
export function completeManagedRuntimeSession(options: ManagedRuntimeSessionCompleteOptions): ManagedRuntimeSession {
  if (!isRecord(options)) {
    fail("MANAGED_RUNTIME_INVALID_OPTIONS", "Managed-runtime options must be an object.", "$");
  }
  assertManagedSession(options.session);
  assertIssuanceRequest(options.issuanceRequest);
  assertIssuedCertificate(options.certificate);
  const provenance = validateProvenance(options.provenance);

  const { session, issuanceRequest, certificate } = options;
  session.acceptCertificate(certificate);

  const signRequest = (requestOptions: ManagedRuntimeSessionRequestOptions): SessionRequestEnvelope =>
    signSessionRequest({
      session,
      certificate,
      request: requestOptions.request,
      operation: requestOptions.operation,
      requestId: requestOptions.requestId,
      issuedAt: requestOptions.issuedAt,
      expiresAt: requestOptions.expiresAt,
    });

  return Object.freeze({
    session,
    issuanceRequest,
    certificate,
    ...(provenance === undefined ? {} : { provenance }),
    signRequest,
  });
}
