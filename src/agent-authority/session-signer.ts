/**
 * Transport-neutral Session request signer capability.
 *
 * The capability owns no transport, provider credential, or private-key
 * serialization. It projects only the public Session principal and delegates
 * envelope construction to `session-request.ts`, the single canonical request
 * authority.
 */

import {
  signSessionRequest,
  type SemanticSessionRequest,
  type SessionRequestEnvelope,
  type SessionSigningPrincipal,
} from "./session-request.js";
import {
  decodeSessionCertificateCompact,
  encodeSessionCertificateCompact,
  type DecodedSessionCertificate,
} from "./session-certificate.js";
import type { ManagedRuntimeSession } from "./managed-runtime.js";

export interface SessionSignerRequestOptions {
  readonly request: SemanticSessionRequest;
  readonly operation: string;
  readonly requestId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/** Bounded, public-only metadata useful to a transport adapter. */
export interface SessionSignerMetadata {
  readonly sessionId: string;
  readonly publicKey: SessionSigningPrincipal["publicKey"];
  readonly certificateJti?: string;
  readonly repositoryId?: string;
}

/**
 * Canonical client-side Session signer capability.
 *
 * `sign` is the existing opaque proof-of-possession seam. `signRequest`
 * remains the only request-level operation and uses the canonical envelope
 * implementation shared with the verifier.
 */
export interface SessionSigner extends SessionSigningPrincipal {
  readonly metadata: SessionSignerMetadata;
  readonly signRequest: (options: SessionSignerRequestOptions) => SessionRequestEnvelope;
}

function publicKeyProjection(principal: SessionSigningPrincipal): SessionSigningPrincipal["publicKey"] {
  return Object.freeze({
    kty: principal.publicKey.kty,
    crv: principal.publicKey.crv,
    x: principal.publicKey.x,
  });
}

function certificateProjection(
  certificate: DecodedSessionCertificate | undefined,
): DecodedSessionCertificate | undefined {
  if (certificate === undefined) return undefined;
  const compact = encodeSessionCertificateCompact(certificate.header, certificate.payload, certificate.signature);
  const decoded = decodeSessionCertificateCompact(compact);
  if (!decoded.valid || decoded.value === undefined) {
    throw new TypeError("Session signer certificate must be a canonical public Session Certificate.");
  }
  return decoded.value;
}

function metadataFor(principal: SessionSigningPrincipal): SessionSignerMetadata {
  const certificate = principal.certificate;
  return Object.freeze({
    sessionId: principal.sessionId,
    publicKey: publicKeyProjection(principal),
    ...(certificate === undefined
      ? {}
      : { certificateJti: certificate.payload.jti, repositoryId: certificate.payload.repository.id }),
  });
}

/**
 * Adapt any Session signing principal to the public request signer contract.
 * The returned object copies only public fields and closes over the existing
 * `sign(bytes)` capability; it never receives a private key.
 */
export function createSessionSigner(principal: SessionSigningPrincipal): SessionSigner {
  const sessionId = principal.sessionId;
  const publicKey = publicKeyProjection(principal);
  const certificate = certificateProjection(principal.certificate);
  const metadata = metadataFor({ sessionId, publicKey, certificate, sign: principal.sign });
  const sign = (bytes: Uint8Array): Uint8Array => principal.sign(bytes);
  const signRequest = (options: SessionSignerRequestOptions): SessionRequestEnvelope =>
    signSessionRequest({
      session: {
        sessionId,
        publicKey,
        get certificate() {
          return certificate;
        },
        sign,
      },
      ...options,
    });

  return Object.freeze({
    sessionId,
    publicKey,
    get certificate(): DecodedSessionCertificate | undefined {
      return certificate;
    },
    sign,
    metadata,
    signRequest,
  });
}

/** Adapt a completed managed-runtime Session without exposing its key material. */
export function adaptManagedRuntimeSession(managed: ManagedRuntimeSession): SessionSigner {
  const signer = createSessionSigner(managed.session);
  return Object.freeze({
    ...signer,
    signRequest: managed.signRequest,
  });
}
