import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import {
  createCapabilityExecutionProvenance,
  type CapabilityExecutionProvenance,
} from "../agent-authority/capability-provenance.js";
import { projectChangeFromGitHubEvidence, type ChangeProjectionResult } from "../change.js";
import { executeAuthorizedExecution, type AuthorizedExecution } from "../authorized-execution.js";
import { createLocalExecutorHttpServer } from "./executor-server.js";
import {
  LOCAL_EXECUTOR_EXECUTIONS_PATH,
  LOCAL_EXECUTOR_EVIDENCE_PATH,
  LOCAL_EXECUTOR_HEALTH_PATH,
  LOCAL_EXECUTOR_OWNER_OBSERVATION_PATH,
} from "./executor-http.js";
import type { LocalExecutorConfig } from "./config.js";
import { INARI_ISSUER_PRINCIPAL } from "../github/effect-authorizer.js";

const ISSUE = 465;
const REPOSITORY = { repositoryHost: "github.com", repositoryId: "123456789", nameWithOwner: "acme/inari" };
const SUBJECT = { kind: "change" as const, issue: ISSUE };
const CAPABILITY = { kind: "change.implement" as const, issue: ISSUE };

function absentProjection(): ChangeProjectionResult {
  return projectChangeFromGitHubEvidence({
    change: { repositoryHost: REPOSITORY.repositoryHost, repositoryId: REPOSITORY.repositoryId, rootIssue: ISSUE },
    branchGovernance: { pattern: "^feat/[0-9]+-[a-z0-9-]+$" },
    naming: { type: "feat", slug: "post-admission-execution" },
    baseBranch: "main",
    provenance: { issuer: INARI_ISSUER_PRINCIPAL },
    evidence: {
      issue: { status: "available", value: { number: ISSUE, state: "open" } },
      branches: { status: "absent" },
      pullRequests: { status: "absent" },
    },
  });
}

function authorizedExecution(): AuthorizedExecution {
  const provenance: CapabilityExecutionProvenance = createCapabilityExecutionProvenance({
    version: 1,
    stage: "authorized",
    repository: REPOSITORY,
    runtimeAuthority: { id: "runtime-local-test", kid: "delegator-key" },
    session: { id: "session-local-test", certificateJti: "certificate-local-test" },
    authority: { ref: "refs/heads/main", sha: "a".repeat(40) },
    request: {
      requestId: "request-local-test",
      operation: "change.show",
      issuedAt: 1_800_000_000,
      expiresAt: 1_800_000_060,
    },
    subject: SUBJECT,
    capability: CAPABILITY,
  });
  return {
    version: 1,
    operation: "change.show",
    repository: REPOSITORY,
    task: { kind: "issue", number: ISSUE },
    subject: SUBJECT,
    capability: CAPABILITY,
    provenance,
    request: { version: 1, operation: "show", issue: ISSUE },
    initialProjection: absentProjection(),
  };
}

const CONFIG: LocalExecutorConfig = {
  version: 1,
  id: "exec_0123456789abcdef",
  listen: { host: "127.0.0.1", port: 8765 },
  provider: { kind: "github", credentialProfile: "default" },
};

async function closeServer(server: ReturnType<typeof createLocalExecutorHttpServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

test("local Executor exposes health and delegates AuthorizedExecution to the #1025 primitive over loopback HTTP", async () => {
  const execution = authorizedExecution();
  const server = createLocalExecutorHttpServer({
    config: CONFIG,
    listenPort: 0,
    version: "0.14.1",
    executorId: CONFIG.id,
    execute: (input) =>
      executeAuthorizedExecution(input, {
        readExecutor: { read: async () => absentProjection() },
      }),
  });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;
  try {
    const health = await fetch(`${endpoint}${LOCAL_EXECUTOR_HEALTH_PATH}`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      ok: true,
      version: "0.14.1",
      component: "executor",
      executorId: CONFIG.id,
      protocol: 1,
      readiness: "ready",
    });

    const response = await fetch(`${endpoint}${LOCAL_EXECUTOR_EXECUTIONS_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(execution),
    });
    assert.equal(response.status, 200);
    const result = (await response.json()) as {
      readonly ok: boolean;
      readonly result: { readonly operation?: string; readonly status: string };
    };
    assert.equal(result.ok, true);
    assert.equal(result.result.operation, "change.show");
    assert.equal(result.result.status, "succeeded");
  } finally {
    await closeServer(server);
  }
});

test("local Executor rejects raw Session envelopes, CLI intents, unknown fields, and oversized bodies", async () => {
  const server = createLocalExecutorHttpServer({
    config: CONFIG,
    listenPort: 0,
    version: "0.14.1",
    executorId: CONFIG.id,
    maxBodyBytes: 4096,
    execute: async () => {
      throw new Error("Unexpected execution.");
    },
  });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}${LOCAL_EXECUTOR_EXECUTIONS_PATH}`;
  try {
    for (const body of [
      { version: 1, operation: "change.issue", session: {}, request: {} },
      { operation: "change.ready", issue: ISSUE },
      { ...authorizedExecution(), credential: { token: "must-not-be-accepted" } },
    ]) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
      assert.equal(((await response.json()) as { error: { code: string } }).error.code, "INVALID_AUTHORIZED_EXECUTION");
    }

    const oversized = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: "x".repeat(5000) }),
    });
    assert.equal(oversized.status, 413);
  } finally {
    await closeServer(server);
  }
});

test("Executor evidence endpoint is closed, bounded, read-only, and identifies the configured Executor", async () => {
  let reads = 0;
  const server = createLocalExecutorHttpServer({
    config: CONFIG,
    listenPort: 0,
    version: "0.14.1",
    executorId: CONFIG.id,
    execute: async () => {
      throw new Error("Evidence requests must not execute.");
    },
    readEvidence: async (request) => {
      reads += 1;
      return { repository: request.repository, authorityId: request.authorityId };
    },
  });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}${LOCAL_EXECUTOR_EVIDENCE_PATH}`;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        repository: { id: REPOSITORY.repositoryId, name: REPOSITORY.nameWithOwner },
        authorityId: "runtime-local-test",
        issue: ISSUE,
        implementationIssue: ISSUE,
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      component: "executor",
      executorId: CONFIG.id,
      protocol: 1,
      evidence: {
        repository: { id: REPOSITORY.repositoryId, name: REPOSITORY.nameWithOwner },
        authorityId: "runtime-local-test",
      },
    });
    for (const body of [
      { version: 1, repository: REPOSITORY, authorityId: "runtime-local-test", capabilities: [] },
      { version: 2, repository: REPOSITORY, authorityId: "runtime-local-test" },
      { version: 1, repository: REPOSITORY, authorityId: "runtime-local-test", issue: ISSUE },
    ]) {
      const denied = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(denied.status, 400);
    }
    assert.equal(reads, 1);
  } finally {
    await closeServer(server);
  }
});

const OBSERVED_EXECUTOR = "exec_0123456789abcdef";
const OBSERVATION = {
  version: 1 as const,
  executorId: OBSERVED_EXECUTOR,
  apps: [
    {
      appId: "123",
      generation: "generation-000000123",
      fingerprint: `sha256:${"b".repeat(64)}`,
      providerVerified: true,
      source: "app-scoped" as const,
    },
  ],
  bindings: [],
};

async function observationRoute(observeOwner?: () => Promise<unknown>) {
  const { createLocalExecutorHttpHandler } = await import("./executor-http.js");
  const handler = createLocalExecutorHttpHandler({
    executorId: OBSERVED_EXECUTOR,
    version: "observation-test",
    execute: async () => {
      throw new Error("execution is not part of observation");
    },
    ...(observeOwner === undefined ? {} : { observeOwner: observeOwner as () => Promise<typeof OBSERVATION> }),
  });
  return (method = "GET") =>
    handler(new Request(`http://127.0.0.1${LOCAL_EXECUTOR_OWNER_OBSERVATION_PATH}`, { method }));
}

test("#1223 owner observation route returns only the validated observation of this Executor", async () => {
  const request = await observationRoute(async () => OBSERVATION);
  const response = await request();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    ok: true,
    component: "executor",
    executorId: OBSERVED_EXECUTOR,
    protocol: 1,
    observation: OBSERVATION,
  });
  assert.equal((await request("POST")).status, 405);
});

test("#1223 owner observation fails closed when absent, failing, foreign or secret-bearing", async () => {
  const unavailable = async (observeOwner?: () => Promise<unknown>) => {
    const response = await (await observationRoute(observeOwner))();
    assert.equal(response.status, 503);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, "OWNER_OBSERVATION_UNAVAILABLE");
    assert.equal(JSON.stringify(body).includes("PRIVATE KEY"), false);
  };
  await unavailable();
  await unavailable(async () => {
    throw new Error("/home/user/.config/inari/executor/apps/123/issuer-x.pem");
  });
  await unavailable(async () => ({ ...OBSERVATION, executorId: "exec_fedcba9876543210" }));
  await unavailable(async () => ({ ...OBSERVATION, apps: [{ ...OBSERVATION.apps[0], file: "issuer-x.pem" }] }));
  await unavailable(async () => ({ ...OBSERVATION, privateKey: "-----BEGIN PRIVATE KEY-----" }));
});

test("#1223 authenticated route authorization separates Admission execution from Control observation", async () => {
  const {
    localExecutorRouteAllows,
    LOCAL_EXECUTOR_BRANCH_POLICY_PATH,
    LOCAL_EXECUTOR_GOVERNED_CONTRACT_PATH,
    LOCAL_EXECUTOR_REPOSITORY_PATH,
  } = await import("./executor-http.js");
  const admissionRoutes = [
    LOCAL_EXECUTOR_EXECUTIONS_PATH,
    LOCAL_EXECUTOR_EVIDENCE_PATH,
    LOCAL_EXECUTOR_REPOSITORY_PATH,
    LOCAL_EXECUTOR_BRANCH_POLICY_PATH,
    LOCAL_EXECUTOR_GOVERNED_CONTRACT_PATH,
  ];
  for (const route of admissionRoutes) {
    assert.equal(localExecutorRouteAllows("admission", route), true, route);
    assert.equal(localExecutorRouteAllows("control", route), false, route);
  }
  assert.equal(localExecutorRouteAllows("control", LOCAL_EXECUTOR_OWNER_OBSERVATION_PATH), true);
  assert.equal(localExecutorRouteAllows("admission", LOCAL_EXECUTOR_OWNER_OBSERVATION_PATH), false);
  assert.equal(localExecutorRouteAllows("control", LOCAL_EXECUTOR_HEALTH_PATH), true);
  assert.equal(localExecutorRouteAllows("admission", LOCAL_EXECUTOR_HEALTH_PATH), true);
  assert.equal(localExecutorRouteAllows("control", "/status"), false);
});
