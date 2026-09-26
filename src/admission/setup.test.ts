import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createDelegatorRecord } from "../agent-authority/delegator-operations.js";
import { delegatorPublicKeyFingerprint, generateDelegatorKeyPair } from "../agent-authority/delegator-key.js";
import { validateLocalAuthorityConfig, validateLocalExecutorConfig, writeLocalJson } from "../local-control/config.js";
import * as facade from "../local-control/admission-server.js";
import * as server from "./server.js";
import * as setup from "./setup.js";
import { LocalAdmissionError, readLocalAdmissionConfiguration, setupLocalAdmission } from "./setup.js";

const EXECUTOR_ID = "exec_0123456789abcdef";

function authorityFixture() {
  const keyPair = generateDelegatorKeyPair();
  const authority = createDelegatorRecord({
    id: "runtime-admission-setup-test",
    key: keyPair,
    notBefore: new Date("2026-08-01T00:00:00.000Z"),
    maxSessionTtlSeconds: 3_600,
    capabilityCeiling: ["change.implement"],
  });
  return { keyPair, authority };
}

async function withEnvironment(run: (environment: NodeJS.ProcessEnv) => Promise<void> | void): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "inari-admission-setup-"));
  try {
    await run({ INARI_CONFIG_HOME: path.join(root, "config") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function hasCode(code: string) {
  return (error: unknown) => error instanceof LocalAdmissionError && error.code === code;
}

test("the local-control path is a facade over the Admission setup and server modules", () => {
  assert.equal(facade.setupLocalAdmission, setup.setupLocalAdmission);
  assert.equal(facade.LocalAdmissionError, setup.LocalAdmissionError);
  assert.equal(facade.LOCAL_ADMISSION_DEFAULT_PORT, setup.LOCAL_ADMISSION_DEFAULT_PORT);
  assert.equal(facade.createLocalAdmissionHttpServer, server.createLocalAdmissionHttpServer);
  assert.equal(facade.startConfiguredLocalAdmission, server.startConfiguredLocalAdmission);
  assert.deepEqual(
    [
      facade.LOCAL_ADMISSION_STATUS_PATH,
      facade.LOCAL_ADMISSION_PROTOCOL_VERSION,
      facade.LOCAL_ADMISSION_HEALTH_PATH,
      facade.LOCAL_ADMISSION_SESSIONS_PATH,
      facade.LOCAL_ADMISSION_REPOSITORY_PATH,
      facade.LOCAL_ADMISSION_EXECUTIONS_PATH,
      facade.LOCAL_ADMISSION_SESSION_ID_HEADER,
      facade.MAX_LOCAL_ADMISSION_BODY_BYTES,
    ],
    ["/status", 1, "/health", "/v1/sessions", "/v1/repository", "/v1/executions", "x-inari-session-id", 1_048_576],
  );
});

test("Admission setup requires matching public Authority trust and a set-up Executor", async () => {
  await withEnvironment((environment) => {
    const { keyPair, authority } = authorityFixture();
    assert.throws(() => setupLocalAdmission({ id: "invalid" }, environment));
    assert.throws(() => setupLocalAdmission(authority, environment), hasCode("ADMISSION_AUTHORITY_MISMATCH"));
    writeLocalJson(
      "authority",
      "config.json",
      {
        version: 1,
        publicKey: keyPair.publicKeyJwk,
        publicKeyFingerprint: delegatorPublicKeyFingerprint(authority.key),
        privateKeyFile: "private-key.pem",
      },
      validateLocalAuthorityConfig,
      environment,
    );
    assert.throws(() => setupLocalAdmission(authority, environment), hasCode("EXECUTOR_NOT_SETUP"));
    const other = authorityFixture().authority;
    assert.throws(() => setupLocalAdmission(other, environment), hasCode("ADMISSION_AUTHORITY_MISMATCH"));
  });
});

test("Admission configuration reads fail closed before setup and return pinned public trust after setup", async () => {
  await withEnvironment((environment) => {
    assert.throws(() => readLocalAdmissionConfiguration(environment), hasCode("ADMISSION_NOT_SETUP"));
    const { keyPair, authority } = authorityFixture();
    writeLocalJson(
      "authority",
      "config.json",
      {
        version: 1,
        publicKey: keyPair.publicKeyJwk,
        publicKeyFingerprint: delegatorPublicKeyFingerprint(authority.key),
        privateKeyFile: "private-key.pem",
      },
      validateLocalAuthorityConfig,
      environment,
    );
    writeLocalJson(
      "executor",
      "config.json",
      {
        version: 1,
        id: EXECUTOR_ID,
        listen: { host: "127.0.0.1", port: 0 },
        provider: { kind: "github", credentialProfile: "default" },
      },
      validateLocalExecutorConfig,
      environment,
    );
    const result = setupLocalAdmission(authority, environment);
    const configured = readLocalAdmissionConfiguration(environment);
    assert.deepEqual(configured.config, result.config);
    assert.deepEqual(configured.runtimeAuthority, authority);
    assert.equal(configured.config.listen.port, setup.LOCAL_ADMISSION_DEFAULT_PORT);
    assert.equal(JSON.stringify(configured).includes("PRIVATE KEY"), false);
  });
});
