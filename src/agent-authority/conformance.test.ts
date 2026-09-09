import assert from "node:assert/strict";
import { createPublicKey, verify as edVerify } from "node:crypto";
import { test } from "node:test";
import { validateRuntimeAuthority } from "./runtime-authority.js";
import {
  decodeSessionCertificateCompact,
  sessionCertificateSigningInput,
  validateSessionCertificateHeader,
  validateSessionCertificatePayload,
  type SessionCertificateHeader,
  type SessionCertificatePayload,
} from "./session-certificate.js";
import {
  GOLDEN_SESSION_CERTIFICATE,
  RUNTIME_AUTHORITY_VECTORS,
  SESSION_CERTIFICATE_HEADER_VECTORS,
  SESSION_CERTIFICATE_PAYLOAD_VECTORS,
} from "./fixtures.js";

test("Runtime Authority conformance vectors", () => {
  for (const vector of RUNTIME_AUTHORITY_VECTORS) {
    const result = validateRuntimeAuthority(vector.input);
    assert.equal(result.valid, vector.valid, `vector "${vector.name}" expected valid=${vector.valid}`);
  }
});

test("Session Certificate header conformance vectors", () => {
  for (const vector of SESSION_CERTIFICATE_HEADER_VECTORS) {
    const result = validateSessionCertificateHeader(vector.input);
    assert.equal(result.valid, vector.valid, `vector "${vector.name}" expected valid=${vector.valid}`);
  }
});

test("Session Certificate payload conformance vectors", () => {
  for (const vector of SESSION_CERTIFICATE_PAYLOAD_VECTORS) {
    const result = validateSessionCertificatePayload(vector.input);
    assert.equal(result.valid, vector.valid, `vector "${vector.name}" expected valid=${vector.valid}`);
  }
});

test("golden Session Certificate: canonical signing input is reproducible byte-for-byte", () => {
  const { encodedHeader, encodedPayload, signingInput } = sessionCertificateSigningInput(
    GOLDEN_SESSION_CERTIFICATE.header as unknown as SessionCertificateHeader,
    GOLDEN_SESSION_CERTIFICATE.payload as unknown as SessionCertificatePayload,
  );
  const [expectedHeader, expectedPayload] = GOLDEN_SESSION_CERTIFICATE.compact.split(".");
  assert.equal(encodedHeader, expectedHeader);
  assert.equal(encodedPayload, expectedPayload);
  assert.equal(`${signingInput}.${GOLDEN_SESSION_CERTIFICATE.signature}`, GOLDEN_SESSION_CERTIFICATE.compact);
});

test("golden Session Certificate: decodes and its Ed25519 signature verifies against the fixed test public key", () => {
  const decoded = decodeSessionCertificateCompact(GOLDEN_SESSION_CERTIFICATE.compact);
  assert.equal(decoded.valid, true);
  assert.equal(decoded.value?.signature, GOLDEN_SESSION_CERTIFICATE.signature);

  const publicKey = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: GOLDEN_SESSION_CERTIFICATE.testOnlyRuntimeKeyPair.x },
    format: "jwk",
  });
  const verified = edVerify(
    null,
    Buffer.from(decoded.value?.signingInput as string, "utf8"),
    publicKey,
    Buffer.from(GOLDEN_SESSION_CERTIFICATE.signature, "base64url"),
  );
  assert.equal(verified, true);
});

test("golden Session Certificate: a single tampered byte breaks signature verification", () => {
  // Flip the first character of the signature segment, well inside its significant bits.
  const lastDot = GOLDEN_SESSION_CERTIFICATE.compact.lastIndexOf(".");
  const flipIndex = lastDot + 1;
  const original = GOLDEN_SESSION_CERTIFICATE.compact[flipIndex];
  const replacement = original === "A" ? "B" : "A";
  const tampered =
    GOLDEN_SESSION_CERTIFICATE.compact.slice(0, flipIndex) +
    replacement +
    GOLDEN_SESSION_CERTIFICATE.compact.slice(flipIndex + 1);
  const decoded = decodeSessionCertificateCompact(tampered);
  if (!decoded.valid || decoded.value === undefined) return; // structural rejection is an acceptable outcome too.
  const publicKey = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: GOLDEN_SESSION_CERTIFICATE.testOnlyRuntimeKeyPair.x },
    format: "jwk",
  });
  const verified = edVerify(
    null,
    Buffer.from(decoded.value.signingInput, "utf8"),
    publicKey,
    Buffer.from(decoded.value.signature, "base64url"),
  );
  assert.equal(verified, false);
});
