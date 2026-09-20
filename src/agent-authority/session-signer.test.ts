import assert from "node:assert/strict";
import { test } from "node:test";
import {
  adaptManagedRuntimeSession,
  beginManagedRuntimeSession,
  completeManagedRuntimeSession,
  createSessionSigner,
  issueSessionCertificate,
  verifySessionRequest,
  generateRuntimeAuthorityKeyPair,
  assertRuntimeAuthority,
  type ManagedRuntimeSessionBeginOptions,
} from "./index.js";

const repository = Object.freeze({ id: "123456789", name: "yohn-jp/gh-inari" });
const now = new Date("2026-09-12T12:00:00Z");
const nowSeconds = Math.floor(now.getTime() / 1000);

function managedSession() {
  const runtimeKey = generateRuntimeAuthorityKeyPair();
  const authority = assertRuntimeAuthority({
    version: 1,
    kind: "runtime-authority",
    id: "session-signer-test",
    key: runtimeKey.publicKeyJwk,
    status: "active",
    notBefore: "2026-01-01T00:00:00Z",
    notAfter: null,
    maxSessionTtlSeconds: 3600,
    capabilityCeiling: ["change.implement"],
  });
  const options: ManagedRuntimeSessionBeginOptions = {
    repository,
    task: { kind: "issue", number: 888 },
    capabilities: [{ kind: "change.implement", issue: 888 }],
    ttlSeconds: 600,
  };
  const begin = beginManagedRuntimeSession(options);
  const certificate = issueSessionCertificate({
    repository,
    runtimeAuthority: authority,
    runtimeKey,
    request: begin.issuanceRequest,
    now,
  });
  return completeManagedRuntimeSession({
    session: begin.session,
    issuanceRequest: begin.issuanceRequest,
    certificate,
  });
}

test("managed runtime adapts to the canonical Session signer without private material", () => {
  const managed = managedSession();
  const signer = adaptManagedRuntimeSession(managed);
  const envelope = signer.signRequest({
    request: { issue: 888 },
    operation: "change.implement",
    requestId: "session-signer-request",
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + 60,
  });

  assert.equal(verifySessionRequest(envelope, { now: nowSeconds }).valid, true);
  assert.equal(signer.metadata.sessionId, managed.session.sessionId);
  assert.equal(signer.metadata.certificateJti, managed.certificate.payload.jti);
  assert.equal(signer.metadata.repositoryId, repository.id);
  assert.equal("privateKey" in signer, false);
  assert.equal("d" in signer.publicKey, false);
  assert.equal(JSON.stringify(signer).includes("PRIVATE KEY"), false);
  assert.equal(JSON.stringify(signer).includes('"d"'), false);
});

test("the generalized principal and managed adapter produce identical envelope semantics", () => {
  const managed = managedSession();
  const managedSigner = adaptManagedRuntimeSession(managed);
  const generalizedSigner = createSessionSigner(managed.session);
  const options = {
    request: { issue: 888 },
    operation: "change.implement",
    requestId: "session-signer-equivalence",
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + 60,
  } as const;
  const managedEnvelope = managedSigner.signRequest(options);
  const generalizedEnvelope = generalizedSigner.signRequest(options);
  assert.deepEqual(generalizedEnvelope, managedEnvelope);
  assert.equal(verifySessionRequest(generalizedEnvelope, { now: nowSeconds }).valid, true);
});
