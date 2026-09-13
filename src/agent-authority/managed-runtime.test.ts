import assert from "node:assert/strict";
import { test } from "node:test";
import {
  beginManagedRuntimeSession,
  completeManagedRuntimeSession,
  ManagedRuntimeSessionError,
  type ManagedRuntimeSessionBeginOptions,
} from "./managed-runtime.js";
import { sendDirectAppRequest } from "./direct-app-client.js";
import { issueSessionCertificate, SessionBootstrapError, SessionCertificateIssuanceError } from "./session-issuance.js";
import { verifySessionRequest } from "./session-request.js";
import { assertRuntimeAuthority, type RuntimeAuthority } from "./runtime-authority.js";
import { generateRuntimeAuthorityKeyPair, type RuntimeAuthorityKeyPair } from "./runtime-key.js";

const REPOSITORY = Object.freeze({ id: "123456789", name: "yohn-jp/gh-inari" });
const NOW = new Date("2026-09-12T12:00:00Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

function authority(runtimeKey: RuntimeAuthorityKeyPair, overrides: Record<string, unknown> = {}): RuntimeAuthority {
  return assertRuntimeAuthority({
    version: 1,
    kind: "runtime-authority",
    id: "managed-runtime-test",
    key: runtimeKey.publicKeyJwk,
    status: "active",
    notBefore: "2026-01-01T00:00:00Z",
    notAfter: null,
    maxSessionTtlSeconds: 3600,
    capabilityCeiling: ["change.implement", "change.ready"],
    ...overrides,
  });
}

function beginOptions(overrides: Partial<ManagedRuntimeSessionBeginOptions> = {}): ManagedRuntimeSessionBeginOptions {
  return {
    repository: REPOSITORY,
    task: { kind: "issue", number: 380 },
    capabilities: [{ kind: "change.implement", issue: 380 }],
    ttlSeconds: 1800,
    ...overrides,
  };
}

/** Composes the full seam the way a caller that owns both boundaries would. */
function createManagedRuntimeSessionForTest(
  runtimeKey: RuntimeAuthorityKeyPair,
  overrides: Partial<ManagedRuntimeSessionBeginOptions> & { runtimeAuthority?: RuntimeAuthority } = {},
) {
  const { runtimeAuthority, ...beginOverrides } = overrides;
  const begin = beginManagedRuntimeSession(beginOptions(beginOverrides));
  const certificate = issueSessionCertificate({
    repository: begin.issuanceRequest.repository,
    runtimeAuthority: runtimeAuthority ?? authority(runtimeKey),
    runtimeKey,
    request: begin.issuanceRequest,
    now: NOW,
  });
  return completeManagedRuntimeSession({
    session: begin.session,
    issuanceRequest: begin.issuanceRequest,
    certificate,
    ...(begin.provenance === undefined ? {} : { provenance: begin.provenance }),
  });
}

test("beginManagedRuntimeSession has no Runtime Authority or Runtime key parameter", () => {
  const beginParameterKeys = Object.keys(beginOptions());
  assert.equal(beginParameterKeys.includes("runtimeAuthority"), false);
  assert.equal(beginParameterKeys.includes("runtimeKey"), false);
});

test("managed-runtime seam returns only public Session/certificate material", () => {
  const runtimeKey = generateRuntimeAuthorityKeyPair();
  const managed = createManagedRuntimeSessionForTest(runtimeKey, {
    provenance: { runtime: "mottainai", worktree: "inari-380", session: "worker-a" },
  });

  assert.equal(managed.issuanceRequest.sessionKey.x, managed.session.publicKey.x);
  assert.equal(managed.certificate.payload.sessionKey.x, managed.session.publicKey.x);
  assert.equal(managed.certificate.payload.repository.id, REPOSITORY.id);
  assert.equal(managed.certificate.payload.task?.number, 380);
  assert.deepEqual(managed.certificate.payload.capabilities, managed.issuanceRequest.capabilities);
  assert.equal(managed.certificate.payload.exp - managed.certificate.payload.iat, 1800);
  assert.deepEqual(managed.provenance, {
    runtime: "mottainai",
    worktree: "inari-380",
    session: "worker-a",
  });

  assert.equal("runtimeKey" in managed, false);
  assert.equal("runtimeAuthority" in managed, false);
  assert.equal("privateKey" in managed, false);
  assert.equal("d" in managed.session.publicKey, false);
  assert.equal(JSON.stringify(managed).includes("PRIVATE KEY"), false);
  assert.equal(JSON.stringify(managed).includes('"d"'), false);
  assert.equal(JSON.stringify(managed).includes("installation"), false);
  assert.equal("runtime" in managed.certificate.payload, false);
  assert.equal("worktree" in managed.certificate.payload, false);
  assert.equal("session" in managed.certificate.payload, false);
});

test("the composition signs the canonical Session request and feeds the direct App client unchanged", async () => {
  const runtimeKey = generateRuntimeAuthorityKeyPair();
  const managed = createManagedRuntimeSessionForTest(runtimeKey);
  const signed = managed.signRequest({
    request: { version: 1, issue: 380 },
    operation: "change.show",
    requestId: "managed-runtime-request",
    issuedAt: NOW_SECONDS,
    expiresAt: NOW_SECONDS + 60,
  });
  const verified = verifySessionRequest(signed, { now: NOW_SECONDS });
  assert.equal(verified.valid, true);
  assert.equal(verified.value?.certificate.payload.sessionKey.x, managed.session.publicKey.x);

  let sent: unknown;
  const response = await sendDirectAppRequest({
    endpoint: new URL("http://localhost:8787"),
    session: managed.session,
    request: { version: 1, issue: 380 },
    operation: "change.show",
    requestId: () => "direct-app-request",
    now: () => NOW.getTime(),
    fetchImpl: async (_input, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true, result: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(response.ok, true);
  const directAppVerification = verifySessionRequest(sent, { now: NOW_SECONDS });
  assert.equal(directAppVerification.valid, true);
  assert.equal(directAppVerification.value?.certificate.payload.jti, managed.certificate.payload.jti);
});

test("parallel managed Sessions have non-substitutable certificate identities", () => {
  const runtimeKey = generateRuntimeAuthorityKeyPair();
  const first = createManagedRuntimeSessionForTest(runtimeKey);
  const second = createManagedRuntimeSessionForTest(runtimeKey);

  assert.notEqual(first.session.publicKey.x, second.session.publicKey.x);
  assert.notEqual(first.certificate.payload.sub, second.certificate.payload.sub);
  assert.notEqual(first.certificate.payload.jti, second.certificate.payload.jti);
  assert.throws(
    () => second.session.acceptCertificate(first.certificate),
    (error: unknown) =>
      error instanceof SessionBootstrapError && error.code === "SESSION_BOOTSTRAP_CERTIFICATE_SESSION_MISMATCH",
  );
  assert.equal(second.session.certificate?.payload.jti, second.certificate.payload.jti);
});

test("provenance cannot change certificate authorization claims", () => {
  const runtimeKey = generateRuntimeAuthorityKeyPair();
  const withLabels = createManagedRuntimeSessionForTest(runtimeKey, {
    provenance: { runtime: "runtime-a", workspace: "workspace-a" },
  });
  const withoutLabels = createManagedRuntimeSessionForTest(runtimeKey);

  assert.deepEqual(withLabels.issuanceRequest.repository, withoutLabels.issuanceRequest.repository);
  assert.deepEqual(withLabels.issuanceRequest.task, withoutLabels.issuanceRequest.task);
  assert.deepEqual(withLabels.issuanceRequest.capabilities, withoutLabels.issuanceRequest.capabilities);
  assert.equal(withLabels.issuanceRequest.ttlSeconds, withoutLabels.issuanceRequest.ttlSeconds);
  assert.deepEqual(withLabels.certificate.header, withoutLabels.certificate.header);
  assert.deepEqual(withLabels.certificate.payload.repository, withoutLabels.certificate.payload.repository);
  assert.deepEqual(withLabels.certificate.payload.task, withoutLabels.certificate.payload.task);
  assert.deepEqual(withLabels.certificate.payload.capabilities, withoutLabels.certificate.payload.capabilities);
  assert.equal(withLabels.certificate.payload.iat, withoutLabels.certificate.payload.iat);
  assert.equal(withLabels.certificate.payload.exp, withoutLabels.certificate.payload.exp);
  assert.equal("runtime" in withLabels.certificate.payload, false);
  assert.equal("workspace" in withLabels.certificate.payload, false);
});

test("managed-runtime composition preserves existing TTL and capability admission rules", () => {
  const runtimeKey = generateRuntimeAuthorityKeyPair();
  const limitedAuthority = authority(runtimeKey, {
    maxSessionTtlSeconds: 120,
    capabilityCeiling: ["change.implement"],
  });

  assert.throws(
    () =>
      createManagedRuntimeSessionForTest(runtimeKey, {
        runtimeAuthority: limitedAuthority,
        ttlSeconds: 121,
      }),
    (error: unknown) =>
      error instanceof SessionCertificateIssuanceError &&
      error.code === "SESSION_CERTIFICATE_TTL_EXCEEDS_RUNTIME_CEILING",
  );
  assert.throws(
    () =>
      createManagedRuntimeSessionForTest(runtimeKey, {
        runtimeAuthority: limitedAuthority,
        ttlSeconds: 120,
        capabilities: [
          { kind: "change.implement", issue: 380 },
          { kind: "change.ready", issue: 380 },
        ],
      }),
    (error: unknown) =>
      error instanceof SessionCertificateIssuanceError &&
      error.code === "SESSION_CERTIFICATE_CAPABILITY_EXCEEDS_RUNTIME_CEILING",
  );
});

test("provenance validation is closed-world and bounded", () => {
  assert.throws(
    () => beginManagedRuntimeSession(beginOptions({ provenance: { unsupported: "label" } as never })),
    (error: unknown) =>
      error instanceof ManagedRuntimeSessionError && error.code === "MANAGED_RUNTIME_INVALID_PROVENANCE",
  );
  assert.throws(
    () => beginManagedRuntimeSession(beginOptions({ provenance: { runtime: "x".repeat(129) } })),
    (error: unknown) =>
      error instanceof ManagedRuntimeSessionError && error.code === "MANAGED_RUNTIME_INVALID_PROVENANCE",
  );
});

test("the Runtime-facing issuance primitive cannot receive a ManagedSession or its signing capability", () => {
  const runtimeKey = generateRuntimeAuthorityKeyPair();
  const begin = beginManagedRuntimeSession(beginOptions());

  const issuanceRequestKeys = Object.keys(begin.issuanceRequest).sort();
  assert.deepEqual(issuanceRequestKeys, [
    "capabilities",
    "repository",
    "sessionId",
    "sessionKey",
    "task",
    "ttlSeconds",
  ]);
  assert.equal("sign" in begin.issuanceRequest, false);
  assert.equal("acceptCertificate" in begin.issuanceRequest, false);
  assert.equal(JSON.stringify(begin.issuanceRequest).includes('"d"'), false);

  const certificate = issueSessionCertificate({
    repository: begin.issuanceRequest.repository,
    runtimeAuthority: authority(runtimeKey),
    runtimeKey,
    request: begin.issuanceRequest,
    now: NOW,
  });
  assert.equal("session" in certificate, false);
  assert.equal("sign" in certificate, false);
});
