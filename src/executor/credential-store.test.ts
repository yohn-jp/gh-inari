import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ExecutorAppCredentialStore, ExecutorCredentialStore } from "./credential-store.js";

function pem(): Buffer {
  return Buffer.from(
    generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }),
  );
}

test("custody atomically publishes a private RSA key and preserves it on failed replacement", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "inari-enrollment-store-"));
  try {
    const store = new ExecutorCredentialStore({ INARI_CONFIG_HOME: root });
    const first = pem();
    const saved = store.save("exec_1234567890123456", "123", first);
    assert.equal(saved.changed, true);
    assert.deepEqual(readFileSync(store.keyPath(saved.record)), first);
    assert.equal(statSync(store.keyPath(saved.record)).mode & 0o777, 0o600);
    assert.equal(store.save("exec_1234567890123456", "123", first).changed, false);
    assert.throws(() => store.save("exec_1234567890123456", "123", pem()), /custody failed/u);
    assert.equal(store.current()?.fingerprint, saved.record.fingerprint);
    assert.throws(() => store.save("exec_1234567890123456", "456", pem(), saved.record), /custody failed/u);
    assert.throws(() => store.save("exec_2345678901234567", "123", pem(), saved.record), /custody failed/u);
    assert.equal(store.current()?.fingerprint, saved.record.fingerprint);
    const replacement = store.save("exec_1234567890123456", "123", pem(), saved.record);
    assert.notEqual(replacement.record.fingerprint, saved.record.fingerprint);
    assert.equal(store.current()?.generation, replacement.record.generation);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1199 App-scoped custody keeps independent generations per App and exposes no key path", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "inari-app-store-"));
  try {
    const environment = { INARI_CONFIG_HOME: root };
    const store = new ExecutorAppCredentialStore(environment);
    assert.equal(store.current("123"), undefined);
    assert.deepEqual(store.list(), []);
    assert.equal(existsSync(path.join(root, "executor")), false, "reads never create owner directories");
    const keyA = pem();
    const keyB = pem();
    const a = store.save("exec_1234567890123456", "123", keyA).record;
    const b = store.save("exec_1234567890123456", "456", keyB).record;
    assert.notEqual(a.generation, b.generation);
    assert.notEqual(a.fingerprint, b.fingerprint);
    assert.deepEqual(
      store.list().map((item) => item.appId),
      ["123", "456"],
    );
    const fileA = path.join(root, "executor", "apps", "123", a.file);
    assert.deepEqual(readFileSync(fileA), keyA);
    assert.equal(statSync(fileA).mode & 0o777, 0o600);
    assert.deepEqual(store.readKey(b), keyB);
    // No key path accessor exists on the App-scoped store.
    assert.equal("keyPath" in store, false);
    // Replacing App A requires its exact generation and never touches App B.
    assert.throws(() => store.save("exec_1234567890123456", "123", pem()), /custody failed/u);
    assert.throws(() => store.save("exec_1234567890123456", "123", pem(), b), /custody failed/u);
    assert.throws(() => store.save("exec_2345678901234567", "123", pem(), a), /custody failed/u);
    const replaced = store.save("exec_1234567890123456", "123", pem(), a).record;
    assert.notEqual(replaced.generation, a.generation);
    assert.equal(replaced.providerVerified, false);
    assert.deepEqual(store.current("456"), b);
    assert.throws(() => store.readKey(a), /custody failed/u);
    assert.throws(() => store.markProviderVerified("456", a.generation), /custody failed/u);
    assert.equal(store.markProviderVerified("456", b.generation).providerVerified, true);
    assert.equal(store.current("123")?.providerVerified, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1199 adoption keeps the generation and reuses only a byte-identical interrupted key file", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "inari-app-adopt-"));
  try {
    const environment = { INARI_CONFIG_HOME: root };
    const legacy = new ExecutorCredentialStore(environment);
    const key = pem();
    const source = legacy.save("exec_1234567890123456", "123", key).record;
    const store = new ExecutorAppCredentialStore(environment);
    const input = {
      configId: source.configId,
      appId: source.appId,
      generation: source.generation,
      fingerprint: source.fingerprint,
      providerVerified: false,
    };
    assert.throws(() => store.adopt(input, pem()), /custody failed/u);
    // An interrupted adoption left a different key file: never overwritten or trusted.
    mkdirSync(path.join(root, "executor", "apps", "123"), { recursive: true, mode: 0o700 });
    const leftover = path.join(root, "executor", "apps", "123", `issuer-${source.generation}.pem`);
    writeFileSync(leftover, pem(), { mode: 0o600 });
    assert.throws(() => store.adopt(input, key), /custody failed/u);
    assert.equal(store.current("123"), undefined);
    writeFileSync(leftover, key, { mode: 0o600 });
    const adopted = store.adopt(input, key);
    assert.equal(adopted.changed, true);
    assert.equal(adopted.record.generation, source.generation);
    assert.equal(store.adopt(input, key).changed, false);
    assert.equal(legacy.current()?.generation, source.generation);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
