import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createDelegatorRecord } from "../agent-authority/delegator-operations.js";
import { delegatorPublicKeyFingerprint, generateDelegatorKeyPair } from "../agent-authority/delegator-key.js";
import { localComponentPath } from "../local-control/config.js";
import { openLocalAuthorityCustody, prepareLocalAuthorityIdentity } from "./authority-store.js";
import { selectSetupAuthority, setupAuthorityReference, SetupTrustSelectionError } from "./setup-trust.js";

const repository = { repositoryHost: "github.com", repositoryId: "99", repositoryNameWithOwner: "acme/inari" };

test("adopts a registered public record without changing its time or restricted ceiling", () => {
  const key = generateKeyPairSync("ed25519");
  const record = createDelegatorRecord({
    id: "runtime-test",
    key: key.publicKey,
    notBefore: "2025-01-01T00:00:00.000Z",
    maxSessionTtlSeconds: 120,
    capabilityCeiling: ["change.implement"],
  });
  const selected = selectSetupAuthority({
    repository,
    authorityId: record.id,
    key: { privateKey: key.privateKey, publicKey: key.publicKey, publicKeyJwk: record.key },
    local: [record],
    maxSessionTtlSeconds: 3600,
    capabilityIntent: ["change.implement"],
  });
  assert.strictEqual(selected, record);
});

test("an adopted ceiling cannot change on rerun", () => {
  const key = generateKeyPairSync("ed25519");
  const record = createDelegatorRecord({
    id: "runtime-test",
    key: key.publicKey,
    maxSessionTtlSeconds: 120,
    capabilityCeiling: ["change.implement"],
  });
  assert.throws(
    () =>
      selectSetupAuthority({
        repository,
        authorityId: record.id,
        key: { privateKey: key.privateKey, publicKey: key.publicKey, publicKeyJwk: record.key },
        local: [record],
        canonical: [record],
        capabilityIntent: ["change.ready"],
        maxSessionTtlSeconds: 3600,
      }),
    (error: unknown) => error instanceof SetupTrustSelectionError && error.code === "EXPLICIT_TRUST_CHANGE_REQUIRED",
  );
});

test("new preparation requires explicit bounded capability intent", () => {
  const key = generateDelegatorKeyPair();
  assert.throws(
    () =>
      selectSetupAuthority({
        repository,
        authorityId: "runtime-test",
        key,
        local: [],
        maxSessionTtlSeconds: 3600,
      }),
    (error: unknown) => error instanceof SetupTrustSelectionError && error.code === "INTENT_REQUIRED",
  );
});

test("a profile alone cannot regenerate its registered public envelope", () => {
  const key = generateDelegatorKeyPair();
  const fingerprint = delegatorPublicKeyFingerprint(key.publicKeyJwk);
  const profile = {
    version: 1 as const,
    state: "trust-pending" as const,
    endpoint: "https://endpoint.example.test",
    relayUrl: "wss://relay.example.test/connect",
    repository,
    app: { appId: "42", installationId: "7" },
    authority: { authorityId: "runtime-test", publicKeyFingerprint: fingerprint, privateKeyPath: "/tmp/key.pem" },
  };
  assert.throws(
    () =>
      selectSetupAuthority({
        repository,
        profile,
        authorityId: "runtime-test",
        key,
        local: [],
        maxSessionTtlSeconds: 3600,
      }),
    (error: unknown) => error instanceof SetupTrustSelectionError && error.code === "RECORD_UNAVAILABLE",
  );
});

test("one Authority identity is referenced by several repositories without key duplication", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "inari-setup-trust-"));
  const environment = { INARI_CONFIG_HOME: path.join(root, "config") };
  try {
    const { identity } = prepareLocalAuthorityIdentity("runtime-shared", environment);
    const { key } = openLocalAuthorityCustody({ authorityId: identity.authorityId }, environment);
    const record = createDelegatorRecord({
      id: identity.authorityId,
      key: identity.publicKey,
      maxSessionTtlSeconds: 120,
      capabilityCeiling: ["change.implement"],
    });
    const repositories = [
      { repositoryHost: "github.com", repositoryId: "99", repositoryNameWithOwner: "acme/inari" },
      { repositoryHost: "github.com", repositoryId: "100", repositoryNameWithOwner: "acme/other" },
    ];
    const references = repositories.map((target) => {
      const selected = selectSetupAuthority({
        repository: target,
        authorityId: identity.authorityId,
        key,
        local: [record],
        canonical: [record],
        maxSessionTtlSeconds: 3600,
      });
      assert.strictEqual(selected, record);
      return setupAuthorityReference(identity);
    });
    assert.deepEqual(references[0], references[1]);
    assert.deepEqual(references[0], {
      authorityId: "runtime-shared",
      publicKeyFingerprint: delegatorPublicKeyFingerprint(identity.publicKey),
    });
    const serialized = JSON.stringify(references);
    assert.equal(serialized.includes("private"), false);
    assert.equal(serialized.includes(".pem"), false);
    assert.equal(serialized.includes(root), false);
    assert.equal(serialized.includes(identity.publicKey.x), false);
    assert.deepEqual(await readdir(localComponentPath("authority", "keys", environment)), ["runtime-shared"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
