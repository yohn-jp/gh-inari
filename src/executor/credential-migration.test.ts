import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { adoptLegacyExecutorCustody, legacyExecutorCustodyPresent } from "./credential-migration.js";
import { ExecutorAppCredentialStore, ExecutorCredentialStore } from "./credential-store.js";
import { ExecutorRepositoryBindingStore, repositoryBindingState } from "./repository-binding-store.js";

function pem(): Buffer {
  return Buffer.from(
    generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }),
  );
}

const CONFIG = "exec_1234567890123456";
const ONE = { repositoryHost: "github.com", repositoryId: "1", nameWithOwner: "owner/one", installationId: "77" };
const TWO = { repositoryHost: "github.com", repositoryId: "2", nameWithOwner: "owner/two", installationId: "77" };

function legacyWithBindings(environment: NodeJS.ProcessEnv, key = pem()) {
  const legacy = new ExecutorCredentialStore(environment);
  const { record } = legacy.save(CONFIG, "123", key);
  legacy.recordBinding(record.generation, ONE);
  return { legacy, key, record: legacy.recordBinding(record.generation, TWO) };
}

function legacyBytes(root: string): string {
  const index = path.join(root, "executor", "issuer", "issuer-key.json");
  const record = JSON.parse(readFileSync(index, "utf8")) as { file: string };
  return readFileSync(index, "utf8") + readFileSync(path.join(root, "executor", "issuer", record.file), "utf8");
}

test("#1199 absent legacy custody adopts nothing and creates no owner directories", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "inari-adopt-absent-"));
  try {
    const environment = { INARI_CONFIG_HOME: root };
    assert.equal(legacyExecutorCustodyPresent(environment), false);
    assert.deepEqual(adoptLegacyExecutorCustody(environment), { status: "absent", bindings: 0 });
    assert.equal(existsSync(path.join(root, "executor")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1199 legacy single-App custody and bindings adopt idempotently without key regeneration", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "inari-adopt-legacy-"));
  try {
    const environment = { INARI_CONFIG_HOME: root };
    const { key, record } = legacyWithBindings(environment);
    const before = legacyBytes(root);
    const adopted = adoptLegacyExecutorCustody(environment);
    assert.deepEqual(adopted, {
      status: "adopted",
      appId: "123",
      generation: record.generation,
      fingerprint: record.fingerprint,
      bindings: 2,
    });
    // The public outcome carries IDs only.
    assert.equal(JSON.stringify(adopted).includes(root), false);
    assert.equal(JSON.stringify(adopted).includes(".pem"), false);
    const apps = new ExecutorAppCredentialStore(environment);
    const credential = apps.current("123");
    assert.equal(credential?.generation, record.generation);
    assert.equal(credential?.fingerprint, record.fingerprint);
    assert.equal(credential?.providerVerified, true);
    assert.deepEqual(apps.readKey(credential!), key);
    const bindings = new ExecutorRepositoryBindingStore(environment).list();
    assert.deepEqual(
      bindings.map((item) => [item.repositoryId, item.appId, item.installationId, item.generation, item.fingerprint]),
      [
        ["1", "123", "77", record.generation, record.fingerprint],
        ["2", "123", "77", record.generation, record.fingerprint],
      ],
    );
    assert.ok(bindings.every((item) => repositoryBindingState(item, credential) === "bound"));
    assert.equal(adoptLegacyExecutorCustody(environment).status, "unchanged");
    // The legacy working credential is never rewritten or deleted.
    assert.equal(legacyBytes(root), before);
    assert.equal(new ExecutorCredentialStore(environment).current()?.generation, record.generation);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1199 interrupted adoption leaves the legacy credential working and a rerun converges", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "inari-adopt-interrupted-"));
  try {
    const environment = { INARI_CONFIG_HOME: root };
    const { record } = legacyWithBindings(environment);
    const before = legacyBytes(root);
    // Binding storage is unusable: the App credential commits, the bindings cannot.
    const blocker = path.join(root, "executor", "repository-bindings");
    writeFileSync(blocker, "not a directory", { mode: 0o600 });
    assert.throws(() => adoptLegacyExecutorCustody(environment), /adoption failed closed/u);
    assert.equal(legacyBytes(root), before);
    const legacy = new ExecutorCredentialStore(environment);
    assert.equal(legacy.current()?.generation, record.generation);
    assert.equal(legacy.readKey(record).length > 0, true);
    assert.equal(new ExecutorAppCredentialStore(environment).current("123")?.generation, record.generation);
    rmSync(blocker);
    assert.equal(adoptLegacyExecutorCustody(environment).status, "adopted");
    assert.equal(new ExecutorRepositoryBindingStore(environment).list().length, 2);
    assert.equal(adoptLegacyExecutorCustody(environment).status, "unchanged");
    assert.equal(legacyBytes(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1199 a diverged App generation fails closed unless the owner names the exact replaced generation", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "inari-adopt-diverged-"));
  try {
    const environment = { INARI_CONFIG_HOME: root };
    const legacy = new ExecutorCredentialStore(environment);
    const first = legacy.save(CONFIG, "123", pem()).record;
    assert.equal(adoptLegacyExecutorCustody(environment).status, "adopted");
    const apps = new ExecutorAppCredentialStore(environment);
    const adopted = apps.current("123")!;
    const replaced = legacy.save(CONFIG, "123", pem(), first).record;
    assert.throws(() => adoptLegacyExecutorCustody(environment), /adoption failed closed/u);
    assert.throws(
      () =>
        adoptLegacyExecutorCustody(environment, {
          replacing: { generation: replaced.generation, fingerprint: adopted.fingerprint },
        }),
      /adoption failed closed/u,
    );
    assert.equal(apps.current("123")?.generation, adopted.generation);
    const advanced = adoptLegacyExecutorCustody(environment, { replacing: adopted });
    assert.equal(advanced.status, "adopted");
    assert.equal(apps.current("123")?.generation, replaced.generation);
    // A legacy index bound to another App credential configuration is never adopted.
    const other = mkdtempSync(path.join(os.tmpdir(), "inari-adopt-config-"));
    try {
      const otherEnvironment = { INARI_CONFIG_HOME: other };
      new ExecutorAppCredentialStore(otherEnvironment).save("exec_2345678901234567", "123", pem());
      new ExecutorCredentialStore(otherEnvironment).save(CONFIG, "123", pem());
      assert.throws(() => adoptLegacyExecutorCustody(otherEnvironment), /adoption failed closed/u);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
