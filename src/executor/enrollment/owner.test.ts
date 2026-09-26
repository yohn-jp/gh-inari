import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ExecutorAppCredentialStore, ExecutorCredentialStore } from "../credential-store.js";
import { ExecutorEnrollmentOwner, executorAppCustody, executorIssuerCustody } from "./owner.js";
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

test("a stored key is verified against an explicit installation only by the Executor owner", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "inari-enrollment-installation-"));
  try {
    const environment = { INARI_CONFIG_HOME: root };
    const seen: string[] = [];
    let accept = false;
    const owner = new ExecutorEnrollmentOwner({
      configId: "exec_1234567890123456",
      appId: "123",
      environment,
      verifyProvider: async () => false,
      verifyInstallation: async (key, target, installationId) => {
        assert.match(key, /BEGIN PRIVATE KEY/u);
        seen.push(`${target.repositoryId}:${installationId}`);
        return accept;
      },
    });
    await assert.rejects(owner.verifyStoredProvider(repository, "77"), /rejected/u);
    const bytes = pem();
    await owner.enrollStream(owner.issue(), request(bytes.length), stream(bytes));
    await assert.rejects(owner.verifyStoredProvider(repository, "not-an-id"), /rejected/u);
    assert.equal(await owner.verifyStoredProvider(repository, "77"), false);
    assert.equal(executorIssuerCustody(environment)?.providerVerified, false);
    accept = true;
    assert.equal(await owner.verifyStoredProvider(repository, "77"), true);
    const status = executorIssuerCustody(environment);
    assert.equal(status?.providerVerified, true);
    assert.deepEqual(Object.keys(status ?? {}).sort(), [
      "appId",
      "bindings",
      "configId",
      "fingerprint",
      "generation",
      "providerVerified",
    ]);
    // #1182: the verified installation is the Executor's own repository binding.
    assert.deepEqual(status?.bindings, [
      {
        repositoryHost: repository.repositoryHost,
        repositoryId: repository.repositoryId,
        nameWithOwner: repository.nameWithOwner,
        installationId: "77",
      },
    ]);
    assert.equal(await owner.verifyStoredProvider(repository, "77"), true);
    await assert.rejects(owner.verifyStoredProvider(repository, "78"), /rejected/u);
    assert.deepEqual(seen, ["123:77", "123:77"]);
    const other = new ExecutorEnrollmentOwner({ configId: "exec_1234567890123456", appId: "456", environment });
    await assert.rejects(other.verifyStoredProvider(repository, "77"), /rejected/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1199 enrollment for App A never replaces or reads App B, and status exposes no key path", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "inari-enrollment-apps-"));
  try {
    const environment = { INARI_CONFIG_HOME: root };
    const seen: string[] = [];
    const owner = (appId: string) =>
      new ExecutorEnrollmentOwner({
        configId: "exec_1234567890123456",
        appId,
        environment,
        verifyProvider: async () => false,
        verifyInstallation: async (key, target, installationId) => {
          seen.push(`${appId}:${target.repositoryId}:${installationId}:${key.length}`);
          return true;
        },
      });
    const keyA = pem();
    const keyB = pem();
    const a = owner("123");
    const b = owner("456");
    const enrolledA = await a.enrollStream(a.issue(), request(keyA.length), stream(keyA));
    const legacyBefore = executorIssuerCustody(environment);
    const enrolledB = await b.enrollStream(b.issue(), request(keyB.length, "enroll-b"), stream(keyB));
    assert.notEqual(enrolledB.generation, enrolledA.generation);
    // App B is App-scoped only; the legacy single-App projection still names App A unchanged.
    assert.deepEqual(executorIssuerCustody(environment), legacyBefore);
    const apps = new ExecutorAppCredentialStore(environment);
    assert.deepEqual(apps.readKey(apps.current("123")!), keyA);
    assert.deepEqual(apps.readKey(apps.current("456")!), keyB);
    // App B's replacement grant cannot name App A's generation, and a different key needs confirmation.
    assert.throws(() => b.issue({ generation: enrolledA.generation!, fingerprint: enrolledA.publicFingerprint! }));
    const keyC = pem();
    await assert.rejects(b.enrollStream(b.issue(), request(keyC.length, "b-c"), stream(keyC)), /custody failed/u);
    assert.equal(apps.current("123")?.generation, enrolledA.generation);
    assert.equal(apps.current("456")?.generation, enrolledB.generation);

    const other = { repositoryHost: "github.com", repositoryId: "124", nameWithOwner: "owner/other" };
    assert.equal(await a.verifyStoredProvider(repository, "77"), true);
    assert.equal(await a.verifyStoredProvider(other, "77"), true);
    assert.equal(await b.verifyStoredProvider({ ...other, repositoryId: "125", nameWithOwner: "owner/b" }, "88"), true);
    // A repository bound to App A never moves to App B.
    await assert.rejects(b.verifyStoredProvider(repository, "77"), /rejected/u);
    assert.deepEqual(seen, [`123:123:77:${keyA.length}`, `123:124:77:${keyA.length}`, `456:125:88:${keyB.length}`]);
    const status = executorAppCustody(environment);
    assert.deepEqual(
      status.apps.map((item) => [item.appId, item.providerVerified]),
      [
        ["123", true],
        ["456", true],
      ],
    );
    assert.deepEqual(
      status.bindings.map((item) => [item.repositoryId, item.appId, item.installationId, item.status]),
      [
        ["123", "123", "77", "bound"],
        ["124", "123", "77", "bound"],
        ["125", "456", "88", "bound"],
      ],
    );
    // Secret-path negative proof: public status carries IDs only.
    const rendered = JSON.stringify({ status, legacy: executorIssuerCustody(environment) });
    for (const forbidden of [root, ".pem", "PRIVATE KEY", "file", "path"])
      assert.equal(rendered.includes(forbidden), false, forbidden);
    assert.deepEqual(Object.keys(status.apps[0] ?? {}).sort(), [
      "appId",
      "configId",
      "fingerprint",
      "generation",
      "providerVerified",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1199 replacing an App key generation leaves its repository bindings stale until reverified", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "inari-enrollment-replace-"));
  try {
    const environment = { INARI_CONFIG_HOME: root };
    let calls = 0;
    const owner = new ExecutorEnrollmentOwner({
      configId: "exec_1234567890123456",
      appId: "123",
      environment,
      verifyProvider: async () => false,
      verifyInstallation: async () => {
        calls += 1;
        return true;
      },
    });
    const first = pem();
    const enrolled = await owner.enrollStream(owner.issue(), request(first.length), stream(first));
    assert.equal(await owner.verifyStoredProvider(repository, "77"), true);
    assert.equal(executorAppCustody(environment).bindings[0]?.status, "bound");
    const second = pem();
    const replaced = await owner.enrollStream(
      owner.issue({ generation: enrolled.generation!, fingerprint: enrolled.publicFingerprint! }),
      request(second.length, "replace"),
      stream(second),
    );
    const apps = new ExecutorAppCredentialStore(environment);
    // Legacy projection and App-scoped custody converge on the same new generation.
    assert.equal(apps.current("123")?.generation, replaced.generation);
    assert.equal(new ExecutorCredentialStore(environment).current()?.generation, replaced.generation);
    assert.deepEqual(executorIssuerCustody(environment)?.bindings, []);
    assert.deepEqual(
      executorAppCustody(environment).bindings.map((item) => [item.generation, item.status]),
      [[enrolled.generation, "stale"]],
    );
    // Reverification is explicit and binds the exact new generation.
    assert.equal(await owner.verifyStoredProvider(repository, "77"), true);
    assert.equal(calls, 2);
    assert.deepEqual(
      executorAppCustody(environment).bindings.map((item) => [item.generation, item.status]),
      [[replaced.generation, "bound"]],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
