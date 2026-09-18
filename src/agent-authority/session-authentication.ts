/**
 * App-side Session authentication boundary.
 *
 * This is the composition point for the already-frozen authority contracts:
 * the GitHub App repository-read capability (#464), repository-native Runtime
 * trust (#369), the Session Certificate contract (#367), and Session request
 * proof-of-possession (#373).  It owns no credential, policy cache, replay
 * store, transport, or mutation operation.
 */

import { createPublicKey, verify as ed25519Verify } from "node:crypto";
import {
  resolveGitHubRepository,
  type GitHubAppRepositoryReadCapability,
  type GitHubAppRepositoryReadPermissionSet,
} from "../github/app-installation-credential-broker.js";
import { createAppRepositoryEvidenceReader } from "../github/app-repository-evidence-reader.js";
import type { GitHubChangeEffectRepository } from "../github/change-effect-adapter.js";
import {
  MAX_UNIX_TIME_SECONDS,
  SESSION_CERTIFICATE_ALG,
  SESSION_CERTIFICATE_TYP,
  decodeSessionCertificateCompact,
  evaluateSessionCertificateAgainstDelegator,
  type DecodedSessionCertificate,
  type SessionCertificateTask,
} from "./session-certificate.js";
import { resolveDelegator, type LoadedDelegator } from "./delegator-trust.js";
import type { CapabilityClaim } from "./capability.js";
import { verifySessionRequest, type VerifiedSessionRequest } from "./session-request.js";
import { validateRepositoryIdentity, type RepositoryIdentity } from "../github/effect-authorizer.js";
import {
  projectImplementationSessionAuthorizationBinding,
  serializeImplementationSessionAuthorizationBinding,
  type ImplementationSessionAuthorizationBinding,
} from "../implementation-session-binding.js";
import type { ImplementationAuthorizationVerificationInput } from "../implementation-authorization.js";

/** The only broker operation accepted by this boundary. */
export interface SessionAuthenticationReadCapabilityBroker {
  withRepositoryReadCapability<T>(
    request: { readonly permissions?: GitHubAppRepositoryReadPermissionSet },
    operation: (capability: GitHubAppRepositoryReadCapability) => Promise<T>,
  ): Promise<T>;
}

export interface AuthenticateSessionRequestOptions {
  /** Trusted #464 App broker. Its read credential never crosses this call. */
  readonly broker: SessionAuthenticationReadCapabilityBroker;
  /** Configured repository locator used only to select the App installation. */
  readonly repository: GitHubChangeEffectRepository;
  /** Untrusted #373 Session request envelope. */
  readonly request: unknown;
  /** Fresh current Implementation evidence when the certificate carries a binding. */
  readonly implementationAuthorization?: ImplementationAuthorizationVerificationInput;
  /** One request-local verification clock. Defaults to the current time. */
  readonly now?: Date | number | (() => Date | number);
}

export type AuthenticatedSessionRepository = RepositoryIdentity;

export interface AuthenticatedSessionDelegator {
  /** Delegator record identifier, as resolved by `kid`. */
  readonly id: string;
  /** Certificate header key identifier; retained explicitly for diagnostics. */
  readonly kid: string;
}

/** @deprecated Use `AuthenticatedSessionDelegator`; the field shape is unchanged. */
export type AuthenticatedSessionRuntimeAuthority = AuthenticatedSessionDelegator;

export interface AuthenticatedSessionIdentity {
  /** Opaque Session ID without the `session:` subject prefix. */
  readonly id: string;
  /** Runtime-issued Session Certificate `jti`. */
  readonly certificateJti: string;
}

export interface AuthenticatedSessionAuthorityRef {
  /** The repository default branch ref used for this authorization decision. */
  readonly ref: string;
  /** Immutable commit SHA resolved from `ref` before reading the trust tree. */
  readonly sha: string;
}

export interface AuthenticatedSessionRequestIdentity {
  readonly requestId: string;
  readonly operation: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/**
 * The sole output of App-side Session authentication. Every field is derived
 * from the provider identity, canonical Runtime trust, or a verified #373
 * request. No App/installation credential or provider response is represented.
 */
export interface AuthenticatedSessionContext {
  readonly repository: AuthenticatedSessionRepository;
  readonly runtimeAuthority: AuthenticatedSessionDelegator;
  readonly session: AuthenticatedSessionIdentity;
  readonly task?: SessionCertificateTask;
  readonly implementationBinding?: ImplementationSessionAuthorizationBinding;
  readonly capabilities: readonly CapabilityClaim[];
  readonly authority: AuthenticatedSessionAuthorityRef;
  readonly request: AuthenticatedSessionRequestIdentity;
  readonly verifiedRequest: VerifiedSessionRequest;
}

export const SESSION_AUTHENTICATION_FAILURE_REASONS = Object.freeze([
  "certificate",
  "repository",
  "repository-read",
  "runtime-trust",
  "runtime-signature",
  "implementation-authorization",
  "session-request",
] as const);

export type SessionAuthenticationFailureReason = (typeof SESSION_AUTHENTICATION_FAILURE_REASONS)[number];

/** Stable, deliberately non-sensitive failure from the App authentication boundary. */
export class SessionAuthenticationError extends Error {
  readonly code = "SESSION_AUTHENTICATION_FAILED" as const;
  readonly reason: SessionAuthenticationFailureReason;

  constructor(reason: SessionAuthenticationFailureReason) {
    super("Session authentication failed closed.");
    this.name = "SessionAuthenticationError";
    this.reason = reason;
  }
}

function fail(reason: SessionAuthenticationFailureReason): never {
  throw new SessionAuthenticationError(reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeVerificationTime(input: Date | number | (() => Date | number) | undefined): Date {
  if (input === undefined) return new Date();
  if (typeof input === "function") {
    try {
      return normalizeVerificationTime(input());
    } catch {
      fail("certificate");
    }
  }
  if (input instanceof Date) {
    if (!Number.isFinite(input.getTime())) fail("certificate");
    return new Date(input.getTime());
  }
  if (!Number.isInteger(input) || input < 0 || input > MAX_UNIX_TIME_SECONDS) fail("certificate");
  return new Date(input * 1000);
}

function certificateFromRequest(input: unknown): {
  readonly compact: string;
  readonly certificate: DecodedSessionCertificate;
} {
  if (!isRecord(input) || typeof input.certificate !== "string") fail("certificate");
  const decoded = decodeSessionCertificateCompact(input.certificate);
  if (!decoded.valid || decoded.value === undefined) fail("certificate");
  return { compact: input.certificate, certificate: decoded.value };
}

/**
 * Security identity is canonical host + immutable repository ID only.
 * `nameWithOwner` is diagnostic metadata: a provider-resolved rename must not
 * invalidate an otherwise identical immutable repository identity.
 */
function sameRepositoryIdentity(left: RepositoryIdentity, right: RepositoryIdentity): boolean {
  return (
    left.repositoryHost.toLowerCase() === right.repositoryHost.toLowerCase() && left.repositoryId === right.repositoryId
  );
}

function verifyRuntimeSignature(certificate: DecodedSessionCertificate, runtime: LoadedDelegator): void {
  if (
    certificate.header.alg !== SESSION_CERTIFICATE_ALG ||
    certificate.header.typ !== SESSION_CERTIFICATE_TYP ||
    certificate.header.kid !== runtime.authority.id
  ) {
    fail("certificate");
  }
  let valid = false;
  try {
    valid = ed25519Verify(
      null,
      Buffer.from(certificate.signingInput, "utf8"),
      createPublicKey({ key: runtime.authority.key, format: "jwk" }),
      Buffer.from(certificate.signature, "base64url"),
    );
  } catch {
    valid = false;
  }
  if (!valid) fail("runtime-signature");
}

function verifyCertificateClaims(
  certificate: DecodedSessionCertificate,
  runtime: LoadedDelegator,
  repository: RepositoryIdentity,
  now: Date,
): void {
  const evaluation = evaluateSessionCertificateAgainstDelegator(certificate, {
    delegator: runtime.authority,
    expectedRepositoryId: repository.repositoryId,
    now,
  });
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (!evaluation.admitted || nowSeconds < certificate.payload.nbf || nowSeconds >= certificate.payload.exp) {
    fail("certificate");
  }
}

function verifyImplementationBinding(
  certificate: DecodedSessionCertificate,
  repository: RepositoryIdentity,
  currentAuthorization: ImplementationAuthorizationVerificationInput | undefined,
): void {
  const binding = certificate.payload.implementationBinding;
  if (binding === undefined) return;
  if (currentAuthorization === undefined) fail("implementation-authorization");
  if (
    binding.repository.repositoryHost.toLowerCase() !== repository.repositoryHost.toLowerCase() ||
    binding.repository.repositoryId !== repository.repositoryId
  )
    fail("implementation-authorization");
  try {
    const current = projectImplementationSessionAuthorizationBinding({
      ...currentAuthorization,
      task: certificate.payload.task,
    });
    if (
      serializeImplementationSessionAuthorizationBinding(current) !==
      serializeImplementationSessionAuthorizationBinding(binding)
    ) {
      fail("implementation-authorization");
    }
  } catch {
    fail("implementation-authorization");
  }
}

function sessionId(subject: string): string {
  return subject.startsWith("session:") ? subject.slice("session:".length) : subject;
}

function authenticatedContext(
  certificate: DecodedSessionCertificate,
  verifiedRequest: VerifiedSessionRequest,
  runtime: LoadedDelegator,
  repository: RepositoryIdentity,
): AuthenticatedSessionContext {
  const payload = certificate.payload;
  const context: AuthenticatedSessionContext = {
    repository: Object.freeze({ ...repository }),
    runtimeAuthority: Object.freeze({ id: runtime.authority.id, kid: certificate.header.kid }),
    session: Object.freeze({ id: sessionId(payload.sub), certificateJti: payload.jti }),
    ...(payload.task === undefined ? {} : { task: Object.freeze({ ...payload.task }) }),
    ...(payload.implementationBinding === undefined
      ? {}
      : { implementationBinding: Object.freeze(payload.implementationBinding) }),
    capabilities: Object.freeze(payload.capabilities.map((claim) => Object.freeze({ ...claim }))),
    authority: Object.freeze({ ref: runtime.provenance.ref, sha: runtime.provenance.policySha }),
    request: Object.freeze({
      requestId: verifiedRequest.envelope.requestId,
      operation: verifiedRequest.envelope.operation,
      issuedAt: verifiedRequest.envelope.issuedAt,
      expiresAt: verifiedRequest.envelope.expiresAt,
    }),
    verifiedRequest,
  };
  return Object.freeze(context);
}

/**
 * Authenticate one Session request against a fresh repository trust snapshot.
 * The read capability callback is the complete lifetime of the App read
 * credential; no value obtained from it is returned.
 */
export async function authenticateSessionRequest(
  options: AuthenticateSessionRequestOptions,
): Promise<AuthenticatedSessionContext> {
  const now = normalizeVerificationTime(options.now);
  const certificateEvidence = certificateFromRequest(options.request);
  const certificate = certificateEvidence.certificate;

  try {
    return await options.broker.withRepositoryReadCapability({}, async (capability) => {
      let resolvedRepository: Awaited<ReturnType<typeof resolveGitHubRepository>>;
      try {
        resolvedRepository = await resolveGitHubRepository(options.repository, capability.transport);
      } catch {
        fail("repository-read");
      }
      const resolvedIdentity = validateRepositoryIdentity(resolvedRepository.target);
      if (!resolvedIdentity.valid || resolvedIdentity.value === undefined) fail("repository");
      if (!sameRepositoryIdentity(resolvedIdentity.value, capability.scope.repository)) fail("repository");

      const reader = createAppRepositoryEvidenceReader(capability, options.repository, resolvedIdentity.value);
      let runtime: LoadedDelegator;
      try {
        runtime = await resolveDelegator(reader, certificate.header.kid, { now });
      } catch {
        fail("runtime-trust");
      }

      verifyRuntimeSignature(certificate, runtime);
      verifyCertificateClaims(certificate, runtime, resolvedIdentity.value, now);
      verifyImplementationBinding(certificate, resolvedIdentity.value, options.implementationAuthorization);

      let requestVerification;
      try {
        requestVerification = verifySessionRequest(options.request, { now });
      } catch {
        fail("session-request");
      }
      if (!requestVerification.valid || requestVerification.value === undefined) fail("session-request");
      const verifiedRequest = requestVerification.value;
      if (
        verifiedRequest.envelope.certificate !== certificateEvidence.compact ||
        verifiedRequest.certificate.signingInput !== certificate.signingInput ||
        verifiedRequest.certificate.signature !== certificate.signature ||
        verifiedRequest.certificate.header.kid !== certificate.header.kid ||
        verifiedRequest.certificate.payload.repository.id !== resolvedIdentity.value.repositoryId
      ) {
        fail("session-request");
      }
      return authenticatedContext(certificate, verifiedRequest, runtime, resolvedIdentity.value);
    });
  } catch (error: unknown) {
    if (error instanceof SessionAuthenticationError) throw error;
    // #464 deliberately sanitizes errors raised inside the credential scope.
    // Preserve that fail-closed behavior without exposing provider details.
    throw new SessionAuthenticationError("repository-read");
  }
}
