/** Owner-only mTLS identities for the non-loopback local Runtime boundary. */

import { createPrivateKey, X509Certificate } from "node:crypto";
import type { PeerCertificate } from "node:tls";
import { readLocalPrivateFile, type LocalComponent } from "./config.js";

const COMPONENT_CERTIFICATE_FILE = "mtls-certificate.pem";
const COMPONENT_PRIVATE_KEY_FILE = "mtls-private-key.pem";
const COMPONENT_CA_CERTIFICATE_FILE = "mtls-ca-certificate.pem";

export type LocalMtlsRole = "admission" | "executor";

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
    super("Non-loopback local Runtime requires valid owner-only Admission and Executor mTLS identities.");
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

  try {
    const certificate = assertIdentityCertificate(certificateBytes, component, ownId);
    const privateKey = createPrivateKey(privateKeyBytes);
    if (!certificate.checkPrivateKey(privateKey)) throw new LocalTransportSecurityError();
    const caCertificate = parseCertificate(caCertificateBytes);
    if (!caCertificate.ca || !validNow(caCertificate)) throw new LocalTransportSecurityError();
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
