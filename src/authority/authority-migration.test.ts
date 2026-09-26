import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createDelegatorRecord } from "../agent-authority/delegator-operations.js";
import {
  delegatorPublicKeyFingerprint,
  generateDelegatorKeyPair,
  loadDelegatorKeyPair,
} from "../agent-authority/delegator-key.js";
import { canonicalDelegatorJson, type Delegator } from "../agent-authority/delegator.js";
import {
  createLocalPrivateFile,
  localComponentPath,
  replaceLocalJson,
  validateLocalAuthorityConfig,
} from "../local-control/config.js";
import { setupLocalAuthority } from "../local-control/identity.js";
import { verifyLocalSessionBinding } from "../local-control/session-binding.js";
import { verifyChangeProvenanceRecord } from "../change-provenance-record.js";
import {
  listLocalAuthorityIdentities,
  prepareLocalAuthorityIdentity,
  readLocalAuthorityIdentity,
} from "./authority-store.js";
import { importLegacyLocalAuthority, LegacyAuthorityImportError } from "./authority-migration.js";
import { LocalRuntimeAuthorityError, openLocalRuntimeAuthority } from "./index.js";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const AUTHORITY_ID = "runtime-legacy";

async function legacyFixture(): Promise<{
  readonly environment: NodeJS.ProcessEnv;
  readonly authority: Delegator;
  cleanup(): Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "inari-authority-migration-"));
  const environment = { INARI_CONFIG_HOME: path.join(root, "config") };
  setupLocalAuthority(environment);
  const authority = createDelegatorRecord({
    id: AUTHORITY_ID,
    key: loadDelegatorKeyPair(localComponentPath("authority", "private-key.pem", environment)),
    notBefore: new Date("2026-08-01T00:00:00.000Z"),
    notAfter: new Date("2026-12-01T00:00:00.000Z"),
    maxSessionTtlSeconds: 900,
    capabilityCeiling: ["change.implement"],
  });
  return { environment, authority, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function code(expected: string) {
  return (error: unknown) => error instanceof LegacyAuthorityImportError && error.code === expected;
}

async function legacyFiles(environment: NodeJS.ProcessEnv): Promise<readonly Buffer[]> {
  return Promise.all([
    readFile(localComponentPath("authority", "config.json", environment)),
    readFile(localComponentPath("authority", "private-key.pem", environment)),
  ]);
}

function pem(key: ReturnType<typeof generateDelegatorKeyPair>): Buffer {
  return Buffer.from(key.privateKey.export({ format: "pem", type: "pkcs8" }) as string, "utf8");
}

test("the legacy single Authority imports idempotently and keeps signing compatible", async () => {
  const state = await legacyFixture();
  try {
    const before = await legacyFiles(state.environment);
    const recordBefore = canonicalDelegatorJson(state.authority);

    const first = importLegacyLocalAuthority({ environment: state.environment, authority: state.authority });
    assert.equal(first.status, "imported");
    assert.deepEqual(first.identity, {
      authorityId: AUTHORITY_ID,
      publicKey: state.authority.key,
      publicKeyFingerprint: delegatorPublicKeyFingerprint(state.authority.key),
    });
    const second = importLegacyLocalAuthority({ environment: state.environment, authority: state.authority });
    assert.equal(second.status, "already-imported");
    assert.deepEqual(second.identity, first.identity);
    assert.deepEqual(listLocalAuthorityIdentities(state.environment), [first.identity]);

    // Legacy custody is untouched and still usable.
    assert.deepEqual(await legacyFiles(state.environment), before);
    assert.equal(
      openLocalRuntimeAuthority({ environment: state.environment, trustedAuthority: () => state.authority }).authority,
      state.authority,
    );

    // The imported entry signs with the same key under the unchanged canonical record.
    const signer = openLocalRuntimeAuthority({
      environment: state.environment,
      trustedAuthority: () => state.authority,
      authoritySelector: { authorityId: AUTHORITY_ID, publicKeyFingerprint: first.identity.publicKeyFingerprint },
      now: NOW,
    });
    assert.equal(canonicalDelegatorJson(signer.authority), recordBefore);
    assert.deepEqual(signer.authority.capabilityCeiling, ["change.implement"]);
    assert.equal(signer.authority.maxSessionTtlSeconds, 900);
    const binding = signer.issueSessionBinding({
      sessionId: "sess_authority-import",
      repository: { id: "1330755860", name: "yohn-jp/gh-inari" },
      task: { kind: "issue", number: 1200 },
      capabilities: [{ kind: "change.implement", issue: 1200 }],
      ttlSeconds: 300,
      now: NOW,
    });
    assert.deepEqual(verifyLocalSessionBinding(binding, state.authority, { now: NOW }).value, binding);
    assert.equal(
      verifyChangeProvenanceRecord(await signer.signChangeProvenance(1200), state.authority).rootIssue,
      1200,
    );
    // A Session TTL above the canonical ceiling stays refused for the imported Authority.
    assert.throws(() =>
      signer.issueSessionBinding({
        sessionId: "sess_authority-import-ttl",
        repository: { id: "1330755860", name: "yohn-jp/gh-inari" },
        task: { kind: "issue", number: 1200 },
        capabilities: [{ kind: "change.implement", issue: 1200 }],
        ttlSeconds: 901,
        now: NOW,
      }),
    );
  } finally {
    await state.cleanup();
  }
});

test("conflicting legacy config, key or public identity blocks import without writing", async () => {
  const state = await legacyFixture();
  try {
    const other = createDelegatorRecord({
      id: AUTHORITY_ID,
      key: generateDelegatorKeyPair(),
      maxSessionTtlSeconds: 900,
      capabilityCeiling: ["change.implement"],
    });
    assert.throws(
      () => importLegacyLocalAuthority({ environment: state.environment, authority: other }),
      code("LEGACY_AUTHORITY_CONFLICT"),
    );
    assert.deepEqual(listLocalAuthorityIdentities(state.environment), []);
    await assert.rejects(readdir(localComponentPath("authority", "keys", state.environment)), { code: "ENOENT" });

    // The target Authority ID already holds another key.
    const occupied = prepareLocalAuthorityIdentity(AUTHORITY_ID, state.environment).identity;
    assert.throws(
      () => importLegacyLocalAuthority({ environment: state.environment, authority: state.authority }),
      code("LEGACY_AUTHORITY_CONFLICT"),
    );
    assert.deepEqual(readLocalAuthorityIdentity(AUTHORITY_ID, state.environment), occupied);

    // The legacy descriptor names a different key than the legacy private key.
    const before = await legacyFiles(state.environment);
    const foreign = generateDelegatorKeyPair();
    const legacy = validateLocalAuthorityConfig(JSON.parse(before[0]?.toString("utf8") ?? "") as unknown);
    replaceLocalJson(
      "authority",
      "config.json",
      { ...legacy, publicKey: foreign.publicKeyJwk, publicKeyFingerprint: delegatorPublicKeyFingerprint(foreign) },
      validateLocalAuthorityConfig,
      state.environment,
    );
    const renamed = { ...state.authority, id: "runtime-renamed" } as Delegator;
    assert.throws(
      () => importLegacyLocalAuthority({ environment: state.environment, authority: renamed }),
      code("LEGACY_AUTHORITY_CONFLICT"),
    );
    assert.equal(readLocalAuthorityIdentity("runtime-renamed", state.environment), undefined);
  } finally {
    await state.cleanup();
  }

  const empty = await mkdtemp(path.join(os.tmpdir(), "inari-authority-migration-empty-"));
  try {
    const authority = createDelegatorRecord({
      id: AUTHORITY_ID,
      key: generateDelegatorKeyPair(),
      maxSessionTtlSeconds: 900,
      capabilityCeiling: ["change.implement"],
    });
    assert.throws(
      () => importLegacyLocalAuthority({ environment: { INARI_CONFIG_HOME: path.join(empty, "config") }, authority }),
      code("LEGACY_AUTHORITY_NOT_FOUND"),
    );
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test("an interrupted import leaves legacy custody usable and the new identity incomplete", async () => {
  const state = await legacyFixture();
  try {
    const legacyKey = loadDelegatorKeyPair(localComponentPath("authority", "private-key.pem", state.environment));
    // Crash after the key write, before the descriptor was published.
    createLocalPrivateFile("authority", `keys/${AUTHORITY_ID}/private-key.pem`, pem(legacyKey), state.environment);
    assert.deepEqual(listLocalAuthorityIdentities(state.environment), []);
    assert.equal(readLocalAuthorityIdentity(AUTHORITY_ID, state.environment), undefined);
    assert.throws(
      () =>
        openLocalRuntimeAuthority({
          environment: state.environment,
          trustedAuthority: () => state.authority,
          authoritySelector: { authorityId: AUTHORITY_ID },
        }),
      (error: unknown) => error instanceof LocalRuntimeAuthorityError && error.code === "AUTHORITY_IDENTITY_NOT_FOUND",
    );
    assert.equal(
      openLocalRuntimeAuthority({ environment: state.environment, trustedAuthority: () => state.authority }).authority,
      state.authority,
    );

    const resumed = importLegacyLocalAuthority({ environment: state.environment, authority: state.authority });
    assert.equal(resumed.status, "imported");
    assert.equal(resumed.identity.publicKeyFingerprint, delegatorPublicKeyFingerprint(legacyKey));
  } finally {
    await state.cleanup();
  }

  const stale = await legacyFixture();
  try {
    // A partial entry holding a different key is never replaced by import.
    const foreign = pem(generateDelegatorKeyPair());
    createLocalPrivateFile("authority", `keys/${AUTHORITY_ID}/private-key.pem`, foreign, stale.environment);
    assert.throws(
      () => importLegacyLocalAuthority({ environment: stale.environment, authority: stale.authority }),
      code("LEGACY_AUTHORITY_CONFLICT"),
    );
    assert.deepEqual(
      await readFile(localComponentPath("authority", `keys/${AUTHORITY_ID}/private-key.pem`, stale.environment)),
      foreign,
    );
    assert.equal(readLocalAuthorityIdentity(AUTHORITY_ID, stale.environment), undefined);
  } finally {
    await stale.cleanup();
  }
});
