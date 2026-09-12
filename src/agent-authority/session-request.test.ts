import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as ed25519Sign } from "node:crypto";
import { test } from "node:test";
import {
  SESSION_REQUEST_ALGORITHM,
  SESSION_REQUEST_DOMAIN,
  SESSION_REQUEST_ENVELOPE_VERSION,
  canonicalizeSemanticRequest,
  createSignedSessionRequestEnvelope,
  encodeSessionCertificateCompact,
  semanticRequestDigest,
  sessionRequestSigningInput,
  signSessionRequest,
  verifySessionRequest,
  type SessionRequestEnvelope,
  type SemanticSessionRequest,
} from "./index.js";
import type { ManagedSession } from "./session-issuance.js";
import {
  SESSION_CERTIFICATE_ALG,
  SESSION_CERTIFICATE_CONTRACT_VERSION,
  SESSION_CERTIFICATE_TYP,
  decodeSessionCertificateCompact,
  type SessionCertificateHeader,
  type SessionCertificatePayload,
} from "./session-certificate.js";

const NOW = 1_800_000_030;
const ISSUED_AT = 1_800_000_000;
const EXPIRES_AT = 1_800_000_060;
const REQUEST_ID = "request-373-vector-01";
const CERTIFICATE_JTI = "certificate-373-vector-01";
const REPOSITORY_ID = "123456789";

// RFC 8032 test key, expressed as a PKCS#8 Ed25519 private key for Node.
const SESSION_PRIVATE_KEY = createPrivateKey({
  key: Buffer.from(
    "302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    "hex",
  ),
  format: "der",
  type: "pkcs8",
});
const SESSION_PUBLIC_KEY = createPublicKey(SESSION_PRIVATE_KEY);
const SESSION_PUBLIC_JWK = SESSION_PUBLIC_KEY.export({ format: "jwk" }) as {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly x: string;
};

const CERTIFICATE_HEADER: SessionCertificateHeader = {
  alg: SESSION_CERTIFICATE_ALG,
  typ: SESSION_CERTIFICATE_TYP,
  kid: "runtime-373-vector",
};
const CERTIFICATE_PAYLOAD: SessionCertificatePayload = {
  ver: SESSION_CERTIFICATE_CONTRACT_VERSION,
  iss: "runtime:runtime-373-vector",
  sub: "session:session-373-vector",
  jti: CERTIFICATE_JTI,
  repository: { id: REPOSITORY_ID, name: "yohn-jp/gh-inari" },
  sessionKey: SESSION_PUBLIC_JWK,
  task: { kind: "issue", number: 373 },
  capabilities: [{ kind: "change.implement", issue: 373 }],
  iat: ISSUED_AT,
  nbf: ISSUED_AT,
  exp: ISSUED_AT + 3600,
};
const CERTIFICATE = encodeSessionCertificateCompact(
  CERTIFICATE_HEADER,
  CERTIFICATE_PAYLOAD,
  Buffer.alloc(64).toString("base64url"),
);
const SUBSTITUTED_PUBLIC_JWK = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }) as {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly x: string;
};
const SUBSTITUTED_CERTIFICATE = encodeSessionCertificateCompact(
  CERTIFICATE_HEADER,
  {
    ...CERTIFICATE_PAYLOAD,
    sub: "session:other-session",
    jti: "certificate-substituted",
    sessionKey: SUBSTITUTED_PUBLIC_JWK,
  },
  Buffer.alloc(64).toString("base64url"),
);

function certificateDecoded() {
  const result = decodeSessionCertificateCompact(CERTIFICATE);
  assert.equal(result.valid, true);
  assert.ok(result.value !== undefined);
  return result.value;
}

function managedSession(captured: { bytes?: Uint8Array } = {}): ManagedSession {
  return {
    sessionId: "session-373-vector",
    publicKey: SESSION_PUBLIC_JWK,
    certificate: certificateDecoded(),
    sign(bytes) {
      captured.bytes = Uint8Array.from(bytes);
      return Uint8Array.from(ed25519Sign(null, bytes, SESSION_PRIVATE_KEY));
    },
    createIssuanceRequest: (() => {
      throw new Error("not used by the request-envelope vector");
    }) as ManagedSession["createIssuanceRequest"],
    acceptCertificate: (() => certificateDecoded()) as ManagedSession["acceptCertificate"],
  };
}

const VECTOR_REQUEST: SemanticSessionRequest = {
  z: ["日本", -0, 1e-7],
  a: { b: true, a: "x" },
  n: 1.5,
};
const VECTOR_CANONICAL_REQUEST = '{"a":{"a":"x","b":true},"n":1.5,"z":["日本",0,1e-7]}';
const VECTOR_REQUEST_DIGEST = "98de8f94ee3f93df0c641c550bcb9fd70c7762f96e068b3262cc730df7924d09";
const VECTOR_SIGNING_INPUT = `${SESSION_REQUEST_DOMAIN}\n${CERTIFICATE_JTI}\n${REPOSITORY_ID}\nchange.implement\n${VECTOR_REQUEST_DIGEST}\n${REQUEST_ID}\n${ISSUED_AT}\n${EXPIRES_AT}`;

test("V1 JCS and SHA-256 conformance vector is byte-stable", () => {
  assert.equal(canonicalizeSemanticRequest(VECTOR_REQUEST), VECTOR_CANONICAL_REQUEST);
  assert.equal(semanticRequestDigest(VECTOR_REQUEST), VECTOR_REQUEST_DIGEST);
  const input = sessionRequestSigningInput({
    certificateJti: CERTIFICATE_JTI,
    repositoryId: REPOSITORY_ID,
    operation: "change.implement",
    request: VECTOR_REQUEST,
    requestId: REQUEST_ID,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
  });
  assert.equal(input.canonicalRequest, VECTOR_CANONICAL_REQUEST);
  assert.equal(input.requestDigest, VECTOR_REQUEST_DIGEST);
  assert.equal(input.signingInput, VECTOR_SIGNING_INPUT);
  assert.deepEqual([...input.signingInputBytes], [...Buffer.from(VECTOR_SIGNING_INPUT, "utf8")]);
  assert.equal(input.signingInput.endsWith("\n"), false);
});

test("signer and verifier share the exact V1 bytes and produce a transport-neutral result", () => {
  const captured: { bytes?: Uint8Array } = {};
  const envelope = signSessionRequest({
    session: managedSession(captured),
    certificate: CERTIFICATE,
    request: VECTOR_REQUEST,
    operation: "change.implement",
    requestId: REQUEST_ID,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
  });
  assert.deepEqual([...captured.bytes!], [...Buffer.from(VECTOR_SIGNING_INPUT, "utf8")]);
  assert.equal(envelope.version, SESSION_REQUEST_ENVELOPE_VERSION);
  assert.equal(envelope.alg, SESSION_REQUEST_ALGORITHM);
  assert.equal("privateKey" in envelope, false);

  const result = verifySessionRequest(envelope, { now: NOW });
  assert.equal(result.valid, true);
  assert.equal(result.value?.requestDigest, VECTOR_REQUEST_DIGEST);
  assert.equal(result.value?.signingInput, VECTOR_SIGNING_INPUT);
  assert.deepEqual([...result.value!.signingInputBytes], [...captured.bytes!]);
  assert.deepEqual(result.value?.envelope.request, JSON.parse(VECTOR_CANONICAL_REQUEST));
});

test("signer uses only the ManagedSession signing seam and refuses certificate substitution", () => {
  const session = managedSession();
  const originalSign = session.sign;
  let calls = 0;
  const instrumented = {
    ...session,
    sign(bytes: Uint8Array) {
      calls += 1;
      return originalSign(bytes);
    },
  };
  const envelope = createSignedSessionRequestEnvelope({
    session: instrumented,
    request: VECTOR_REQUEST,
    operation: "change.implement",
    requestId: "request-seam",
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
  });
  assert.equal(calls, 1);
  assert.equal(verifySessionRequest(envelope, { now: NOW }).valid, true);
  assert.throws(
    () =>
      signSessionRequest({
        session,
        certificate: SUBSTITUTED_CERTIFICATE,
        request: {},
        operation: "change.implement",
        requestId: "request-substitution",
        issuedAt: ISSUED_AT,
        expiresAt: EXPIRES_AT,
      }),
    /Certificate/i,
  );
});

test("verification rejects field tampering, key/signature substitution, and certificate binding drift", () => {
  const envelope = signSessionRequest({
    session: managedSession(),
    certificate: CERTIFICATE,
    request: VECTOR_REQUEST,
    operation: "change.implement",
    requestId: REQUEST_ID,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
  });
  const tampered = (patch: Partial<SessionRequestEnvelope>) =>
    verifySessionRequest({ ...envelope, ...patch }, { now: NOW }).valid;
  assert.equal(tampered({ operation: "change.ready" }), false);
  assert.equal(tampered({ requestId: "request-other" }), false);
  assert.equal(tampered({ request: { ...VECTOR_REQUEST, n: 2 } }), false);
  assert.equal(tampered({ repositoryId: "987654321" }), false);
  assert.equal(tampered({ certificateJti: "certificate-other" }), false);
  assert.equal(tampered({ signature: Buffer.alloc(64, 1).toString("base64url") }), false);
  assert.equal(tampered({ expiresAt: EXPIRES_AT + 1 }), false);
});

test("verification rejects expired/future requests and bounded-window violations", () => {
  const make = (issuedAt: number, expiresAt: number) =>
    signSessionRequest({
      session: managedSession(),
      certificate: CERTIFICATE,
      request: {},
      operation: "change.implement",
      requestId: `request-${issuedAt}`,
      issuedAt,
      expiresAt,
    });
  assert.equal(verifySessionRequest(make(ISSUED_AT, EXPIRES_AT), { now: EXPIRES_AT }).valid, false);
  assert.equal(verifySessionRequest(make(NOW + 10, NOW + 20), { now: NOW }).valid, false);
  assert.throws(() => make(ISSUED_AT, ISSUED_AT + 301), /signing fields are invalid/i);
});

test("unknown envelope fields, versions, algorithms, and bearer-only use fail closed", () => {
  const envelope = signSessionRequest({
    session: managedSession(),
    certificate: CERTIFICATE,
    request: {},
    operation: "change.implement",
    requestId: "request-shape",
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
  });
  assert.equal(verifySessionRequest({ ...envelope, extra: true }, { now: NOW }).valid, false);
  assert.equal(verifySessionRequest({ ...envelope, version: 2 }, { now: NOW }).valid, false);
  assert.equal(verifySessionRequest({ ...envelope, alg: "none" }, { now: NOW }).valid, false);
  assert.throws(
    () =>
      signSessionRequest({
        session: { ...managedSession(), certificate: undefined },
        request: {},
        operation: "change.implement",
        requestId: "request-bearer",
        issuedAt: ISSUED_AT,
        expiresAt: EXPIRES_AT,
      }),
    /Certificate/i,
  );
});

test("request digest is lowercase SHA-256 of JCS UTF-8 bytes", () => {
  const expected = createHash("sha256").update(Buffer.from(VECTOR_CANONICAL_REQUEST, "utf8")).digest("hex");
  assert.equal(expected, VECTOR_REQUEST_DIGEST);
  assert.match(expected, /^[0-9a-f]{64}$/u);
});
