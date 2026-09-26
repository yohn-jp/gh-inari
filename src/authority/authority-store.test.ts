import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { delegatorPublicKeyFingerprint, generateDelegatorKeyPair } from "../agent-authority/delegator-key.js";
import {
  createLocalPrivateFile,
  localComponentPath,
  replaceLocalJson,
  validateLocalAuthorityIdentityConfig,
} from "../local-control/config.js";
import {
  adoptLocalAuthorityKey,
  AuthorityStoreError,
  listLocalAuthorityIdentities,
  openLocalAuthorityCustody,
  prepareLocalAuthorityIdentity,
  readLocalAuthorityIdentity,
} from "./authority-store.js";

async function temporaryEnvironment(): Promise<{
  readonly environment: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "inari-authority-store-"));
  return {
    environment: { INARI_CONFIG_HOME: path.join(root, "config") },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function code(expected: string) {
  return (error: unknown) => error instanceof AuthorityStoreError && error.code === expected;
}

function keyPath(environment: NodeJS.ProcessEnv, authorityId: string): string {
  return localComponentPath("authority", `keys/${authorityId}/private-key.pem`, environment);
}

function pem(key: ReturnType<typeof generateDelegatorKeyPair>): Buffer {
  return Buffer.from(key.privateKey.export({ format: "pem", type: "pkcs8" }) as string, "utf8");
}

test("two Authority IDs coexist with independent owner-only Ed25519 key custody", async () => {
  const { environment, cleanup } = await temporaryEnvironment();
  try {
    assert.deepEqual(listLocalAuthorityIdentities(environment), []);
    const beta = prepareLocalAuthorityIdentity("runtime-beta", environment);
    const alpha = prepareLocalAuthorityIdentity("runtime-alpha", environment);
    assert.equal(alpha.state, "created");
    assert.equal(beta.state, "created");
    assert.notEqual(alpha.identity.publicKeyFingerprint, beta.identity.publicKeyFingerprint);

    const listed = listLocalAuthorityIdentities(environment);
    assert.deepEqual(
      listed.map((identity) => identity.authorityId),
      ["runtime-alpha", "runtime-beta"],
    );
    assert.deepEqual(listed[0], alpha.identity);
    assert.deepEqual(listed[1], beta.identity);

    for (const prepared of [alpha, beta]) {
      const { authorityId, publicKeyFingerprint } = prepared.identity;
      const custody = openLocalAuthorityCustody({ authorityId, publicKeyFingerprint }, environment);
      assert.equal(delegatorPublicKeyFingerprint(custody.key), publicKeyFingerprint);
      assert.equal((await lstat(keyPath(environment, authorityId))).mode & 0o777, 0o600);
      const descriptor = JSON.parse(
        await readFile(localComponentPath("authority", `keys/${authorityId}/config.json`, environment), "utf8"),
      ) as unknown;
      assert.deepEqual(validateLocalAuthorityIdentityConfig(descriptor), {
        version: 1,
        authorityId,
        publicKey: prepared.identity.publicKey,
        publicKeyFingerprint,
        privateKeyFile: "private-key.pem",
      });
    }
  } finally {
    await cleanup();
  }
});

test("public identities expose only Authority ID, public key and fingerprint", async () => {
  const { environment, cleanup } = await temporaryEnvironment();
  try {
    const { identity } = prepareLocalAuthorityIdentity("runtime-alpha", environment);
    const keyBytes = await readFile(keyPath(environment, "runtime-alpha"), "utf8");
    for (const projection of [
      identity,
      listLocalAuthorityIdentities(environment)[0],
      readLocalAuthorityIdentity("runtime-alpha", environment),
    ]) {
      assert.deepEqual(Object.keys(projection ?? {}).sort(), ["authorityId", "publicKey", "publicKeyFingerprint"]);
      const serialized = JSON.stringify(projection);
      assert.equal(serialized.includes("private"), false);
      assert.equal(serialized.includes(".pem"), false);
      assert.equal(serialized.includes(environment.INARI_CONFIG_HOME as string), false);
      assert.equal(serialized.includes(keyBytes.split("\n")[1] as string), false);
    }
    assert.equal(readLocalAuthorityIdentity("runtime-missing", environment), undefined);
  } finally {
    await cleanup();
  }
});

test("prepare adopts existing custody and never regenerates a key", async () => {
  const { environment, cleanup } = await temporaryEnvironment();
  try {
    const first = prepareLocalAuthorityIdentity("runtime-alpha", environment);
    const bytes = await readFile(keyPath(environment, "runtime-alpha"));
    const second = prepareLocalAuthorityIdentity("runtime-alpha", environment);
    assert.equal(second.state, "adopted");
    assert.deepEqual(second.identity, first.identity);
    assert.deepEqual(await readFile(keyPath(environment, "runtime-alpha")), bytes);

    // A key whose descriptor was never published is incomplete: not listed, not openable, adopted as-is.
    const held = generateDelegatorKeyPair();
    createLocalPrivateFile("authority", "keys/runtime-held/private-key.pem", pem(held), environment);
    assert.deepEqual(
      listLocalAuthorityIdentities(environment).map((identity) => identity.authorityId),
      ["runtime-alpha"],
    );
    assert.throws(
      () => openLocalAuthorityCustody({ authorityId: "runtime-held" }, environment),
      code("AUTHORITY_IDENTITY_NOT_FOUND"),
    );
    const adopted = prepareLocalAuthorityIdentity("runtime-held", environment);
    assert.equal(adopted.state, "adopted");
    assert.equal(adopted.identity.publicKeyFingerprint, delegatorPublicKeyFingerprint(held));

    // A descriptor whose key disappeared is never repaired by generating a replacement.
    await unlink(keyPath(environment, "runtime-alpha"));
    assert.throws(
      () => prepareLocalAuthorityIdentity("runtime-alpha", environment),
      code("RUNTIME_AUTHORITY_KEY_NOT_FOUND"),
    );
    await assert.rejects(readFile(keyPath(environment, "runtime-alpha")), { code: "ENOENT" });
  } finally {
    await cleanup();
  }
});

test("exact open validates ID, fingerprint pin, descriptor and key", async () => {
  const { environment, cleanup } = await temporaryEnvironment();
  try {
    const alpha = prepareLocalAuthorityIdentity("runtime-alpha", environment).identity;
    const beta = prepareLocalAuthorityIdentity("runtime-beta", environment).identity;
    assert.throws(
      () => openLocalAuthorityCustody({ authorityId: "Runtime/../alpha" }, environment),
      code("AUTHORITY_IDENTITY_INVALID"),
    );
    assert.throws(
      () => openLocalAuthorityCustody({ authorityId: "runtime-gamma" }, environment),
      code("AUTHORITY_IDENTITY_NOT_FOUND"),
    );
    assert.throws(
      () =>
        openLocalAuthorityCustody(
          { authorityId: "runtime-alpha", publicKeyFingerprint: beta.publicKeyFingerprint },
          environment,
        ),
      code("AUTHORITY_IDENTITY_MISMATCH"),
    );

    // Descriptor pointing at another key: the stored key no longer matches.
    replaceLocalJson(
      "authority",
      "keys/runtime-alpha/config.json",
      {
        version: 1,
        authorityId: "runtime-alpha",
        publicKey: beta.publicKey,
        publicKeyFingerprint: beta.publicKeyFingerprint,
        privateKeyFile: "private-key.pem",
      },
      validateLocalAuthorityIdentityConfig,
      environment,
    );
    assert.throws(
      () => openLocalAuthorityCustody({ authorityId: "runtime-alpha" }, environment),
      code("RUNTIME_AUTHORITY_KEY_MISMATCH"),
    );
    // ... and one key is now claimed by two IDs, which enumeration refuses.
    assert.throws(() => listLocalAuthorityIdentities(environment), code("AUTHORITY_IDENTITY_CONFLICT"));

    // Descriptor stored under a different path ID.
    replaceLocalJson(
      "authority",
      "keys/runtime-alpha/config.json",
      {
        version: 1,
        authorityId: "runtime-other",
        publicKey: alpha.publicKey,
        publicKeyFingerprint: alpha.publicKeyFingerprint,
        privateKeyFile: "private-key.pem",
      },
      validateLocalAuthorityIdentityConfig,
      environment,
    );
    assert.throws(
      () => openLocalAuthorityCustody({ authorityId: "runtime-alpha" }, environment),
      code("AUTHORITY_IDENTITY_CONFLICT"),
    );

    await unlink(keyPath(environment, "runtime-beta"));
    assert.throws(
      () => openLocalAuthorityCustody({ authorityId: "runtime-beta" }, environment),
      code("RUNTIME_AUTHORITY_KEY_NOT_FOUND"),
    );
  } finally {
    await cleanup();
  }
});

test("adoption binds one key to one Authority ID and fails closed on conflicts", async () => {
  const { environment, cleanup } = await temporaryEnvironment();
  try {
    const key = generateDelegatorKeyPair();
    const identity = adoptLocalAuthorityKey("runtime-alpha", key, environment);
    assert.equal(identity.publicKeyFingerprint, delegatorPublicKeyFingerprint(key));
    assert.deepEqual(adoptLocalAuthorityKey("runtime-alpha", key, environment), identity);
    assert.throws(
      () => adoptLocalAuthorityKey("runtime-alpha", generateDelegatorKeyPair(), environment),
      code("AUTHORITY_IDENTITY_CONFLICT"),
    );
    assert.throws(() => adoptLocalAuthorityKey("runtime-beta", key, environment), code("AUTHORITY_IDENTITY_CONFLICT"));
    assert.equal(readLocalAuthorityIdentity("runtime-beta", environment), undefined);
    await assert.rejects(readFile(keyPath(environment, "runtime-beta")), { code: "ENOENT" });

    // A different key already stored for an incomplete entry is never replaced.
    const stale = generateDelegatorKeyPair();
    createLocalPrivateFile("authority", "keys/runtime-gamma/private-key.pem", pem(stale), environment);
    assert.throws(
      () => adoptLocalAuthorityKey("runtime-gamma", generateDelegatorKeyPair(), environment),
      code("AUTHORITY_IDENTITY_CONFLICT"),
    );
    assert.deepEqual(await readFile(keyPath(environment, "runtime-gamma")), pem(stale));
    assert.equal(readLocalAuthorityIdentity("runtime-gamma", environment), undefined);
  } finally {
    await cleanup();
  }
});

test("enumeration rejects unexpected key-store entries", async () => {
  const { environment, cleanup } = await temporaryEnvironment();
  try {
    prepareLocalAuthorityIdentity("runtime-alpha", environment);
    const keys = localComponentPath("authority", "keys", environment);
    await writeFile(path.join(keys, "stray.json"), "{}", { mode: 0o600 });
    assert.throws(() => listLocalAuthorityIdentities(environment), code("AUTHORITY_STORE_UNSAFE"));
    await unlink(path.join(keys, "stray.json"));
    await mkdir(path.join(keys, "Not_An_Id"), { mode: 0o700 });
    assert.throws(() => listLocalAuthorityIdentities(environment), code("AUTHORITY_STORE_UNSAFE"));
  } finally {
    await cleanup();
  }
});
