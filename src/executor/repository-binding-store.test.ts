import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ExecutorAppCredentialStore } from "./credential-store.js";
import {
  ExecutorRepositoryBindingStore,
  repositoryBindingState,
  type ExecutorRepositoryBinding,
} from "./repository-binding-store.js";

function pem(): Buffer {
  return Buffer.from(
    generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }),
  );
}

const CONFIG = "exec_1234567890123456";

function binding(
  credential: { appId: string; generation: string; fingerprint: string },
  repositoryId: string,
  nameWithOwner: string,
  installationId = "77",
): ExecutorRepositoryBinding {
  return {
    repositoryHost: "github.com",
    repositoryId,
    nameWithOwner,
    appId: credential.appId,
    installationId,
    generation: credential.generation,
    fingerprint: credential.fingerprint,
  };
}

test("#1199 one App credential binds many repositories without duplicating its key", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "inari-binding-shared-"));
  try {
    const environment = { INARI_CONFIG_HOME: root };
    const apps = new ExecutorAppCredentialStore(environment);
    const store = new ExecutorRepositoryBindingStore(environment);
    assert.deepEqual(store.list(), []);
    const key = pem();
    const unverified = apps.save(CONFIG, "123", key).record;
    // Provider verification of the key is required before any binding is published.
    assert.throws(() => store.publish(binding(unverified, "1", "owner/one")), /failed closed/u);
    const credential = apps.markProviderVerified("123", unverified.generation);
    const one = store.publish(binding(credential, "1", "owner/one"));
    const two = store.publish(binding(credential, "2", "owner/two", "78"));
    assert.equal(one.changed, true);
    assert.equal(two.changed, true);
    assert.equal(store.publish(binding(credential, "1", "owner/one")).changed, false);
    assert.deepEqual(
      store.list().map((item) => [item.repositoryId, item.appId, item.installationId, item.generation]),
      [
        ["1", "123", "77", credential.generation],
        ["2", "123", "78", credential.generation],
      ],
    );
    assert.equal(store.find("github.com", "OWNER/One")?.repositoryId, "1");
    // Exactly one key file exists for the App; binding storage holds public IDs only.
    const pemFiles = readdirSync(path.join(root, "executor"), { recursive: true }).filter((entry) =>
      String(entry).endsWith(".pem"),
    );
    assert.deepEqual(pemFiles, [path.join("apps", "123", credential.file)]);
    const stored = readdirSync(path.join(root, "executor", "repository-bindings"))
      .map((entry) => readFileSync(path.join(root, "executor", "repository-bindings", entry), "utf8"))
      .join("\n");
    assert.equal(stored.includes("PRIVATE KEY"), false);
    assert.equal(stored.includes(".pem"), false);
    assert.equal(stored.includes(root), false);
    assert.deepEqual(Object.keys(store.read("1") ?? {}).sort(), [
      "appId",
      "fingerprint",
      "generation",
      "installationId",
      "nameWithOwner",
      "repositoryHost",
      "repositoryId",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1199 wrong repository, App, installation or generation never satisfies a binding", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "inari-binding-wrong-"));
  try {
    const environment = { INARI_CONFIG_HOME: root };
    const apps = new ExecutorAppCredentialStore(environment);
    const store = new ExecutorRepositoryBindingStore(environment);
    const a = apps.markProviderVerified("123", apps.save(CONFIG, "123", pem()).record.generation);
    const b = apps.markProviderVerified("456", apps.save(CONFIG, "456", pem()).record.generation);
    const bound = store.publish(binding(a, "1", "owner/one")).binding;
    assert.equal(repositoryBindingState(bound, a), "bound");
    assert.equal(repositoryBindingState(bound, b), "stale");
    assert.equal(repositoryBindingState(bound, { ...a, generation: b.generation }), "stale");
    assert.equal(repositoryBindingState(bound, { ...a, fingerprint: b.fingerprint }), "stale");
    assert.equal(repositoryBindingState(bound, { ...a, providerVerified: false }), "stale");
    assert.equal(repositoryBindingState(bound, undefined), "stale");
    assert.equal(store.read("2"), undefined);
    // A generation or fingerprint that is not the App's current verified one is refused.
    assert.throws(() => store.publish({ ...binding(a, "2", "owner/two"), generation: b.generation }), /failed/u);
    assert.throws(() => store.publish({ ...binding(a, "2", "owner/two"), fingerprint: b.fingerprint }), /failed/u);
    assert.throws(() => store.publish({ ...binding(a, "2", "owner/two"), appId: "789" }), /failed/u);
    assert.throws(() => store.publish({ ...binding(a, "2", "owner/two"), repositoryHost: "example.com" }), /failed/u);
    // A bound repository never silently moves to another installation or App.
    assert.throws(() => store.publish(binding(a, "1", "owner/one", "78")), /failed/u);
    assert.throws(() => store.publish(binding(b, "1", "owner/one")), /failed/u);
    assert.deepEqual(store.read("1"), bound);
    // A record whose content names another repository fails closed.
    writeFileSync(
      path.join(root, "executor", "repository-bindings", "3.json"),
      JSON.stringify(binding(a, "4", "owner/four")),
      { mode: 0o600 },
    );
    assert.throws(() => store.read("3"), /failed closed/u);
    assert.throws(() => store.list(), /failed closed/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1199 a new App key generation leaves old bindings stale until explicitly reverified", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "inari-binding-generation-"));
  try {
    const environment = { INARI_CONFIG_HOME: root };
    const apps = new ExecutorAppCredentialStore(environment);
    const store = new ExecutorRepositoryBindingStore(environment);
    const first = apps.markProviderVerified("123", apps.save(CONFIG, "123", pem()).record.generation);
    const old = store.publish(binding(first, "1", "owner/one")).binding;
    const replaced = apps.save(CONFIG, "123", pem(), first).record;
    assert.equal(repositoryBindingState(old, apps.current("123")), "stale");
    assert.deepEqual(store.read("1"), old, "the old record is kept but no longer satisfied");
    // The replacement is not verified yet, so it cannot be bound.
    assert.throws(() => store.publish(binding(replaced, "1", "owner/one")), /failed/u);
    const verified = apps.markProviderVerified("123", replaced.generation);
    const renewed = store.publish(binding(verified, "1", "owner/one"));
    assert.equal(renewed.changed, true);
    assert.equal(repositoryBindingState(renewed.binding, apps.current("123")), "bound");
    // Reverification never permits a move to another installation.
    assert.throws(() => store.publish(binding(verified, "1", "owner/one", "99")), /failed/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
