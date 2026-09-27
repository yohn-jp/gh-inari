import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createDelegatorRecord } from "../agent-authority/delegator-operations.js";
import { generateDelegatorKeyPair } from "../agent-authority/delegator-key.js";
import { projectChangeFromGitHubEvidence } from "../change.js";
import { renderImplementationIssueBody } from "../implementation-contract.js";
import type { LocalAdmissionConfig } from "../local-control/config.js";
import type { LocalExecutorEvidenceRequest } from "../local-control/executor-http.js";
import { createLocalSessionBinding } from "../local-control/session-binding.js";
import {
  createLocalAdmissionHttpServer,
  LOCAL_ADMISSION_EXECUTIONS_PATH,
  LOCAL_ADMISSION_HEALTH_PATH,
  LOCAL_ADMISSION_PULL_REQUEST_CONTEXT_PATH,
  LOCAL_ADMISSION_SESSION_ID_HEADER,
  type AdmissionExecutorClient,
} from "./server.js";
import { admitSession } from "./authorization.js";
import { LocalAdmissionError } from "./setup.js";

const EXECUTOR_ID = "exec_0123456789abcdef";
const ADMISSION_ID = "adm_0123456789abcdef";
const REPOSITORY_ID = "123456789";
const REPOSITORY_NAME = "acme/inari";
const IMPLEMENTATION = 375;
const NOW = new Date("2026-09-01T12:00:00.000Z");

async function captureStderr<T>(run: () => Promise<T>): Promise<{ readonly value: T; readonly output: string }> {
  const originalWrite = process.stderr.write;
  let output = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: await run(), output };
  } finally {
    process.stderr.write = originalWrite;
  }
}

function authority() {
  return createDelegatorRecord({
    id: "runtime-admission-server-test",
    key: generateDelegatorKeyPair(),
    notBefore: new Date("2026-08-01T00:00:00.000Z"),
    maxSessionTtlSeconds: 3_600,
    capabilityCeiling: ["change.implement"],
  });
}

function config(host: "127.0.0.1" | "0.0.0.0"): LocalAdmissionConfig {
  return { version: 1, id: ADMISSION_ID, listen: { host, port: 0 }, executor: { id: EXECUTOR_ID } };
}

function executor(calls: string[]): AdmissionExecutorClient {
  return {
    verifyReady: async () => {
      calls.push("verifyReady");
      return {};
    },
    readEvidence: async () => {
      calls.push("readEvidence");
      return {};
    },
    execute: async () => {
      calls.push("execute");
      return {};
    },
  };
}

test("non-loopback Admission requires the pinned Executor mTLS identity and loopback refuses one", () => {
  const transport = {
    certificate: Buffer.from("certificate"),
    privateKey: Buffer.from("private key"),
    caCertificate: Buffer.from("CA"),
    peerId: EXECUTOR_ID,
    peerRole: "executor" as const,
  };
  const denied = (error: unknown) =>
    error instanceof LocalAdmissionError && error.code === "LOCAL_TRANSPORT_MTLS_CONFIGURATION_INVALID";
  assert.throws(() => createLocalAdmissionHttpServer(config("0.0.0.0"), "1", authority(), executor([])), denied);
  assert.throws(
    () => createLocalAdmissionHttpServer(config("127.0.0.1"), "1", authority(), executor([]), { transport }),
    denied,
  );
  assert.throws(
    () =>
      createLocalAdmissionHttpServer(config("0.0.0.0"), "1", authority(), executor([]), {
        transport: { ...transport, peerId: "exec_fedcba9876543210" },
      }),
    denied,
  );
  assert.throws(
    () =>
      createLocalAdmissionHttpServer(config("0.0.0.0"), "1", authority(), executor([]), {
        transport: { ...transport, peerRole: "admission" as unknown as "executor" },
      }),
    denied,
  );
});

test("the Admission server never dispatches a denied execution to the Executor", async () => {
  const calls: string[] = [];
  const server = createLocalAdmissionHttpServer(config("127.0.0.1"), "1", authority(), executor(calls), {
    environment: { INARI_CONFIG_HOME: "/nonexistent/inari-admission-server-test" },
  });
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const health = await fetch(`${base}${LOCAL_ADMISSION_HEALTH_PATH}`);
    assert.equal(health.status, 200);
    assert.equal(((await health.json()) as { admissionId: string }).admissionId, ADMISSION_ID);

    const denied = await fetch(`${base}${LOCAL_ADMISSION_EXECUTIONS_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", [LOCAL_ADMISSION_SESSION_ID_HEADER]: "session-unknown" },
      body: JSON.stringify({
        version: 1,
        requestId: "request-unknown-session",
        repository: { repositoryHost: "github.com", repositoryId: "123456789" },
        operation: "change.show",
        request: { version: 1, issue: 375 },
      }),
    });
    const body = (await denied.json()) as { ok: boolean; error?: { code: string } };
    assert.ok(denied.status === 400 || denied.status === 403, String(denied.status));
    assert.equal(body.ok, false);
    assert.equal(calls.includes("execute"), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("PR context checks current task termination before reading the governed contract", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "inari-admission-pr-context-"));
  const environment = { INARI_CONFIG_HOME: path.join(root, "config") };
  const key = generateDelegatorKeyPair();
  const runtimeAuthority = createDelegatorRecord({
    id: "runtime-admission-pr-context-test",
    key,
    notBefore: new Date("2026-08-01T00:00:00.000Z"),
    maxSessionTtlSeconds: 3_600,
    capabilityCeiling: ["change.implement"],
  });
  const session = createLocalSessionBinding({
    sessionId: "session-pr-context-termination",
    repository: { id: REPOSITORY_ID, name: REPOSITORY_NAME },
    task: { kind: "issue", number: IMPLEMENTATION },
    capabilities: [{ kind: "change.implement", issue: IMPLEMENTATION }],
    ttlSeconds: 120,
    runtimeAuthority,
    runtimeKey: key,
    now: NOW,
  });
  let taskTermination: unknown = {
    status: "absent",
    provenance: { source: "repository", revision: "snapshot-1" },
    recordProvenance: [],
  };
  let governedContractReads = 0;
  const readEvidence = async (request: LocalExecutorEvidenceRequest): Promise<unknown> => {
    if (request.issue === undefined || request.implementationIssue === undefined)
      return {
        repository: { repositoryHost: "github.com", repositoryId: REPOSITORY_ID, nameWithOwner: REPOSITORY_NAME },
        authority: { ref: "refs/heads/main", sha: "a".repeat(40) },
        runtimeAuthority,
      };
    const evidence = implementationEvidence(runtimeAuthority, request.implementationIssue, request.issue);
    return request.taskTerminationAuthorization === undefined ? evidence : { ...evidence, taskTermination };
  };
  const executor: AdmissionExecutorClient = {
    verifyReady: async () => ({}),
    readEvidence,
    readGovernedContract: async () => {
      governedContractReads += 1;
      return { template: "default" };
    },
    execute: async () => ({}),
  };
  let server: ReturnType<typeof createLocalAdmissionHttpServer> | undefined;
  try {
    await admitSession(session, {
      runtimeAuthority,
      environment,
      now: () => NOW,
      readEvidence,
    });
    taskTermination = {
      status: "present",
      provenance: { source: "repository", revision: "snapshot-2" },
      recordProvenance: [{ path: "state/task-termination.json" }],
      record: { version: 1, kind: "implementation-task-termination" },
    };
    server = createLocalAdmissionHttpServer(config("127.0.0.1"), "1", runtimeAuthority, executor, {
      environment,
      now: () => NOW,
    });
    await once(server, "listening");
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}${LOCAL_ADMISSION_PULL_REQUEST_CONTEXT_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [LOCAL_ADMISSION_SESSION_ID_HEADER]: session.sessionId,
      },
      body: JSON.stringify({
        version: 1,
        repository: { id: REPOSITORY_ID, name: REPOSITORY_NAME },
        domain: "pr",
        template: "default",
      }),
    });
    assert.equal(response.status, 403);
    assert.equal(governedContractReads, 0);
  } finally {
    if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

function implementationEvidence(authority: unknown, implementation: number, issue: number): Record<string, unknown> {
  const repository = { repositoryHost: "github.com", repositoryId: REPOSITORY_ID, repository: REPOSITORY_NAME };
  const reference = { ...repository, number: implementation };
  const body = renderImplementationIssueBody({
    version: 1,
    kind: "implementation",
    repository,
    sources: [{ ...repository, number: issue + 1 }],
    objective: "Admit the exact Implementation task under current evidence.",
    nonGoals: ["Source authority inference."],
    architecture: {
      decision: "Task evidence is current.",
      affectedComponents: ["Admission"],
      invariants: ["Termination is checked for every task operation."],
      compatibilityConstraints: [],
    },
    scope: { readOnly: ["src/**"], write: ["src/**"], create: [], delete: [], deny: [] },
    constraints: { prohibitedOperations: [], immutableAreas: [], prerequisites: [] },
    verification: {
      acceptanceCriteria: ["Terminated task is denied."],
      targetedTests: [],
      requiredChecks: [],
      postconditions: [],
    },
    execution: {
      baseBranch: "main",
      baseRevision: "b".repeat(40),
      baseFreshness: "b".repeat(40),
      branch: "feat/375-pr-context",
      dependencies: [],
    },
  });
  const projection = (rootIssue: number) => {
    const result = projectChangeFromGitHubEvidence({
      change: { repositoryHost: "github.com", repositoryId: REPOSITORY_ID, rootIssue },
      branchGovernance: { pattern: "^feat/[0-9]+-[a-z0-9-]+$" },
      naming: { type: "feat", slug: "pr-context" },
      baseBranch: "main",
      evidence: {
        issue: { status: "available", value: { number: rootIssue, state: "open" } },
        branches: { status: "available", value: [] },
        pullRequests: { status: "available", value: [] },
      },
    });
    assert.equal(result.valid, true);
    return result;
  };
  return {
    repository: { repositoryHost: "github.com", repositoryId: REPOSITORY_ID, nameWithOwner: REPOSITORY_NAME },
    authority: { ref: "refs/heads/main", sha: "a".repeat(40) },
    runtimeAuthority: authority,
    change: projection(issue),
    implementation: {
      implementation: reference,
      issue: { reference, body },
      repository,
      base: { branch: "main", revision: "b".repeat(40), freshness: "b".repeat(40) },
      readiness: { evidence: [] },
      change: projection(implementation),
    },
  };
}

test("Admission request logs redact Session route IDs and raw request bodies", async () => {
  const server = createLocalAdmissionHttpServer(config("127.0.0.1"), "1", authority(), executor([]), {
    environment: { INARI_CONFIG_HOME: "/nonexistent/inari-admission-log-test" },
  });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const sessionId = "session-route-secret-value";
  const bodySecret = "provider-payload-secret-value";
  try {
    const { value: response, output } = await captureStderr(() =>
      fetch(`http://127.0.0.1:${address.port}/v1/sessions/${sessionId}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 1, binding: { token: bodySecret, signature: bodySecret } }),
      }),
    );
    assert.ok(response.status === 400 || response.status === 403, String(response.status));
    const events = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.event, "request.received");
    assert.equal(events[0]?.route, "/v1/sessions/:id");
    assert.equal(events[1]?.event, "request.completed");
    assert.equal(events[1]?.route, "/v1/sessions/:id");
    assert.equal(events[1]?.status, response.status);
    assert.equal(events[1]?.elapsedMs !== undefined, true);
    assert.doesNotMatch(output, /session-route-secret-value|provider-payload-secret-value/u);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
