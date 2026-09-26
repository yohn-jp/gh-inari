import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { createDelegatorRecord } from "../agent-authority/delegator-operations.js";
import { delegatorPublicKeyFingerprint, generateDelegatorKeyPair } from "../agent-authority/delegator-key.js";
import { selectSetupAuthority, SetupTrustSelectionError } from "./setup-trust.js";

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
