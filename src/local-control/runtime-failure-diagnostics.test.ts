import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { createDelegatorRecord } from "../agent-authority/delegator-operations.js";
import { generateDelegatorKeyPair } from "../agent-authority/delegator-key.js";
import { DelegatorTrustError } from "../agent-authority/delegator-trust.js";
import { LocalExecutorError } from "../executor/errors.js";
import { createLocalAdmissionClient, LocalAdmissionClientError } from "../cli/runtime/admission-client.js";
import { createLocalExecutorHttpServer } from "./executor-server.js";
import { LocalExecutorClient } from "./executor-client.js";
import { createLocalAdmissionHttpServer } from "./admission-server.js";
import { createLocalSessionBinding, type LocalSessionBinding } from "./session-binding.js";
import type { LocalAdmissionConfig, LocalExecutorConfig } from "./config.js";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const REPOSITORY = { id: "123456789", name: "acme/inari" };
const EXECUTOR_ID = "exec_0123456789abcdef";
const ADMISSION_ID = "adm_0123456789abcdef";
const SECRET = "-----BEGIN PRIVATE KEY-----ghs_secretTokenValue.jwt.signature";

type Mode = {
  readonly repository?: () => unknown;
  readonly evidence?: () => unknown;
  readonly execute?: () => unknown;
};

function authorityFixture(id = "runtime-diagnostics-test") {
  const keyPair = generateDelegatorKeyPair();
  const authority = createDelegatorRecord({
    id,
    key: keyPair,
    notBefore: new Date("2026-08-01T00:00:00.000Z"),
    maxSessionTtlSeconds: 3_600,
    capabilityCeiling: ["change.implement", "change.ready", "branch.advance"],
  });
  return { keyPair, authority };
}

async function harness(mode: { current: Mode }, clock = { now: NOW }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "inari-runtime-failure-"));
  const environment = { INARI_CONFIG_HOME: path.join(root, "config") };
  const { keyPair, authority } = authorityFixture();
  const calls = { execute: 0, evidence: 0 };
  const executorConfig: LocalExecutorConfig = {
    version: 1,
    id: EXECUTOR_ID,
    listen: { host: "127.0.0.1", port: 8765 },
    provider: { kind: "github", credentialProfile: "default" },
  };
  const trustEvidence = () => ({
    repository: { repositoryHost: "github.com", repositoryId: REPOSITORY.id, nameWithOwner: REPOSITORY.name },
    authority: { ref: "refs/heads/main", sha: "a".repeat(40) },
    runtimeAuthority: authority,
  });
  const executor = createLocalExecutorHttpServer({
    config: executorConfig,
    listenPort: 0,
    version: "test",
    executorId: EXECUTOR_ID,
    resolveRepository: async () => {
      if (mode.current.repository !== undefined) throw mode.current.repository();
      return { repositoryHost: "github.com", repositoryId: REPOSITORY.id, nameWithOwner: REPOSITORY.name };
    },
    readEvidence: async () => {
      calls.evidence += 1;
      if (mode.current.evidence !== undefined) {
        const value = mode.current.evidence();
        if (value instanceof Error || (typeof value === "object" && value !== null && "code" in value)) throw value;
        return value;
      }
      return trustEvidence();
    },
    execute: async (execution) => {
      calls.execute += 1;
      if (mode.current.execute !== undefined) throw mode.current.execute();
      return { version: 1, operation: execution.operation, status: "succeeded" };
    },
  });
  await once(executor, "listening");
  const executorAddress = executor.address();
  assert.ok(executorAddress !== null && typeof executorAddress !== "string");
  const executorEndpoint = `http://127.0.0.1:${executorAddress.port}`;
  const admissionConfig: LocalAdmissionConfig = {
    version: 1,
    id: ADMISSION_ID,
    listen: { host: "127.0.0.1", port: 0 },
    executor: { id: EXECUTOR_ID, endpoint: executorEndpoint },
  };
  const admission = createLocalAdmissionHttpServer(
    admissionConfig,
    "test",
    authority,
    new LocalExecutorClient({ id: EXECUTOR_ID, endpoint: executorEndpoint }),
    { environment, now: () => clock.now },
  );
  await once(admission, "listening");
  const admissionAddress = admission.address();
  assert.ok(admissionAddress !== null && typeof admissionAddress !== "string");
  const client = createLocalAdmissionClient({ endpoint: `http://127.0.0.1:${admissionAddress.port}` });
  const binding = (sessionId: string, claim: LocalSessionBinding["capabilities"][number], ttlSeconds = 120) =>
    createLocalSessionBinding({
      sessionId,
      repository: REPOSITORY,
      task: { kind: "issue", number: 375 },
      capabilities: [claim],
      ttlSeconds,
      runtimeAuthority: authority,
      runtimeKey: keyPair,
      now: NOW,
    });
  const close = async () => {
    for (const server of [admission, executor])
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  };
  return { client, calls, binding, close, trustEvidence, executor };
}

async function failure(
  promise: Promise<unknown>,
): Promise<{ readonly code: string; readonly message: string; readonly details: Record<string, unknown> }> {
  try {
    await promise;
  } catch (error: unknown) {
    assert.ok(error instanceof LocalAdmissionClientError, String(error));
    assert.equal(error.message.includes("ghs_"), false);
    assert.equal(error.message.includes("PRIVATE KEY"), false);
    assert.equal(JSON.stringify(error.details).includes("ghs_"), false);
    return {
      code: error.code,
      message: error.message,
      details: (error.details ?? {}) as unknown as Record<string, unknown>,
    };
  }
  assert.fail("Expected a bounded Admission failure.");
}

test("repository resolution failures reach the CLI as distinct bounded classes over real HTTP", async () => {
  const mode: { current: Mode } = { current: {} };
  const runtime = await harness(mode);
  try {
    const cases: readonly [Mode["repository"], string, string][] = [
      [
        () => new LocalExecutorError("EXECUTOR_REPOSITORY_BINDING_MISSING", SECRET),
        "ADMISSION_RUNTIME_NOT_CONFIGURED",
        "EXECUTOR_REPOSITORY_BINDING_MISSING",
      ],
      [
        () => new LocalExecutorError("EXECUTOR_ISSUER_BINDING_MISMATCH", SECRET),
        "ADMISSION_RUNTIME_BINDING_MISMATCH",
        "EXECUTOR_ISSUER_BINDING_MISMATCH",
      ],
      [
        () =>
          Object.assign(new Error(SECRET), {
            code: "GITHUB_APP_CREDENTIAL_BROKER_FAILED",
            stage: "installation-scope",
          }),
        "ADMISSION_RUNTIME_BINDING_MISMATCH",
        "GITHUB_APP_INSTALLATION_SCOPE_MISMATCH",
      ],
      [
        () =>
          Object.assign(new Error(SECRET), { code: "GITHUB_APP_CREDENTIAL_BROKER_FAILED", stage: "repository-read" }),
        "ADMISSION_OWNER_UNAVAILABLE",
        "GITHUB_APP_PROVIDER_UNAVAILABLE",
      ],
      [() => new Error(SECRET), "ADMISSION_OWNER_UNAVAILABLE", "RUNTIME_OWNER_UNAVAILABLE"],
    ];
    for (const [thrown, code, reason] of cases) {
      mode.current = { repository: thrown };
      const result = await failure(runtime.client.resolveRepository(REPOSITORY.name));
      assert.equal(result.code, code, reason);
      assert.equal(result.details.endpoint, "repository");
      assert.equal(result.details.stage, "repository-resolution");
      assert.equal(result.details.reason, reason);
    }
  } finally {
    await runtime.close();
  }
});

test("Session registration separates trust, expiry, and owner availability from actual denial", async () => {
  const mode: { current: Mode } = { current: {} };
  const clock = { now: NOW };
  const runtime = await harness(mode, clock);
  try {
    const claim = { kind: "change.ready", issue: 375 } as const;
    const cases: readonly [Mode["evidence"], string, string, string][] = [
      [
        () => new DelegatorTrustError("RUNTIME_AUTHORITY_NOT_FOUND", SECRET),
        "ADMISSION_TRUST_UNVERIFIED",
        "trust-evidence",
        "RUNTIME_AUTHORITY_NOT_FOUND",
      ],
      [
        () => new DelegatorTrustError("RUNTIME_AUTHORITY_INACTIVE", SECRET),
        "ADMISSION_TRUST_UNVERIFIED",
        "trust-evidence",
        "RUNTIME_AUTHORITY_INACTIVE",
      ],
      [
        () => ({ ...runtime.trustEvidence(), runtimeAuthority: authorityFixture().authority }),
        "ADMISSION_TRUST_UNVERIFIED",
        "trust-evidence",
        "ADMISSION_RUNTIME_AUTHORITY_MISMATCH",
      ],
      [
        () => new DelegatorTrustError("RUNTIME_AUTHORITY_SOURCE_UNAVAILABLE", SECRET),
        "ADMISSION_OWNER_UNAVAILABLE",
        "trust-evidence",
        "RUNTIME_AUTHORITY_SOURCE_UNAVAILABLE",
      ],
      [
        () => new LocalExecutorError("EXECUTOR_REPOSITORY_BINDING_MISSING", SECRET),
        "ADMISSION_RUNTIME_NOT_CONFIGURED",
        "trust-evidence",
        "EXECUTOR_REPOSITORY_BINDING_MISSING",
      ],
    ];
    let index = 0;
    for (const [evidence, code, stage, reason] of cases) {
      mode.current = { evidence };
      const result = await failure(runtime.client.registerSession(runtime.binding(`session-trust-${index++}`, claim)));
      assert.equal(result.code, code, reason);
      assert.equal(result.details.endpoint, "session");
      assert.equal(result.details.stage, stage);
      assert.equal(result.details.reason, reason);
    }
    mode.current = {};
    const stale = runtime.binding("session-expired", claim, 60);
    clock.now = new Date(NOW.getTime() + 61_000);
    const expired = await failure(runtime.client.registerSession(stale));
    assert.equal(expired.code, "ADMISSION_SESSION_REJECTED");
    assert.equal(expired.details.stage, "session-registration");
    assert.equal(runtime.calls.execute, 0);
  } finally {
    await runtime.close();
  }
});

test("execution separates Session state, trust, and evidence failures without dispatching denials", async () => {
  const mode: { current: Mode } = { current: {} };
  const runtime = await harness(mode);
  try {
    const ready = runtime.binding("session-ready", { kind: "change.ready", issue: 375 });
    assert.equal((await runtime.client.registerSession(ready)).status, "active");
    const intent = (operation: "change.show" | "change.ready") => ({
      version: 1 as const,
      requestId: `request-${operation}`,
      repository: { repositoryHost: "github.com" as const, repositoryId: REPOSITORY.id },
      operation,
      request:
        operation === "change.show" ? { version: 1, issue: 375 } : { version: 1, operation: "ready", issue: 375 },
    });

    const unknown = await failure(runtime.client.executeIntent(intent("change.ready") as never, "session-unknown"));
    assert.equal(unknown.code, "ADMISSION_SESSION_REJECTED");
    assert.equal(unknown.details.stage, "implementation-admission");
    assert.equal(unknown.details.reason, "ADMISSION_SESSION_UNAVAILABLE");

    mode.current = { evidence: () => new DelegatorTrustError("RUNTIME_AUTHORITY_NOT_FOUND", SECRET) };
    const trust = await failure(runtime.client.executeIntent(intent("change.ready") as never, ready.sessionId));
    assert.equal(trust.code, "ADMISSION_TRUST_UNVERIFIED");
    assert.equal(trust.details.stage, "implementation-admission");
    assert.equal(trust.details.reason, "RUNTIME_AUTHORITY_NOT_FOUND");
    assert.equal(runtime.calls.execute, 0);

    mode.current = {};
    const malformed = await failure(runtime.client.executeIntent(intent("change.ready") as never, ready.sessionId));
    assert.equal(malformed.code, "ADMISSION_INTERNAL_FAILURE");
    assert.equal(malformed.details.reason, "ADMISSION_EVIDENCE_MALFORMED");
    assert.equal(runtime.calls.execute, 0);
  } finally {
    await runtime.close();
  }
});

test("an unreachable Executor is reported as owner unavailability, not an authorization denial", async () => {
  const mode: { current: Mode } = { current: {} };
  const runtime = await harness(mode);
  try {
    await new Promise<void>((resolve, reject) =>
      runtime.executor.close((error) => (error ? reject(error) : resolve())),
    );
    const result = await failure(runtime.client.resolveRepository(REPOSITORY.name));
    assert.equal(result.code, "ADMISSION_OWNER_UNAVAILABLE");
    assert.equal(result.details.reason, "EXECUTOR_UNAVAILABLE");
    runtime.executor.listen(0);
    await once(runtime.executor, "listening");
  } finally {
    await runtime.close();
  }
});
