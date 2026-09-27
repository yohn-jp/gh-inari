import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { localComponentPath } from "./config.js";
import {
  enrollLocalOperatorPublicKey,
  operatorPublicKeyId,
  readLocalOperatorKeyRegistry,
  revokeLocalOperatorPublicKey,
  validateLocalOperatorKeyRegistry,
  type OperatorEd25519PublicKey,
} from "./operator-key-registry.js";

async function temporaryEnvironment(): Promise<{ readonly root: string; readonly environment: NodeJS.ProcessEnv }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "inari-operator-key-registry-"));
  return { root, environment: { INARI_CONFIG_HOME: path.join(root, "config") } };
}

function operatorKey(): OperatorEd25519PublicKey {
  const { publicKey } = generateKeyPairSync("ed25519");
  const exported = publicKey.export({ format: "jwk" });
  assert.equal(exported.kty, "OKP");
  assert.equal(exported.crv, "Ed25519");
  if (typeof exported.x !== "string") throw new Error("Generated operator public key is missing its x coordinate.");
  return { kty: "OKP", crv: "Ed25519", x: exported.x };
}

function localControlCode(code: string) {
  return (error: unknown): boolean => error instanceof Error && "code" in error && error.code === code;
}

test("Runtime operator public keys enroll, retain versioned revocation, and reread after restart", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    const firstKey = operatorKey();
    const secondKey = operatorKey();
    assert.equal(readLocalOperatorKeyRegistry(environment), undefined);

    const first = enrollLocalOperatorPublicKey(firstKey, null, environment);
    assert.equal(first.generation, 1);
    assert.equal(first.keys[0]?.keyId, operatorPublicKeyId(firstKey));
    assert.equal(first.keys[0]?.status, "active");
    assert.deepEqual(enrollLocalOperatorPublicKey(firstKey, null, environment), first);

    const second = enrollLocalOperatorPublicKey(secondKey, 1, environment);
    assert.equal(second.generation, 2);
    assert.equal(second.keys.length, 2);
    assert.throws(
      () => enrollLocalOperatorPublicKey(operatorKey(), 1, environment),
      localControlCode("LOCAL_CONTROL_CONFIG_CONFLICT"),
    );

    const revoked = revokeLocalOperatorPublicKey(first.keys[0]!.keyId, 2, environment);
    assert.equal(revoked.generation, 3);
    assert.equal(revoked.keys[0]?.status, "revoked");
    assert.equal(revoked.keys[0]?.status === "revoked" ? revoked.keys[0].revokedGeneration : undefined, 3);
    assert.deepEqual(revokeLocalOperatorPublicKey(first.keys[0]!.keyId, 2, environment), revoked);
    assert.deepEqual(readLocalOperatorKeyRegistry(environment), revoked);
    assert.throws(
      () => revokeLocalOperatorPublicKey(first.keys[0]!.keyId, 1, environment),
      localControlCode("LOCAL_CONTROL_CONFIG_CONFLICT"),
    );
    assert.throws(
      () => enrollLocalOperatorPublicKey(firstKey, 3, environment),
      localControlCode("LOCAL_CONTROL_CONFIG_CONFLICT"),
    );

    const file = localComponentPath("runtime", "operator-keys/registry.json", environment);
    const persisted = await readFile(file, "utf8");
    assert.equal(JSON.parse(persisted).generation, 3);
    assert.equal(persisted.includes('"d"'), false);
    assert.equal(persisted.includes("privateKey"), false);
    assert.equal(persisted.includes("credential"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registry validation rejects malformed, private, conflicting, and unknown key evidence", async () => {
  const key = operatorKey();
  const keyId = operatorPublicKeyId(key);
  const active = { keyId, publicKey: key, status: "active", enrolledGeneration: 1 };
  const registry = { version: 1, generation: 1, keys: [active] };

  assert.deepEqual(validateLocalOperatorKeyRegistry(registry), registry);
  assert.throws(() => validateLocalOperatorKeyRegistry({ ...registry, unknown: true }));
  assert.throws(() => validateLocalOperatorKeyRegistry({ ...registry, keys: [active, active] }));
  assert.throws(() =>
    validateLocalOperatorKeyRegistry({ ...registry, keys: [{ ...active, keyId: "opk_" + "0".repeat(64) }] }),
  );
  assert.throws(() =>
    validateLocalOperatorKeyRegistry({ ...registry, keys: [{ ...active, publicKey: { ...key, d: "private" } }] }),
  );
  assert.throws(() =>
    validateLocalOperatorKeyRegistry({ ...registry, keys: [{ ...active, publicKey: { ...key, crv: "X25519" } }] }),
  );
  assert.throws(() =>
    validateLocalOperatorKeyRegistry({ ...registry, keys: [{ ...active, publicKey: { ...key, x: "not-a-key" } }] }),
  );
  assert.throws(() => validateLocalOperatorKeyRegistry({ ...registry, generation: 0 }));
});

test("missing or unsafe registry storage cannot yield an operator identity", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    await mkdir(path.join(root, "config"), { mode: 0o700 });
    await symlink(os.tmpdir(), path.join(root, "config", "runtime"));
    assert.throws(() => readLocalOperatorKeyRegistry(environment), localControlCode("LOCAL_CONTROL_UNSAFE_STORAGE"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid persisted registry fails closed on fresh read", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    const file = localComponentPath("runtime", "operator-keys/registry.json", environment);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify({ version: 1, generation: 1, keys: [{ privateKey: "forbidden" }] }), {
      mode: 0o600,
    });
    assert.throws(() => readLocalOperatorKeyRegistry(environment), localControlCode("LOCAL_CONTROL_INVALID_CONFIG"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
