import assert from "node:assert/strict";
import { createPublicKey, verify as ed25519Verify } from "node:crypto";
import { test } from "node:test";
import * as sessionIssuance from "./session-issuance.js";
import {
  createManagedSession,
  issueSessionCertificate,
  SessionBootstrapError,
  SessionCertificateIssuanceError,
  type ManagedSessionIssuanceRequest,
} from "./session-issuance.js";
import { decodeSessionCertificateCompact, sessionCertificateSigningInput } from "./session-certificate.js";
import { assertRuntimeAuthority, type RuntimeAuthority } from "./runtime-authority.js";
import { generateRuntimeAuthorityKeyPair } from "./runtime-key.js";

const REPOSITORY = Object.freeze({ id: "123456789", name: "yohn-jp/gh-inari" });
const NOW = new Date("2026-09-12T12:00:00Z");

function authority(
  runtimeKey: ReturnType<typeof generateRuntimeAuthorityKeyPair>,
  overrides: Record<string, unknown> = {},
): RuntimeAuthority {
  return assertRuntimeAuthority({
    version: 1,
    kind: "runtime-authority",
    id: "managed-session-runtime",
    key: runtimeKey.publicKeyJwk,
    status: "active",
    notBefore: "2026-01-01T00:00:00Z",
    notAfter: null,
    maxSessionTtlSeconds: 3600,
    capabilityCeiling: ["change.implement", "change.ready"],
    ...overrides,
  });
}

function requestFor(
  session: ReturnType<typeof createManagedSession>,
  overrides: Partial<ManagedSessionIssuanceRequest> = {},
) {
  return session.createIssuanceRequest({
    repository: REPOSITORY,
    task: { kind: "issue", number: 371 },
    capabilities: [{ kind: "change.implement", issue: 371 }],
    ttlSeconds: 1800,
    ...overrides,
  });
}

test("managed Sessions generate distinct ephemeral public identities without exposing private material", () => {
  const first = createManagedSession();
  const second = createManagedSession();

  assert.notEqual(first.publicKey.x, second.publicKey.x);
  assert.equal("privateKey" in first, false);
  assert.equal("privateKey" in second, false);
  assert.equal(JSON.stringify(first).includes("PRIVATE KEY"), false);
  assert.equal(JSON.stringify(first).includes('"d"'), false);
  assert.equal(first.publicKey.kty, "OKP");
  assert.equal(first.publicKey.crv, "Ed25519");
  assert.equal("d" in first.publicKey, false);
});

test("no export on this module can recover a managed Session's private key", () => {
  const session = createManagedSession();

  assert.equal(
    Reflect.has(sessionIssuance, "exportManagedSessionPrivateKey"),
    false,
    "session-issuance.js must not export a private-key extractor for ManagedSession",
  );
  const forbiddenNamePattern = /private[-_]?key|privatekey|exportkey|keyobject/iu;
  for (const exportName of Object.keys(sessionIssuance)) {
    assert.equal(
      forbiddenNamePattern.test(exportName),
      false,
      `session-issuance.js export "${exportName}" looks like a private-key accessor`,
    );
  }
  for (const propertyName of Object.keys(session)) {
    assert.notEqual(propertyName, "privateKey");
  }
  assert.deepEqual(Object.keys(session).sort(), [
    "acceptCertificate",
    "certificate",
    "createIssuanceRequest",
    "publicKey",
    "sessionId",
    "sign",
  ]);
});

test("Session issuance request is a frozen public-only boundary", () => {
  const session = createManagedSession();
  const request = requestFor(session);

  assert.deepEqual(Object.keys(request).sort(), [
    "capabilities",
    "repository",
    "sessionId",
    "sessionKey",
    "task",
    "ttlSeconds",
  ]);
  assert.equal(request.sessionKey.x, session.publicKey.x);
  assert.equal("d" in request.sessionKey, false);
  assert.equal("privateKey" in request, false);
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.isFrozen(request.sessionKey), true);
  assert.equal(Object.isFrozen(request.repository), true);
  assert.equal(Object.isFrozen(request.capabilities), true);
});

test("Runtime issues the canonical #367 certificate with the #368 key and no Session private key", () => {
  const runtimeKey = generateRuntimeAuthorityKeyPair();
  const runtimeAuthority = authority(runtimeKey);
  const session = createManagedSession();
  const request = requestFor(session);

  const issued = issueSessionCertificate({
    repository: REPOSITORY,
    runtimeAuthority,
    runtimeKey,
    request,
    now: NOW,
  });
  const decoded = decodeSessionCertificateCompact(issued.compact);
  assert.equal(decoded.valid, true);
  assert.equal(decoded.value?.payload.sub, `session:${session.sessionId}`);
  assert.equal(decoded.value?.payload.repository.id, REPOSITORY.id);
  assert.equal(decoded.value?.payload.task?.number, 371);
  assert.deepEqual(decoded.value?.payload.capabilities, request.capabilities);
  assert.equal(decoded.value?.payload.sessionKey.x, session.publicKey.x);
  assert.equal(decoded.value?.payload.iat, Math.floor(NOW.getTime() / 1000));
  assert.equal(decoded.value?.payload.exp, Math.floor(NOW.getTime() / 1000) + request.ttlSeconds);
  assert.equal(issued.compact, `${issued.signingInput}.${issued.signature}`);
  assert.equal(JSON.stringify(issued).includes("PRIVATE KEY"), false);
  assert.equal(JSON.stringify(issued).includes('"d"'), false);

  const runtimePublicKey = createPublicKey({ key: runtimeAuthority.key, format: "jwk" });
  assert.equal(
    ed25519Verify(
      null,
      Buffer.from(issued.signingInput, "utf8"),
      runtimePublicKey,
      Buffer.from(issued.signature, "base64url"),
    ),
    true,
  );
  assert.equal(session.acceptCertificate(issued).payload.sessionKey.x, session.publicKey.x);
  assert.equal(session.certificate?.payload.jti, issued.payload.jti);
});

test("issuance retains one canonical certificate/signing format", () => {
  const runtimeKey = generateRuntimeAuthorityKeyPair();
  const runtimeAuthority = authority(runtimeKey);
  const session = createManagedSession();
  const issued = issueSessionCertificate({
    repository: REPOSITORY,
    runtimeAuthority,
    runtimeKey,
    request: requestFor(session),
    now: NOW,
  });
  const signingInput = sessionCertificateSigningInput(issued.header, issued.payload);
  assert.equal(signingInput.signingInput, issued.signingInput);
  assert.equal(issued.compact, `${signingInput.signingInput}.${issued.signature}`);
  assert.equal(decodeSessionCertificateCompact(issued.compact).valid, true);
});

test("Runtime rejects a TTL over the Runtime ceiling and accepts the exact ceiling", () => {
  const runtimeKey = generateRuntimeAuthorityKeyPair();
  const runtimeAuthority = authority(runtimeKey, { maxSessionTtlSeconds: 120 });
  const session = createManagedSession();

  assert.throws(
    () =>
      issueSessionCertificate({
        repository: REPOSITORY,
        runtimeAuthority,
        runtimeKey,
        request: requestFor(session, { ttlSeconds: 121 }),
        now: NOW,
      }),
    (error: unknown) =>
      error instanceof SessionCertificateIssuanceError &&
      error.code === "SESSION_CERTIFICATE_TTL_EXCEEDS_RUNTIME_CEILING",
  );

  const issued = issueSessionCertificate({
    repository: REPOSITORY,
    runtimeAuthority,
    runtimeKey,
    request: requestFor(session, { ttlSeconds: 120 }),
    now: NOW,
  });
  assert.equal(issued.payload.exp - issued.payload.nbf, 120);
});

test("Runtime rejects every capability outside the Runtime ceiling before signing", () => {
  const runtimeKey = generateRuntimeAuthorityKeyPair();
  const runtimeAuthority = authority(runtimeKey, { capabilityCeiling: ["change.implement"] });
  const session = createManagedSession();
  const request = requestFor(session, {
    capabilities: [
      { kind: "change.implement", issue: 371 },
      { kind: "change.ready", issue: 371 },
    ],
  });

  assert.throws(
    () => issueSessionCertificate({ repository: REPOSITORY, runtimeAuthority, runtimeKey, request, now: NOW }),
    (error: unknown) =>
      error instanceof SessionCertificateIssuanceError &&
      error.code === "SESSION_CERTIFICATE_CAPABILITY_EXCEEDS_RUNTIME_CEILING",
  );
});

test("issuance rejects repository substitution and a Runtime key that does not match its trust record", () => {
  const runtimeKey = generateRuntimeAuthorityKeyPair();
  const otherRuntimeKey = generateRuntimeAuthorityKeyPair();
  const runtimeAuthority = authority(runtimeKey);
  const session = createManagedSession();
  const request = requestFor(session);

  assert.throws(
    () =>
      issueSessionCertificate({
        repository: { id: "999999999", name: REPOSITORY.name },
        runtimeAuthority,
        runtimeKey,
        request,
        now: NOW,
      }),
    (error: unknown) =>
      error instanceof SessionCertificateIssuanceError && error.code === "SESSION_CERTIFICATE_REPOSITORY_MISMATCH",
  );
  assert.throws(
    () =>
      issueSessionCertificate({
        repository: REPOSITORY,
        runtimeAuthority,
        runtimeKey: otherRuntimeKey,
        request,
        now: NOW,
      }),
    (error: unknown) =>
      error instanceof SessionCertificateIssuanceError &&
      error.code === "SESSION_CERTIFICATE_ISSUANCE_RUNTIME_KEY_MISMATCH",
  );
});

test("a different Session cannot substitute or receive another Session's certificate", () => {
  const runtimeKey = generateRuntimeAuthorityKeyPair();
  const runtimeAuthority = authority(runtimeKey);
  const first = createManagedSession();
  const second = createManagedSession();
  const issued = issueSessionCertificate({
    repository: REPOSITORY,
    runtimeAuthority,
    runtimeKey,
    request: requestFor(first),
    now: NOW,
  });

  assert.throws(
    () => second.acceptCertificate(issued),
    (error: unknown) =>
      error instanceof SessionBootstrapError && error.code === "SESSION_BOOTSTRAP_CERTIFICATE_SESSION_MISMATCH",
  );
  assert.equal(second.certificate, undefined);

  const keySubstitutedRequest = { ...requestFor(second), sessionKey: first.publicKey };
  const keySubstituted = issueSessionCertificate({
    repository: REPOSITORY,
    runtimeAuthority,
    runtimeKey,
    request: keySubstitutedRequest,
    now: NOW,
  });
  assert.throws(
    () => second.acceptCertificate(keySubstituted),
    (error: unknown) =>
      error instanceof SessionBootstrapError && error.code === "SESSION_BOOTSTRAP_CERTIFICATE_KEY_MISMATCH",
  );
});

test("Session refuses malformed issuance contexts and certificates fail closed", () => {
  const session = createManagedSession();
  assert.throws(() => session.createIssuanceRequest({} as never), SessionBootstrapError);
  assert.throws(
    () =>
      session.createIssuanceRequest({
        repository: REPOSITORY,
        task: { kind: "issue", number: 371 },
        capabilities: [{ kind: "change.implement", issue: 372 }],
        ttlSeconds: 1800,
      }),
    SessionBootstrapError,
  );
  assert.throws(() => session.acceptCertificate("not-a-certificate"), SessionBootstrapError);
});
