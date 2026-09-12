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
import type { GitHubChangeEffectRepository } from "../github/change-effect-adapter.js";
import type { RepositoryContext, RepositoryTree, RepositoryTreeEntry, GitHubBranch } from "../github/types.js";
import {
  MAX_UNIX_TIME_SECONDS,
  SESSION_CERTIFICATE_ALG,
  SESSION_CERTIFICATE_TYP,
  decodeSessionCertificateCompact,
  evaluateSessionCertificateAgainstRuntimeAuthority,
  type DecodedSessionCertificate,
  type SessionCertificateTask,
} from "./session-certificate.js";
import {
  resolveRuntimeAuthority,
  type RuntimeAuthoritySourceReader,
  type LoadedRuntimeAuthority,
} from "./runtime-authority-trust.js";
import type { CapabilityClaim } from "./capability.js";
import { verifySessionRequest, type VerifiedSessionRequest } from "./session-request.js";
import { validateIssuerRepositoryIdentity, type IssuerRepositoryIdentity } from "../github/issuer-authority.js";

const MAX_REPOSITORY_REF_LENGTH = 255;
const MAX_REPOSITORY_SHA_LENGTH = 128;
const MAX_BLOB_CONTENT_LENGTH = 1_048_576;
const SAFE_REPOSITORY_TEXT = /^[^\u0000-\u001f\u007f]+$/u;
const BASE64_CONTENT_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

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
  /** One request-local verification clock. Defaults to the current time. */
  readonly now?: Date | number | (() => Date | number);
}

export type AuthenticatedSessionRepository = IssuerRepositoryIdentity;

export interface AuthenticatedSessionRuntimeAuthority {
  /** Runtime Authority record identifier, as resolved by `kid`. */
  readonly id: string;
  /** Certificate header key identifier; retained explicitly for diagnostics. */
  readonly kid: string;
}

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
  readonly runtimeAuthority: AuthenticatedSessionRuntimeAuthority;
  readonly session: AuthenticatedSessionIdentity;
  readonly task?: SessionCertificateTask;
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

function isBoundedProviderText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && SAFE_REPOSITORY_TEXT.test(value);
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

function repositoryFromScope(capability: GitHubAppRepositoryReadCapability): GitHubChangeEffectRepository {
  const scope = capability.scope;
  const target = scope.repository;
  if (
    !isRecord(target) ||
    !isBoundedProviderText(target.repositoryHost, 255) ||
    !isBoundedProviderText(target.nameWithOwner, 255)
  ) {
    fail("repository");
  }
  const identity = validateIssuerRepositoryIdentity(target);
  if (!identity.valid || identity.value === undefined) fail("repository");
  const parts = target.nameWithOwner.split("/");
  if (parts.length !== 2 || parts.some((part) => !isBoundedProviderText(part, 255))) fail("repository");
  return Object.freeze({
    hostname: identity.value.repositoryHost,
    owner: parts[0] as string,
    name: parts[1] as string,
  });
}

function sameRepositoryLocator(left: GitHubChangeEffectRepository, right: GitHubChangeEffectRepository): boolean {
  return (
    left.hostname.toLowerCase() === right.hostname.toLowerCase() &&
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.name.toLowerCase() === right.name.toLowerCase()
  );
}

function sameRepositoryIdentity(left: IssuerRepositoryIdentity, right: IssuerRepositoryIdentity): boolean {
  return (
    left.repositoryHost.toLowerCase() === right.repositoryHost.toLowerCase() &&
    left.repositoryId === right.repositoryId &&
    left.nameWithOwner.toLowerCase() === right.nameWithOwner.toLowerCase()
  );
}

function repositoryContext(identity: IssuerRepositoryIdentity): RepositoryContext {
  const parts = identity.nameWithOwner.split("/");
  if (parts.length !== 2) fail("repository");
  const owner = parts[0] as string;
  const name = parts[1] as string;
  return Object.freeze({
    hostname: identity.repositoryHost,
    host: identity.repositoryHost,
    owner,
    name,
    nameWithOwner: identity.nameWithOwner,
    url: `https://${identity.repositoryHost}/${identity.nameWithOwner}`,
    repositoryId: identity.repositoryId,
  });
}

async function readProvider(
  capability: GitHubAppRepositoryReadCapability,
  repository: GitHubChangeEffectRepository,
  path: string,
): Promise<Record<string, unknown>> {
  let response: { readonly status: number; readonly body?: unknown };
  try {
    response = await capability.transport.request({ hostname: repository.hostname, method: "GET", path });
  } catch {
    fail("repository-read");
  }
  if (response.status !== 200 || !isRecord(response.body)) fail("repository-read");
  return response.body;
}

function repositoryPath(repository: GitHubChangeEffectRepository, suffix = ""): string {
  const root = `repos/${repository.owner}/${repository.name}`;
  return suffix.length === 0 ? root : `${root}/${suffix}`;
}

function createRuntimeAuthoritySourceReader(
  capability: GitHubAppRepositoryReadCapability,
  repository: GitHubChangeEffectRepository,
  identity: IssuerRepositoryIdentity,
): RuntimeAuthoritySourceReader {
  const context = repositoryContext(identity);
  return {
    resolveRepositoryContext: async () => context,
    getRepositoryDefaultBranch: async () => {
      const body = await readProvider(capability, repository, repositoryPath(repository));
      if (!isBoundedProviderText(body.default_branch, MAX_REPOSITORY_REF_LENGTH)) fail("repository-read");
      return body.default_branch;
    },
    findBranch: async (branch: string): Promise<GitHubBranch | undefined> => {
      if (!isBoundedProviderText(branch, MAX_REPOSITORY_REF_LENGTH)) fail("repository-read");
      let response: { readonly status: number; readonly body?: unknown };
      try {
        response = await capability.transport.request({
          hostname: repository.hostname,
          method: "GET",
          path: repositoryPath(repository, `git/ref/heads/${encodeURIComponent(branch)}`),
        });
      } catch {
        fail("repository-read");
      }
      if (response.status === 404) return undefined;
      if (response.status !== 200 || !isRecord(response.body)) fail("repository-read");
      const body = response.body;
      if (
        body.ref !== `refs/heads/${branch}` ||
        !isRecord(body.object) ||
        body.object.type !== "commit" ||
        !isBoundedProviderText(body.object.sha, MAX_REPOSITORY_SHA_LENGTH)
      ) {
        fail("repository-read");
      }
      return { name: branch, ref: body.ref, sha: body.object.sha };
    },
    getRepositoryTree: async (ref: string): Promise<RepositoryTree> => {
      if (!isBoundedProviderText(ref, MAX_REPOSITORY_SHA_LENGTH)) fail("repository-read");
      const body = await readProvider(
        capability,
        repository,
        repositoryPath(repository, `git/trees/${encodeURIComponent(ref)}?recursive=1`),
      );
      if (body.truncated !== false || !isBoundedProviderText(body.sha, MAX_REPOSITORY_SHA_LENGTH)) {
        fail("repository-read");
      }
      if (!Array.isArray(body.tree)) fail("repository-read");
      const entries: RepositoryTreeEntry[] = body.tree.map((entry: unknown) => {
        if (
          !isRecord(entry) ||
          !isBoundedProviderText(entry.path, MAX_REPOSITORY_REF_LENGTH) ||
          !isBoundedProviderText(entry.sha, MAX_REPOSITORY_SHA_LENGTH) ||
          (entry.type !== "blob" && entry.type !== "tree")
        ) {
          fail("repository-read");
        }
        return { path: entry.path, type: entry.type, sha: entry.sha };
      });
      return { sha: body.sha, entries };
    },
    getRepositoryBlob: async (sha: string): Promise<string> => {
      if (!isBoundedProviderText(sha, MAX_REPOSITORY_SHA_LENGTH)) fail("repository-read");
      const body = await readProvider(
        capability,
        repository,
        repositoryPath(repository, `git/blobs/${encodeURIComponent(sha)}`),
      );
      if (
        body.sha !== sha ||
        body.encoding !== "base64" ||
        typeof body.content !== "string" ||
        body.content.length > MAX_BLOB_CONTENT_LENGTH
      ) {
        fail("repository-read");
      }
      const content = body.content.replace(/\s/gu, "");
      if (!BASE64_CONTENT_PATTERN.test(content)) fail("repository-read");
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(content, "base64"));
      } catch {
        fail("repository-read");
      }
    },
  };
}

function verifyRuntimeSignature(certificate: DecodedSessionCertificate, runtime: LoadedRuntimeAuthority): void {
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
  runtime: LoadedRuntimeAuthority,
  repository: IssuerRepositoryIdentity,
  now: Date,
): void {
  const evaluation = evaluateSessionCertificateAgainstRuntimeAuthority(certificate, {
    runtimeAuthority: runtime.authority,
    expectedRepositoryId: repository.repositoryId,
    now,
  });
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (!evaluation.admitted || nowSeconds < certificate.payload.nbf || nowSeconds >= certificate.payload.exp) {
    fail("certificate");
  }
}

function sessionId(subject: string): string {
  return subject.startsWith("session:") ? subject.slice("session:".length) : subject;
}

function authenticatedContext(
  certificate: DecodedSessionCertificate,
  verifiedRequest: VerifiedSessionRequest,
  runtime: LoadedRuntimeAuthority,
  repository: IssuerRepositoryIdentity,
): AuthenticatedSessionContext {
  const payload = certificate.payload;
  const context: AuthenticatedSessionContext = {
    repository: Object.freeze({ ...repository }),
    runtimeAuthority: Object.freeze({ id: runtime.authority.id, kid: certificate.header.kid }),
    session: Object.freeze({ id: sessionId(payload.sub), certificateJti: payload.jti }),
    ...(payload.task === undefined ? {} : { task: Object.freeze({ ...payload.task }) }),
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
      const scopedRepository = repositoryFromScope(capability);
      if (!sameRepositoryLocator(options.repository, scopedRepository)) fail("repository");

      let resolvedRepository: Awaited<ReturnType<typeof resolveGitHubRepository>>;
      try {
        resolvedRepository = await resolveGitHubRepository(options.repository, capability.transport);
      } catch {
        fail("repository-read");
      }
      const resolvedIdentity = validateIssuerRepositoryIdentity(resolvedRepository.target);
      if (!resolvedIdentity.valid || resolvedIdentity.value === undefined) fail("repository");
      if (!sameRepositoryIdentity(resolvedIdentity.value, capability.scope.repository)) fail("repository");

      const reader = createRuntimeAuthoritySourceReader(capability, options.repository, resolvedIdentity.value);
      let runtime: LoadedRuntimeAuthority;
      try {
        runtime = await resolveRuntimeAuthority(reader, certificate.header.kid, { now });
      } catch {
        fail("runtime-trust");
      }

      verifyRuntimeSignature(certificate, runtime);
      verifyCertificateClaims(certificate, runtime, resolvedIdentity.value, now);

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

/** Explicit boundary-oriented alias for consumers that use `verify` terminology. */
export const verifySessionRequestAtAppBoundary = authenticateSessionRequest;

/** Alias matching the App/executor terminology used by the architecture. */
export const authenticateAppSession = authenticateSessionRequest;
