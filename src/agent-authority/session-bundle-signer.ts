/**
 * Bundle-backed Session signer.
 *
 * A credential bundle is a local, signing-only Session capability.  This
 * adapter keeps the parsed private key behind the existing `sign` seam and
 * delegates request construction to the canonical Session signer from #888.
 */

import { sign as ed25519Sign, type KeyObject } from "node:crypto";
import { loadSessionCredentialBundle, type ParsedSessionCredentialBundle } from "./session-bundle.js";
import { createSessionSigner, type SessionSigner } from "./session-signer.js";

/**
 * Adapt one already-parsed bundle to the canonical public Session signer.
 *
 * The private key is captured only by the signing operation.  The returned
 * object is the public-only `SessionSigner`; it does not expose the bundle,
 * private key, or serialized certificate bundle.
 */
export function createSessionBundleSigner(parsed: ParsedSessionCredentialBundle): SessionSigner {
  const { certificate } = parsed;
  const subject = certificate.payload.sub;
  if (!subject.startsWith("session:") || subject.length === "session:".length) {
    throw new TypeError("Session credential certificate subject is not a canonical Session identity.");
  }

  const sessionId = subject.slice("session:".length);
  const privateKey: KeyObject = parsed.privateKey;
  return createSessionSigner({
    sessionId,
    publicKey: certificate.payload.sessionKey,
    certificate,
    sign: (bytes: Uint8Array): Uint8Array => Uint8Array.from(ed25519Sign(null, bytes, privateKey)),
  });
}

/** Load a secure bundle file and adapt it to the canonical Session signer. */
export function loadSessionBundleSigner(filePath: string): SessionSigner {
  return createSessionBundleSigner(loadSessionCredentialBundle(filePath));
}
