import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ExecutorCredentialStore } from "../credential-store.js";
import { ExecutorEnrollmentOwner } from "./owner.js";
import { startExecutorEnrollmentProcess } from "./server.js";

const repository = { repositoryHost: "github.com", repositoryId: "123", nameWithOwner: "owner/repo" };
function pem(): Buffer {
  return Buffer.from(
    generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }),
  );
}
function request(length: number, operationId = "enroll-1") {
  return {
    version: 1 as const,
    kind: "executor-issuer-private-key" as const,
    operationId,
    repository,
    declaredBytes: length,
  };
}
async function* stream(bytes: Buffer) {
  yield bytes;
}

test("owner capability is single-use, expires, and requires exact replacement confirmation", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "inari-enrollment-owner-"));
  try {
    let now = 1000;
    const environment = { INARI_CONFIG_HOME: root };
    const owner = new ExecutorEnrollmentOwner({
      configId: "exec_1234567890123456",
      appId: "123",
      environment,
      now: () => now,
      verifyProvider: async () => false,
    });
    const first = pem();
    const grant = owner.issue();
    const receipt = await owner.enrollStream(grant, request(first.length), stream(first));
    assert.equal(receipt.stored, true);
    assert.equal(receipt.providerVerified, false);
    assert.rejects(owner.enrollStream(grant, request(first.length), stream(first)), /rejected/u);
    const store = new ExecutorCredentialStore(environment);
    const prior = store.current();
    assert.ok(prior);
    assert.throws(
      () =>
        new ExecutorEnrollmentOwner({
          configId: "exec_2345678901234567",
          appId: "123",
          environment,
        }).issue(),
      /rejected/u,
    );
    assert.throws(
      () =>
        new ExecutorEnrollmentOwner({
          configId: "exec_1234567890123456",
          appId: "456",
          environment,
        }).issue(),
      /rejected/u,
    );
    await assert.rejects(
      owner.enrollStream(owner.issue(), request(64 * 1024), stream(Buffer.alloc(64 * 1024 + 1))),
      /rejected/u,
    );
    await assert.rejects(owner.enrollStream(owner.issue(), request(3), stream(Buffer.from("bad"))), /custody failed/u);
    assert.equal(store.current()?.generation, prior.generation);
    const second = pem();
    await assert.rejects(owner.enrollStream(owner.issue(), request(second.length), stream(second)), /custody failed/u);
    assert.equal(store.current()?.generation, prior.generation);
    assert.throws(() => owner.issue({ generation: "wrong", fingerprint: prior.fingerprint }), /rejected/u);
    const expired = owner.issue({ generation: prior.generation, fingerprint: prior.fingerprint });
    now += 60_000;
    await assert.rejects(owner.enrollStream(expired, request(second.length), stream(second)), /rejected/u);
    const source = path.join(root, "operator.pem");
    writeFileSync(source, second, { mode: 0o600 });
    const replaced = await owner.enrollReference(
      owner.issue({ generation: prior.generation, fingerprint: prior.fingerprint }),
      request(second.length, "enroll-2"),
      source,
    );
    assert.equal(replaced.stored, true);
    assert.notEqual(replaced.publicFingerprint, prior.fingerprint);
    assert.equal(store.current()?.generation, replaced.generation);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("enrollment process starts without a key and exposes no execution route", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "inari-enrollment-http-"));
  const process = await startExecutorEnrollmentProcess({
    configId: "exec_1234567890123456",
    appId: "123",
    environment: { INARI_CONFIG_HOME: root },
    verifyProvider: async () => false,
  });
  try {
    assert.equal((await fetch(`${process.endpoint}/execute`, { method: "POST" })).status, 404);
    const bytes = pem();
    const capability = process.owner.issue();
    const response = await fetch(`${process.endpoint}/enroll`, {
      method: "POST",
      body: new Uint8Array(bytes),
      headers: {
        "x-inari-enrollment-capability": capability.token,
        "x-inari-enrollment-request": Buffer.from(JSON.stringify(request(bytes.length))).toString("base64url"),
      },
    });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { stored: boolean }).stored, true);
  } finally {
    await new Promise<void>((resolve) => process.server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider verification is a separate persisted readiness state", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "inari-enrollment-verified-"));
  try {
    const environment = { INARI_CONFIG_HOME: root };
    const owner = new ExecutorEnrollmentOwner({
      configId: "exec_1234567890123456",
      appId: "123",
      environment,
      verifyProvider: async () => true,
    });
    const bytes = pem();
    const receipt = await owner.enrollStream(owner.issue(), request(bytes.length), stream(bytes));
    assert.equal(receipt.providerVerified, true);
    const current = new ExecutorCredentialStore(environment).current();
    assert.ok(current);
    assert.equal(current?.providerVerified, true);
    const retry = await owner.enrollStream(owner.issue(), request(bytes.length, "retry"), stream(bytes));
    assert.equal(retry.generation, current.generation);
    assert.equal(retry.providerVerified, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
