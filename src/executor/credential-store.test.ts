import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ExecutorCredentialStore } from "./credential-store.js";

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
