import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  ensureLocalComponentDirectory,
  localComponentDirectory,
  localComponentPath,
  validateLocalAuthorityConfig,
  validateLocalComponentIdentity,
  writeLocalJson,
  type LocalAuthorityConfig,
} from "./config.js";
import {
  bindLocalAuthorityDescriptor,
  copyLocalAuthorityKey,
  ensureLocalComponentIdentity,
  setupLocalAuthority,
} from "./identity.js";
import {
  delegatorPublicKeyFingerprint,
  generateAndPersistDelegatorKeyPair,
  loadDelegatorKeyPair,
} from "../agent-authority/delegator-key.js";

async function temporaryEnvironment(): Promise<{ readonly root: string; readonly environment: NodeJS.ProcessEnv }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "inari-local-identity-"));
  return { root, environment: { INARI_CONFIG_HOME: path.join(root, "config") } };
}

test("component identities are opaque, versioned, persistent, and component-scoped", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    const admission = ensureLocalComponentIdentity("admission", environment);
    const executor = ensureLocalComponentIdentity("executor", environment);
    assert.match(admission.id, /^adm_[A-Za-z0-9_-]{16,64}$/u);
    assert.match(executor.id, /^exec_[A-Za-z0-9_-]{16,64}$/u);
    assert.notEqual(admission.id, executor.id);
    assert.deepEqual(ensureLocalComponentIdentity("admission", environment), admission);
    assert.deepEqual(
      JSON.parse(await readFile(localComponentPath("admission", "identity.json", environment), "utf8")),
      admission,
    );
    assert.equal((await lstat(localComponentDirectory("admission", environment))).mode & 0o077, 0);

    const changed = { ...admission, id: "adm_abcdef0123456789" };
    assert.throws(
      () =>
        writeLocalJson(
          "admission",
          "identity.json",
          changed,
          (value) => validateLocalComponentIdentity(value, "admission"),
          environment,
        ),
      /conflicts/u,
    );
    await assert.rejects(lstat(localComponentPath("cli", "config.json", environment)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Authority setup creates private Ed25519 custody and idempotently selects the same public descriptor", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    const first = setupLocalAuthority(environment);
    const second = setupLocalAuthority(environment);
    assert.deepEqual(second, first);
    assert.equal(first.config.privateKeyFile, "private-key.pem");
    assert.match(first.config.publicKeyFingerprint, /^sha256:[a-f0-9]{64}$/u);
    assert.equal((await lstat(first.privateKeyPath)).mode & 0o777, 0o600);
    assert.equal((await lstat(localComponentDirectory("authority", environment))).mode & 0o777, 0o700);
    assert.equal((await readFile(first.configPath, "utf8")).includes("BEGIN PRIVATE KEY"), false);
    const persistedConfig = JSON.parse(await readFile(first.configPath, "utf8")) as LocalAuthorityConfig;
    assert.deepEqual(persistedConfig, first.config);
    assert.equal("d" in persistedConfig.publicKey, false);

    const conflict: LocalAuthorityConfig = {
      ...first.config,
      publicKeyFingerprint: `sha256:${"0".repeat(64)}`,
    };
    await writeFile(first.configPath, `${JSON.stringify(conflict)}\n`, { mode: 0o600 });
    assert.throws(() => setupLocalAuthority(environment), /conflicts/u);
    await assert.rejects(lstat(localComponentPath("admission", "identity.json", environment)));
    await assert.rejects(lstat(localComponentPath("executor", "identity.json", environment)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Authority descriptor rejects unsupported fields", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    const config = setupLocalAuthority(environment).config;
    assert.throws(() => validateLocalAuthorityConfig({ ...config, privateKey: "secret" }), /unsupported fields/u);
    ensureLocalComponentDirectory("authority", environment);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an adopted Runtime Authority key is copied into custody without moving, generating or replacing keys", async () => {
  const { root, environment } = await temporaryEnvironment();
  try {
    const sourcePath = path.join(root, "config", "runtime-keys", "legacy.pem");
    const source = generateAndPersistDelegatorKeyPair(sourcePath);
    const fingerprint = delegatorPublicKeyFingerprint(source);
    const sourceBytes = await readFile(sourcePath);
    const other = generateAndPersistDelegatorKeyPair(path.join(root, "other", "key.pem"));

    assert.throws(
      () => copyLocalAuthorityKey(sourcePath, delegatorPublicKeyFingerprint(other), environment),
      /adopted public fingerprint/u,
    );
    await assert.rejects(lstat(localComponentPath("authority", "private-key.pem", environment)));
    assert.throws(() => bindLocalAuthorityDescriptor(fingerprint, environment), /loaded safely/u);

    const custody = copyLocalAuthorityKey(sourcePath, fingerprint, environment);
    assert.equal(custody, localComponentPath("authority", "private-key.pem", environment));
    assert.equal(delegatorPublicKeyFingerprint(loadDelegatorKeyPair(custody)), fingerprint);
    assert.equal((await lstat(custody)).mode & 0o077, 0);
    assert.deepEqual(await readFile(sourcePath), sourceBytes);
    assert.equal(copyLocalAuthorityKey(sourcePath, fingerprint, environment), custody);

    const descriptor = bindLocalAuthorityDescriptor(fingerprint, environment);
    assert.equal(descriptor.config.publicKeyFingerprint, fingerprint);
    assert.deepEqual(bindLocalAuthorityDescriptor(fingerprint, environment), descriptor);
    assert.deepEqual(setupLocalAuthority(environment).config, descriptor.config);

    const conflicting = path.join(root, "conflict", "key.pem");
    generateAndPersistDelegatorKeyPair(conflicting);
    assert.throws(
      () =>
        copyLocalAuthorityKey(
          conflicting,
          delegatorPublicKeyFingerprint(loadDelegatorKeyPair(conflicting)),
          environment,
        ),
      /adopted public fingerprint/u,
    );
    assert.equal(delegatorPublicKeyFingerprint(loadDelegatorKeyPair(custody)), fingerprint);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
