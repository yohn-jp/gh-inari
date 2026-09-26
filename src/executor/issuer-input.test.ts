import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ExecutorCredentialStore } from "./credential-store.js";
import { issuerExecutionEnvironment } from "./enrollment/issuer-reference.js";
import { LocalExecutorError } from "./errors.js";

test("managed Issuer custody is canonical and explicit overrides must match it", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "inari-issuer-ref-"));
  try {
    const environment = { INARI_CONFIG_HOME: root };
    assert.equal(issuerExecutionEnvironment("exec_1234567890123456", environment), environment);
    const pem = Buffer.from(
      generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }),
    );
    const store = new ExecutorCredentialStore(environment);
    const { record } = store.save("exec_1234567890123456", "123", pem);
    const code = (expected: string) => (error: unknown) =>
      error instanceof LocalExecutorError && error.code === expected && !error.message.includes("BEGIN");
    assert.throws(
      () => issuerExecutionEnvironment("exec_1234567890123456", environment),
      code("EXECUTOR_ISSUER_CUSTODY_UNVERIFIED"),
    );
    store.markProviderVerified(record.generation);
    const resolved = issuerExecutionEnvironment("exec_1234567890123456", environment);
    assert.equal(resolved.INARI_GITHUB_APP_PRIVATE_KEY_FILE, store.keyPath(record));
    assert.equal(resolved.INARI_GITHUB_APP_ID, "123");
    // #1178: an explicit override naming the same App and key converges on custody.
    const sameKey = path.join(root, "operator-same.pem");
    writeFileSync(sameKey, pem, { mode: 0o600 });
    const same = issuerExecutionEnvironment("exec_1234567890123456", {
      ...environment,
      INARI_GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY_FILE: sameKey,
    });
    assert.equal(same.INARI_GITHUB_APP_PRIVATE_KEY_FILE, store.keyPath(record));
    assert.equal(same.GITHUB_APP_PRIVATE_KEY_FILE, undefined);
    // Any contradiction is a bounded diagnostic, never a silent preference.
    const otherKey = path.join(root, "operator-other.pem");
    writeFileSync(
      otherKey,
      generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }),
      { mode: 0o600 },
    );
    assert.throws(
      () =>
        issuerExecutionEnvironment("exec_1234567890123456", {
          ...environment,
          INARI_GITHUB_APP_PRIVATE_KEY_FILE: otherKey,
        }),
      code("EXECUTOR_ISSUER_BINDING_CONFLICT"),
    );
    assert.throws(
      () => issuerExecutionEnvironment("exec_1234567890123456", { ...environment, INARI_GITHUB_APP_ID: "456" }),
      code("EXECUTOR_ISSUER_BINDING_CONFLICT"),
    );
    assert.throws(
      () =>
        issuerExecutionEnvironment("exec_1234567890123456", {
          ...environment,
          GITHUB_APP_PRIVATE_KEY_FILE: "/absent.pem",
        }),
      code("EXECUTOR_ISSUER_KEY_INVALID"),
    );
    assert.throws(
      () => issuerExecutionEnvironment("exec_6543210987654321", environment),
      code("EXECUTOR_ISSUER_BINDING_CONFLICT"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
