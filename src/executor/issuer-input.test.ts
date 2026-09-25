import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ExecutorCredentialStore } from "./credential-store.js";
import { issuerExecutionEnvironment } from "./enrollment/issuer-reference.js";

test("managed Issuer custody supplies a file reference while explicit operator paths win", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "inari-issuer-ref-"));
  try {
    const environment = { INARI_CONFIG_HOME: root };
    assert.equal(issuerExecutionEnvironment("exec_1234567890123456", environment), environment);
    const pem = Buffer.from(
      generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }),
    );
    const store = new ExecutorCredentialStore(environment);
    const { record } = store.save("exec_1234567890123456", "123", pem);
    assert.throws(() => issuerExecutionEnvironment("exec_1234567890123456", environment), /verification is pending/u);
    store.markProviderVerified(record.generation);
    const resolved = issuerExecutionEnvironment("exec_1234567890123456", environment);
    assert.equal(resolved.INARI_GITHUB_APP_PRIVATE_KEY_FILE, store.keyPath(record));
    assert.equal(resolved.INARI_GITHUB_APP_ID, "123");
    const explicit = { ...environment, GITHUB_APP_PRIVATE_KEY_FILE: "/operator/issuer.pem" };
    assert.equal(issuerExecutionEnvironment("exec_1234567890123456", explicit), explicit);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
