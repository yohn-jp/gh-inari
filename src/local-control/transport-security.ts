/** Owner-only mTLS identities for the non-loopback local Runtime boundary. */

import { createPrivateKey, X509Certificate } from "node:crypto";
import type { PeerCertificate } from "node:tls";
import { readLocalPrivateFile, type LocalComponent } from "./config.js";

const COMPONENT_CERTIFICATE_FILE = "mtls-certificate.pem";
const COMPONENT_PRIVATE_KEY_FILE = "mtls-private-key.pem";
const COMPONENT_CA_CERTIFICATE_FILE = "mtls-ca-certificate.pem";

/**
 * Runtime mTLS roles. `control` is the control-plane principal (CLI / setup
 * host) that may observe Executor owner state; it never holds execution
 * authority. The browser is never an mTLS principal.
 */
export type LocalMtlsRole = "admission" | "executor" | "control";

export interface LocalMtlsIdentity {
  readonly certificate: Buffer;
  readonly privateKey: Buffer;
  readonly caCertificate: Buffer;
  readonly peerId: string;
  readonly peerRole: LocalMtlsRole;
}

export class LocalTransportSecurityError extends Error {
  readonly code = "LOCAL_TRANSPORT_MTLS_CONFIGURATION_INVALID" as const;

  constructor() {
    super("Non-loopback local Runtime requires a valid owner-only mTLS identity.");
    this.name = "LocalTransportSecurityError";
  }
}

function hasIdentity(certificate: X509Certificate, role: LocalMtlsRole, id: string): boolean {
  const identity = `URI:urn:inari:local:${role}:${id}`;
  return certificate.subjectAltName?.split(/,\s*/u).includes(identity) ?? false;
}

function validNow(certificate: X509Certificate): boolean {
  const now = Date.now();
  return Date.parse(certificate.validFrom) <= now && Date.parse(certificate.validTo) > now;
}

function parseCertificate(bytes: Buffer): X509Certificate {
  return new X509Certificate(bytes);
}

function assertIdentityCertificate(bytes: Buffer, role: LocalMtlsRole, id: string): X509Certificate {
  const certificate = parseCertificate(bytes);
  if (!validNow(certificate) || !hasIdentity(certificate, role, id)) throw new LocalTransportSecurityError();
  return certificate;
}

/** Load one component's private identity and the shared public CA without returning file paths. */
export function loadLocalMtlsIdentity(
  component: Extract<LocalComponent, "admission" | "executor">,
  ownId: string,
  peerId: string,
  environment: NodeJS.ProcessEnv = process.env,
): LocalMtlsIdentity {
  const peerRole: LocalMtlsRole = component === "admission" ? "executor" : "admission";
  const certificateBytes = readLocalPrivateFile(component, COMPONENT_CERTIFICATE_FILE, environment);
  const privateKeyBytes = readLocalPrivateFile(component, COMPONENT_PRIVATE_KEY_FILE, environment);
  const caCertificateBytes = readLocalPrivateFile(component, COMPONENT_CA_CERTIFICATE_FILE, environment);
  if (certificateBytes === undefined || privateKeyBytes === undefined || caCertificateBytes === undefined) {
    throw new LocalTransportSecurityError();
  }
  return verifiedIdentity(component, ownId, peerRole, peerId, certificateBytes, privateKeyBytes, caCertificateBytes);
}

/** Control-plane principal identity: `ctl_` followed by a bounded opaque ID. */
export function isLocalControlId(value: unknown): value is string {
  return typeof value === "string" && /^ctl_[A-Za-z0-9_-]{16,64}$/u.test(value);
}

/** Explicitly supplied identity material; its storage and provisioning belong to the caller (#1223). */
export interface LocalMtlsIdentityMaterial {
  readonly certificate: Buffer;
  readonly privateKey: Buffer;
  readonly caCertificate: Buffer;
}

/**
 * Validate an explicitly supplied Control identity that observes the pinned
 * Executor. The certificate must carry `urn:inari:local:control:<controlId>`,
 * match its private key and chain to the supplied CA. No file is read here.
 */
export function createLocalControlMtlsIdentity(
  controlId: string,
  executorId: string,
  material: LocalMtlsIdentityMaterial,
): LocalMtlsIdentity {
  if (!isLocalControlId(controlId) || !/^exec_[A-Za-z0-9_-]{16,64}$/u.test(executorId))
    throw new LocalTransportSecurityError();
  return verifiedIdentity(
    "control",
    controlId,
    "executor",
    executorId,
    material.certificate,
    material.privateKey,
    material.caCertificate,
  );
}

function verifiedIdentity(
  role: LocalMtlsRole,
  ownId: string,
  peerRole: LocalMtlsRole,
  peerId: string,
  certificateBytes: Buffer,
  privateKeyBytes: Buffer,
  caCertificateBytes: Buffer,
): LocalMtlsIdentity {
  try {
    const certificate = assertIdentityCertificate(certificateBytes, role, ownId);
    const privateKey = createPrivateKey(privateKeyBytes);
    if (!certificate.checkPrivateKey(privateKey)) throw new LocalTransportSecurityError();
    const caCertificate = parseCertificate(caCertificateBytes);
    if (
      !caCertificate.ca ||
      !validNow(caCertificate) ||
      certificate.issuer !== caCertificate.subject ||
      !certificate.verify(caCertificate.publicKey)
    ) {
      throw new LocalTransportSecurityError();
    }
    return {
      certificate: certificateBytes,
      privateKey: privateKeyBytes,
      caCertificate: caCertificateBytes,
      peerId,
      peerRole,
    };
  } catch (error: unknown) {
    if (error instanceof LocalTransportSecurityError) throw error;
    throw new LocalTransportSecurityError();
  }
}

/** Verify a TLS peer's signed URI identity after the TLS stack validates its certificate chain. */
export function verifyLocalMtlsPeerIdentity(
  peer: Pick<PeerCertificate, "raw">,
  role: LocalMtlsRole,
  id: string,
): boolean {
  if (!(peer.raw instanceof Buffer)) return false;
  try {
    const certificate = parseCertificate(peer.raw);
    return validNow(certificate) && hasIdentity(certificate, role, id);
  } catch {
    return false;
  }
}
