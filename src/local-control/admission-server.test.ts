import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import { createDelegatorRecord } from "../agent-authority/delegator-operations.js";
import { generateDelegatorKeyPair, delegatorPublicKeyFingerprint } from "../agent-authority/delegator-key.js";
import { projectChangeFromGitHubEvidence, type ChangeProjectionResult } from "../change.js";
import { renderImplementationIssueBody } from "../implementation-contract.js";
import { createLocalExecutorHttpServer, type LocalExecutorHttpServerOptions } from "./executor-server.js";
import { LocalExecutorClient } from "./executor-client.js";
import {
  createLocalAdmissionHttpServer,
  LOCAL_ADMISSION_EXECUTIONS_PATH,
  LOCAL_ADMISSION_HEALTH_PATH,
  MAX_LOCAL_ADMISSION_BODY_BYTES,
  LOCAL_ADMISSION_SESSION_ID_HEADER,
  LOCAL_ADMISSION_SESSIONS_PATH,
  LocalAdmissionError,
  setupLocalAdmission,
  startConfiguredLocalAdmission,
} from "./admission-server.js";
import { createLocalSessionBinding } from "./session-binding.js";
import {
  localComponentPath,
  validateLocalAdmissionConfig,
  validateLocalAuthorityConfig,
  validateLocalExecutorConfig,
  writeLocalJson,
  type LocalAdmissionConfig,
  type LocalExecutorConfig,
} from "./config.js";
import { LOCAL_SESSION_BINDING_VERSION, type LocalSessionBinding } from "./session-binding.js";
import { clearLocalRuntimeEndpoint, publishLocalRuntimeEndpoint } from "./runtime-discovery.js";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const REPOSITORY = { repositoryHost: "github.com", repositoryId: "123456789", repository: "acme/inari" };
const SESSION_REPOSITORY = { id: REPOSITORY.repositoryId, name: REPOSITORY.repository };
const ISSUE = 375;
const BRANCH = "feat/375-local-admission";
const BASE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const AUTHORITY_REF = "refs/heads/main";
const EXECUTOR_ID = "exec_0123456789abcdef";
const ADMISSION_ID = "adm_0123456789abcdef";

async function temporaryEnvironment(): Promise<{ readonly root: string; readonly environment: NodeJS.ProcessEnv }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "inari-local-admission-"));
  return { root, environment: { INARI_CONFIG_HOME: path.join(root, "config") } };
}

function authorityFixture() {
  const keyPair = generateDelegatorKeyPair();
  const authority = createDelegatorRecord({
    id: "runtime-admission-test",
    key: keyPair,
    notBefore: new Date("2026-08-01T00:00:00.000Z"),
    maxSessionTtlSeconds: 3_600,
    capabilityCeiling: ["change.implement", "change.ready", "branch.advance"],
  });
  return { keyPair, authority };
}

function implementationBody(): string {
  return renderImplementationIssueBody({
    version: 1,
    kind: "implementation",
    repository: REPOSITORY,
    sources: [{ ...REPOSITORY, number: ISSUE }],
    objective: "Admit local execution against current evidence.",
    nonGoals: ["Persisting derived scope."],
    architecture: {
      decision: "Derive current authorization for every execution.",
      affectedComponents: ["Admission"],
      invariants: ["Executor identity is pinned."],
      compatibilityConstraints: [],
    },
    scope: { readOnly: ["src/**"], write: ["src/**"], create: ["src/**"], delete: [], deny: [] },
    constraints: { prohibitedOperations: [], immutableAreas: [], prerequisites: [] },
    verification: {
      acceptanceCriteria: ["Admission denies stale evidence."],
      targetedTests: [],
      requiredChecks: [],
      postconditions: [],
    },
    execution: {
      baseBranch: "main",
      baseRevision: BASE_SHA,
      baseFreshness: BASE_SHA,
      branch: BRANCH,
      dependencies: [],
    },
  });
}

function changeProjection(): ChangeProjectionResult {
  return projectChangeFromGitHubEvidence({
    change: { repositoryHost: REPOSITORY.repositoryHost, repositoryId: REPOSITORY.repositoryId, rootIssue: ISSUE },
    branchGovernance: { pattern: "^feat/[0-9]+-[a-z0-9-]+$" },
    naming: { type: "feat", slug: "local-admission" },
    baseBranch: "main",
    evidence: {
      issue: { status: "available", value: { number: ISSUE, state: "open" } },
      branches: { status: "available", value: [{ name: BRANCH, sha: HEAD_SHA, rootIssue: ISSUE }] },
      pullRequests: {
        status: "available",
        value: [
          {
            number: 5375,
            head: BRANCH,
            headSha: HEAD_SHA,
            base: "main",
            state: "open",
            draft: true,
            merged: false,
            rootIssue: ISSUE,
          },
        ],
      },
    },
  });
}

function implementationEvidence() {
  const body = implementationBody();
  const reference = { ...REPOSITORY, number: ISSUE };
  return {
    implementation: reference,
    issue: { reference, body },
    repository: REPOSITORY,
    base: { branch: "main", revision: BASE_SHA, freshness: BASE_SHA },
    readiness: { evidence: [] },
    change: changeProjection(),
  };
}

function bindingFixture(
  keyPair: ReturnType<typeof generateDelegatorKeyPair>,
  authority: ReturnType<typeof authorityFixture>["authority"],
  sessionId: string,
  claim: { readonly kind: string; readonly issue?: number; readonly branch?: string } = {
    kind: "branch.advance",
    branch: BRANCH,
  },
  ttlSeconds = 120,
): LocalSessionBinding {
  return createLocalSessionBinding({
    sessionId,
    repository: SESSION_REPOSITORY,
    task: { kind: "issue", number: ISSUE },
    capabilities: [claim as LocalSessionBinding["capabilities"][number]],
    ttlSeconds,
    runtimeAuthority: authority,
    runtimeKey: keyPair,
    now: NOW,
  });
}

function branchIntent(
  requestId: string,
  issue = ISSUE,
  repository: { repositoryHost: string; repositoryId: string; repositoryNameWithOwner?: string } = {
    repositoryHost: "github.com",
    repositoryId: REPOSITORY.repositoryId,
    repositoryNameWithOwner: REPOSITORY.repository,
  },
) {
  return {
    version: 1,
    requestId,
    repository,
    operation: "branch.advance",
    request: {
      version: 1,
      issue,
      branch: issue === ISSUE ? BRANCH : `feat/${issue}-local-admission`,
      expectedHead: HEAD_SHA,
      changes: [{ operation: "upsert", path: "src/example.ts", mode: "100644", content: "eA==" }],
      commit: { message: "Update the implementation" },
    },
  };
}

async function closeServer(
  server: ReturnType<typeof createLocalExecutorHttpServer> | ReturnType<typeof createLocalAdmissionHttpServer>,
) {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test("Admission setup is idempotent and Admission serve requires setup and verifies the pinned Executor", async () => {
  const { root, environment } = await temporaryEnvironment();
  const { keyPair, authority } = authorityFixture();
  const executor = createLocalExecutorHttpServer({
    config: {
      version: 1,
      id: EXECUTOR_ID,
      listen: { host: "127.0.0.1", port: 8765 },
      provider: { kind: "github", credentialProfile: "default" },
    },
    listenPort: 0,
    version: "0.14.1",
    executorId: EXECUTOR_ID,
    execute: async () => ({ version: 1, status: "succeeded" }),
    readEvidence: async () => ({}),
  });
  await once(executor, "listening");
  const address = executor.address();
  assert.ok(address !== null && typeof address !== "string");
  const executorAnnouncement = publishLocalRuntimeEndpoint("executor", EXECUTOR_ID, address.port, environment);
  try {
    const executorConfig: LocalExecutorConfig = {
      version: 1,
      id: EXECUTOR_ID,
      listen: { host: "127.0.0.1", port: address.port },
      provider: { kind: "github", credentialProfile: "default" },
    };
    writeLocalJson("executor", "config.json", executorConfig, validateLocalExecutorConfig, environment);
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
    const first = setupLocalAdmission(authority, environment);
    const second = setupLocalAdmission(authority, environment);
    assert.deepEqual(second, first);
    const configOnDisk = JSON.parse(await readFile(first.configPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(configOnDisk).sort(), ["executor", "id", "listen", "version"]);
    assert.equal(JSON.stringify(configOnDisk).includes("privateKey"), false);

    await assert.rejects(
      startConfiguredLocalAdmission("0.14.1", { INARI_CONFIG_HOME: path.join(root, "missing") }),
      (error: unknown) => error instanceof LocalAdmissionError && error.code === "ADMISSION_NOT_SETUP",
    );

    const started = await startConfiguredLocalAdmission("0.14.1", environment);
    try {
      const address = started.server.address();
      assert.ok(address !== null && typeof address !== "string");
      const health = await fetch(`http://127.0.0.1:${address.port}${LOCAL_ADMISSION_HEALTH_PATH}`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), {
        ok: true,
        version: "0.14.1",
        component: "admission",
        admissionId: started.config.id,
        protocol: 1,
        readiness: "ready",
      });
    } finally {
      await closeServer(started.server);
    }
  } finally {
    clearLocalRuntimeEndpoint(executorAnnouncement, environment);
    await closeServer(executor);
    await rm(root, { recursive: true, force: true });
  }
});

test("Admission rejects wrong Executor identity before opening its ready server", async () => {
  const { root, environment } = await temporaryEnvironment();
  const { keyPair, authority } = authorityFixture();
  const wrong = createLocalExecutorHttpServer({
    config: {
      version: 1,
      id: EXECUTOR_ID,
      listen: { host: "127.0.0.1", port: 8765 },
      provider: { kind: "github", credentialProfile: "default" },
    },
    listenPort: 0,
    version: "0.14.1",
    executorId: "exec_fedcba9876543210",
    execute: async () => ({ version: 1, status: "succeeded" }),
  });
  await once(wrong, "listening");
  const address = wrong.address();
  assert.ok(address !== null && typeof address !== "string");
  const executorAnnouncement = publishLocalRuntimeEndpoint("executor", EXECUTOR_ID, address.port, environment);
  try {
    writeLocalJson(
      "executor",
      "config.json",
      {
        version: 1,
        id: EXECUTOR_ID,
        listen: { host: "127.0.0.1", port: address.port },
        provider: { kind: "github", credentialProfile: "default" },
      },
      validateLocalExecutorConfig,
      environment,
    );
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
    setupLocalAdmission(authority, environment);
    await assert.rejects(
      startConfiguredLocalAdmission("0.14.1", environment),
      (error: unknown) => error instanceof LocalAdmissionError && error.code === "EXECUTOR_NOT_READY",
    );
  } finally {
    clearLocalRuntimeEndpoint(executorAnnouncement, environment);
    await closeServer(wrong);
    await rm(root, { recursive: true, force: true });
  }
});

test("Admission maps active Session, derives bounded branch authorization, and never dispatches denials", async () => {
  const { root, environment } = await temporaryEnvironment();
  const { keyPair, authority } = authorityFixture();
  let now = NOW;
  let wrongRepository = false;
  let executorCalls = 0;
  let currentExecution: Record<string, unknown> | undefined;
  const executorConfig: LocalExecutorConfig = {
    version: 1,
    id: EXECUTOR_ID,
    listen: { host: "127.0.0.1", port: 8765 },
    provider: { kind: "github", credentialProfile: "default" },
  };
  const executorOptions: LocalExecutorHttpServerOptions = {
    config: executorConfig,
    listenPort: 0,
    version: "0.14.1",
    executorId: EXECUTOR_ID,
    execute: async (execution) => {
      executorCalls += 1;
      currentExecution = execution as unknown as Record<string, unknown>;
      return { version: 1, operation: execution.operation, status: "succeeded" };
    },
    readEvidence: async (request) => {
      const repository = wrongRepository
        ? { repositoryHost: "github.com", repositoryId: "123456788", nameWithOwner: REPOSITORY.repository }
        : { repositoryHost: "github.com", repositoryId: REPOSITORY.repositoryId, nameWithOwner: REPOSITORY.repository };
      const base = {
        repository,
        authority: { ref: AUTHORITY_REF, sha: BASE_SHA },
        runtimeAuthority: authority,
      };
      if (request.issue === undefined) return base;
      return {
        ...base,
        change: changeProjection(),
        implementation: implementationEvidence(),
      };
    },
  };
  const executor = createLocalExecutorHttpServer(executorOptions);
  await once(executor, "listening");
  const executorAddress = executor.address();
  assert.ok(executorAddress !== null && typeof executorAddress !== "string");
  const executorEndpoint = `http://127.0.0.1:${executorAddress.port}`;
  const executorConfigOnDisk: LocalExecutorConfig = {
    ...executorConfig,
    listen: { host: "127.0.0.1", port: executorAddress.port },
  };
  const admissionConfig: LocalAdmissionConfig = {
    version: 1,
    id: ADMISSION_ID,
    listen: { host: "127.0.0.1", port: 0 },
    executor: { id: EXECUTOR_ID, endpoint: executorEndpoint },
  };
  const client = new LocalExecutorClient({ id: EXECUTOR_ID, endpoint: executorEndpoint });
  const admission = createLocalAdmissionHttpServer(admissionConfig, "0.14.1", authority, client, {
    environment,
    now: () => now,
  });
  await once(admission, "listening");
  const admissionAddress = admission.address();
  assert.ok(admissionAddress !== null && typeof admissionAddress !== "string");
  const endpoint = `http://127.0.0.1:${admissionAddress.port}`;
  const original = bindingFixture(keyPair, authority, "session-active");
  const unsupported = bindingFixture(keyPair, authority, "session-wrong-capability", {
    kind: "change.ready",
    issue: ISSUE,
  });
  const expired = bindingFixture(keyPair, authority, "session-expired", undefined, 60);
  async function createSession(binding: LocalSessionBinding): Promise<void> {
    const response = await fetch(`${endpoint}${LOCAL_ADMISSION_SESSIONS_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: LOCAL_SESSION_BINDING_VERSION, binding }),
    });
    assert.equal(response.status, 201, JSON.stringify(await response.json()));
  }
  async function execute(body: unknown, sessionId?: string): Promise<Response> {
    const headers = new Headers({ "content-type": "application/json" });
    if (sessionId !== undefined) headers.set(LOCAL_ADMISSION_SESSION_ID_HEADER, sessionId);
    return fetch(`${endpoint}${LOCAL_ADMISSION_EXECUTIONS_PATH}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  async function executeRaw(body: string, sessionId?: string): Promise<Response> {
    const headers = new Headers({ "content-type": "application/json" });
    if (sessionId !== undefined) headers.set(LOCAL_ADMISSION_SESSION_ID_HEADER, sessionId);
    return fetch(`${endpoint}${LOCAL_ADMISSION_EXECUTIONS_PATH}`, { method: "POST", headers, body });
  }

  try {
    await createSession(original);
    await createSession(unsupported);
    const valid = await execute(branchIntent("request-valid"), original.sessionId);
    assert.equal(valid.status, 200);
    assert.equal(executorCalls, 1);
    assert.equal(currentExecution?.operation, "branch.advance");
    assert.equal(
      (currentExecution?.provenance as { readonly request: { readonly requestId: string } }).request.requestId,
      "request-valid",
    );
    const branchAuthorization = currentExecution?.branchAuthorization as {
      readonly implementation: { readonly number: number; readonly governedBodyDigest: string };
      readonly paths: readonly { readonly path: string; readonly operations: readonly string[] }[];
    };
    assert.equal(branchAuthorization.implementation.number, ISSUE);
    assert.match(branchAuthorization.implementation.governedBodyDigest, /^[a-f0-9]{64}$/u);
    assert.deepEqual(branchAuthorization.paths, [{ path: "src/example.ts", operations: ["CREATE", "WRITE"] }]);

    const readyBinding = bindingFixture(keyPair, authority, "session-local-admission-execution", {
      kind: "change.ready",
      issue: ISSUE,
    });
    await createSession(readyBinding);
    const ready = await execute(
      {
        version: 1,
        requestId: "request-local-admission-execution",
        repository: {
          repositoryHost: "github.com",
          repositoryId: REPOSITORY.repositoryId,
          repositoryNameWithOwner: REPOSITORY.repository,
        },
        operation: "change.ready",
        request: { version: 1, operation: "ready", issue: ISSUE },
      },
      readyBinding.sessionId,
    );
    assert.equal(ready.status, 200);
    assert.equal(currentExecution?.operation, "change.ready");
    const trustedExecution = currentExecution?.execution as {
      readonly runtime: string;
      readonly event: string;
      readonly sessionBindingSignature: string;
      readonly certificateJti?: string;
    };
    assert.equal(trustedExecution.runtime, "inari-local-admission");
    assert.equal(trustedExecution.event, "authorized-session-execution");
    assert.equal(trustedExecution.sessionBindingSignature, readyBinding.signature);
    assert.equal("certificateJti" in trustedExecution, false);
    assert.equal(executorCalls, 2);

    for (const denied of [
      await execute(branchIntent("request-missing-session"), "missing-session"),
      await execute({ ...branchIntent("request-unknown"), extra: true }, original.sessionId),
      await execute({ ...branchIntent("request-body-session"), sessionId: original.sessionId }, original.sessionId),
      await execute({ ...branchIntent("request-unsupported-version"), version: 2 }, original.sessionId),
      await execute(branchIntent("request-task-mismatch", ISSUE + 1), original.sessionId),
      await execute(branchIntent("request-capability-mismatch"), unsupported.sessionId),
      await execute(branchIntent(""), original.sessionId),
      await execute(
        branchIntent("request-repository-mismatch", ISSUE, {
          repositoryHost: "github.com",
          repositoryId: "123456788",
          repositoryNameWithOwner: REPOSITORY.repository,
        }),
        original.sessionId,
      ),
    ]) {
      assert.ok(denied.status === 400 || denied.status === 403);
    }
    assert.equal(executorCalls, 2);
    assert.equal((await execute(branchIntent("request-no-selector"))).status, 400);
    assert.equal((await execute(branchIntent("request-malformed-selector"), "bad selector")).status, 400);
    assert.equal((await executeRaw("{", original.sessionId)).status, 400);
    assert.equal((await executeRaw(" ".repeat(MAX_LOCAL_ADMISSION_BODY_BYTES + 1), original.sessionId)).status, 413);
    assert.equal(executorCalls, 2);

    wrongRepository = true;
    const repoMismatch = await execute(branchIntent("request-current-repository-mismatch"), original.sessionId);
    assert.equal(repoMismatch.status, 403);
    wrongRepository = false;
    assert.equal(executorCalls, 2);

    const close = await fetch(`${endpoint}${LOCAL_ADMISSION_SESSIONS_PATH}/${original.sessionId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, binding: original }),
    });
    assert.equal(close.status, 200);
    const persisted = JSON.parse(
      await readFile(localComponentPath("admission", `sessions/${original.sessionId}.json`, environment), "utf8"),
    ) as { readonly state: string };
    assert.equal(persisted.state, "closed");
    assert.equal((await execute(branchIntent("request-closed"), original.sessionId)).status, 403);

    await createSession(expired);
    now = new Date(NOW.getTime() + 61_000);
    assert.equal((await execute(branchIntent("request-expired"), expired.sessionId)).status, 403);
    assert.equal(executorCalls, 2);
  } finally {
    await closeServer(admission);
    await closeServer(executor);
    await rm(root, { recursive: true, force: true });
  }
});
