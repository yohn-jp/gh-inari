import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  SESSION_ISSUANCE_REQUEST_KIND,
  SESSION_ISSUANCE_REQUEST_VERSION,
  createSessionBundleSigner,
  createSessionCredentialBundle,
  generateRuntimeAuthorityKeyPair,
  loadSessionBundleSigner,
  parseSessionCredentialBundle,
  persistSessionCredentialBundle,
  verifySessionRequest,
  type SessionIssuanceRequestDocument,
} from "./index.js";
import { assertRuntimeAuthority, type RuntimeAuthority } from "./runtime-authority.js";
import type { RuntimeAuthorityKeyPair } from "./runtime-key.js";

const REPOSITORY = Object.freeze({ id: "123456789", name: "yohn-jp/gh-inari" });
const NOW = new Date("2026-09-12T12:00:00Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

function authority(runtimeKey: RuntimeAuthorityKeyPair): RuntimeAuthority {
  return assertRuntimeAuthority({
    version: 1,
    kind: "runtime-authority",
    id: "bundle-signer-runtime",
    key: runtimeKey.publicKeyJwk,
    status: "active",
    notBefore: "2020-01-01T00:00:00Z",
    notAfter: null,
    maxSessionTtlSeconds: 3600,
    capabilityCeiling: ["change.implement"],
  });
}

function issuanceRequest(runtimeKey: RuntimeAuthorityKeyPair): SessionIssuanceRequestDocument {
  return {
    version: SESSION_ISSUANCE_REQUEST_VERSION,
    kind: SESSION_ISSUANCE_REQUEST_KIND,
    runtimeAuthority: authority(runtimeKey),
    repository: REPOSITORY,
    task: { kind: "issue", number: 889 },
    capabilities: [{ kind: "change.implement", issue: 889 }],
    ttlSeconds: 1800,
  };
}

function bundle() {
  const runtimeKey = generateRuntimeAuthorityKeyPair();
  return createSessionCredentialBundle({ request: issuanceRequest(runtimeKey), runtimeKey, now: NOW });
}

test("bundle signer uses the canonical request signer and exposes no private material", () => {
  const created = bundle();
  const signer = createSessionBundleSigner(created);
  const envelope = signer.signRequest({
    request: { issue: 889 },
    operation: "change.implement",
    requestId: "bundle-signer-request",
    issuedAt: NOW_SECONDS,
    expiresAt: NOW_SECONDS + 60,
  });

  assert.equal(verifySessionRequest(envelope, { now: NOW_SECONDS }).valid, true);
  assert.equal(signer.metadata.sessionId, created.certificate.payload.sub.slice("session:".length));
  assert.equal(signer.metadata.certificateJti, created.certificate.payload.jti);
  assert.equal(signer.metadata.repositoryId, REPOSITORY.id);
  assert.equal("privateKey" in signer, false);
  assert.equal("sessionPrivateKey" in signer, false);
  assert.equal(JSON.stringify(signer).includes("PRIVATE KEY"), false);
  assert.equal(JSON.stringify(signer).includes('"d"'), false);
});

test("bundle signer loads only through the secure bundle-file loader", async () => {
  const created = bundle();
  const directory = await mkdtemp(path.join(process.cwd(), ".inari-session-bundle-signer-"));
  try {
    const bundlePath = path.join(directory, "bundle.json");
    persistSessionCredentialBundle(bundlePath, created.bundle);
    const signer = loadSessionBundleSigner(bundlePath);
    const envelope = signer.signRequest({
      request: { operation: "bundle" },
      operation: "change.implement",
      requestId: "bundle-file-request",
      issuedAt: NOW_SECONDS,
      expiresAt: NOW_SECONDS + 60,
    });
    assert.equal(verifySessionRequest(envelope, { now: NOW_SECONDS }).valid, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bundle signer fails closed when key and certificate identities are substituted", () => {
  const first = bundle();
  const second = bundle();
  assert.throws(
    () => parseSessionCredentialBundle({ ...first.bundle, sessionPrivateKey: second.bundle.sessionPrivateKey }),
    /does not match the Session Certificate/i,
  );
  assert.throws(
    () => parseSessionCredentialBundle({ ...first.bundle, certificate: second.bundle.certificate }),
    /does not match the Session Certificate/i,
  );
});
