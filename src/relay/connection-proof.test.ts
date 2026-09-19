import assert from "node:assert/strict";
import { generateKeyPairSync, sign as ed25519Sign, type KeyObject } from "node:crypto";
import { test } from "node:test";
import {
  SESSION_CERTIFICATE_ALG,
  SESSION_CERTIFICATE_CONTRACT_VERSION,
  SESSION_CERTIFICATE_TYP,
  encodeSessionCertificateCompact,
  sessionCertificateSigningInput,
  type SessionCertificateHeader,
  type SessionCertificatePayload,
} from "../agent-authority/session-certificate.js";
import {
  createRelayPossessionProofChallenge,
  decodeRelayPossessionProofResponse,
  encodeRelayPossessionProofResponse,
  signRelayPossessionProof,
  verifyRelayPossessionProof,
  verifySessionCertificateConnectionBinding,
  type RelayConnectionKeyBinding,
} from "./connection-proof.js";
import type { Ed25519PublicJwk } from "../agent-authority/ed25519-jwk.js";

const repositoryId = "1330755860";
const delegatorId = "runtime-relay-817";

type Ed25519KeyPair = { readonly privateKey: KeyObject; readonly publicKey: KeyObject };

function keyPair(): Ed25519KeyPair {
  return generateKeyPairSync("ed25519");
}

function publicJwk(key: KeyObject): Ed25519PublicJwk {
  return key.export({ format: "jwk" }) as Ed25519PublicJwk;
}

function challenge(overrides: Record<string, unknown> = {}) {
  return createRelayPossessionProofChallenge({
    repositoryId,
    delegatorId,
    nonce: "bm9uY2UtODE3",
    issuedAtMs: 10_000,
    expiresAtMs: 20_000,
    ...overrides,
  });
}

test("challenge and response are bounded, canonical, and prove only key possession", () => {
  const { privateKey } = keyPair();
  const proofChallenge = challenge();
  const response = signRelayPossessionProof(proofChallenge, privateKey);
  const encoded = encodeRelayPossessionProofResponse(response);
  assert.deepEqual(decodeRelayPossessionProofResponse(encoded), response);

  const usedNonces = new Set<string>();
  const verified = verifyRelayPossessionProof(proofChallenge, response, { nowMs: 15_000, usedNonces });
  assert.equal(verified.valid, true);
  assert.equal(verified.value?.repositoryId, repositoryId);
  assert.equal(verified.value?.delegatorId, delegatorId);
  assert.equal("privateKey" in (verified.value ?? {}), false);
  assert.equal(usedNonces.has(proofChallenge.nonce), true);
  const replay = verifyRelayPossessionProof(proofChallenge, response, { nowMs: 15_000, usedNonces });
  assert.equal(replay.valid, false);
  assert.equal(replay.diagnostics[0]?.code, "RELAY_PROOF_REPLAYED_NONCE");

  const missingReplayState = verifyRelayPossessionProof(proofChallenge, response, undefined as never);
  assert.equal(missingReplayState.valid, false);
  assert.equal(missingReplayState.diagnostics[0]?.code, "RELAY_PROOF_REPLAY_STATE_REQUIRED");
});

test("wrong key, challenge binding, expiry, malformed key, and malformed signature fail deterministically", () => {
  const first = keyPair();
  const second = keyPair();
  const proofChallenge = challenge();
  const response = signRelayPossessionProof(proofChallenge, first.privateKey);

  const wrongKey = { ...response, publicKey: publicJwk(second.publicKey) };
  const wrongKeyResult = verifyRelayPossessionProof(proofChallenge, wrongKey, {
    nowMs: 15_000,
    usedNonces: new Set(),
  });
  assert.equal(wrongKeyResult.valid, false);
  assert.equal(wrongKeyResult.diagnostics[0]?.code, "RELAY_PROOF_INVALID_SIGNATURE");

  const wrongRepository = verifyRelayPossessionProof(challenge({ repositoryId: "1330755861" }), response, {
    nowMs: 15_000,
    usedNonces: new Set(),
  });
  assert.equal(wrongRepository.valid, false);
  assert.equal(wrongRepository.diagnostics[0]?.code, "RELAY_PROOF_CHALLENGE_MISMATCH");

  const expired = verifyRelayPossessionProof(proofChallenge, response, { nowMs: 20_000, usedNonces: new Set() });
  assert.equal(expired.valid, false);
  assert.equal(expired.diagnostics[0]?.code, "RELAY_PROOF_EXPIRED");

  const malformed = verifyRelayPossessionProof(
    proofChallenge,
    {
      ...response,
      publicKey: { kty: "OKP", crv: "Ed25519", x: "bad" },
      signature: "bad",
    },
    { nowMs: 15_000, usedNonces: new Set() },
  );
  assert.equal(malformed.valid, false);
  assert.ok(malformed.diagnostics.some((entry) => entry.code === "RELAY_PROOF_INVALID_KEY"));
  assert.ok(malformed.diagnostics.some((entry) => entry.code === "RELAY_PROOF_INVALID_SIGNATURE"));
});

function signedCertificate(signer: Ed25519KeyPair, overrides: Record<string, unknown> = {}): string {
  const header: SessionCertificateHeader = {
    alg: SESSION_CERTIFICATE_ALG,
    typ: SESSION_CERTIFICATE_TYP,
    kid: delegatorId,
  };
  const payload: SessionCertificatePayload = {
    ver: SESSION_CERTIFICATE_CONTRACT_VERSION,
    iss: `runtime:${delegatorId}`,
    sub: "session:01HXRELAY81700000000000000",
    jti: "01HXRELAY81700000000000001",
    repository: { id: repositoryId, name: "yohn-jp/gh-inari" },
    sessionKey: publicJwk(signer.publicKey),
    task: { kind: "issue", number: 817 },
    capabilities: [{ kind: "change.implement", issue: 817 }],
    iat: 1_757_347_200,
    nbf: 1_757_347_200,
    exp: 1_757_354_400,
    ...overrides,
  };
  const { signingInput } = sessionCertificateSigningInput(header, payload);
  const signature = ed25519Sign(null, Buffer.from(signingInput, "utf8"), signer.privateKey).toString("base64url");
  return encodeSessionCertificateCompact(header, payload, signature);
}

test("routing binding checks certificate repository, kid, and canonical certificate signature only", () => {
  const signer = keyPair();
  const certificate = signedCertificate(signer);
  const connection = {
    repositoryId,
    delegatorId,
    publicKey: publicJwk(signer.publicKey),
  } satisfies RelayConnectionKeyBinding;
  assert.equal(verifySessionCertificateConnectionBinding(certificate, connection).valid, true);

  const wrongKey = keyPair();
  const wrongConnection = { ...connection, publicKey: publicJwk(wrongKey.publicKey) };
  assert.equal(verifySessionCertificateConnectionBinding(certificate, wrongConnection).valid, false);
  assert.equal(
    verifySessionCertificateConnectionBinding(certificate, { ...connection, repositoryId: "1330755861" }).diagnostics[0]
      ?.code,
    "RELAY_PROOF_CERTIFICATE_REPOSITORY_MISMATCH",
  );
  assert.equal(
    verifySessionCertificateConnectionBinding(certificate, { ...connection, delegatorId: "other-runtime" })
      .diagnostics[0]?.code,
    "RELAY_PROOF_CERTIFICATE_DELEGATOR_MISMATCH",
  );
});
