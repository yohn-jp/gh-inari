import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createSessionCredentialBundle,
  persistSessionCredentialBundle,
  type SessionIssuanceRequestDocument,
} from "./session-bundle.js";
import { assertRuntimeAuthority, type RuntimeAuthority } from "./runtime-authority.js";
import { generateRuntimeAuthorityKeyPair, type RuntimeAuthorityKeyPair } from "./runtime-key.js";
import { MAX_SESSION_REQUEST_BYTES } from "./session-request.js";
import {
  BranchAdvanceClientError,
  DirectAppClientError,
  createDirectAppChangeRemoteExecutor,
  loadDirectAppSession,
  resolveAppEndpoint,
  sendDirectAppBranchAdvance,
} from "./direct-app-client.js";
import { ChangeRemoteExecutorError } from "../change-executor.js";
import { createChangeProvenanceRecord } from "../change-provenance-record.js";
import { projectChangeFromGitHubEvidence, type ChangeProjectionResult } from "../change.js";
import type { BranchAdvanceSemanticRequest } from "./branch-advance.js";

const REPOSITORY = Object.freeze({ id: "123456789", name: "yohn-jp/gh-inari" });
const NOW = new Date("2026-09-12T12:00:00Z");
const BRANCH = "feat/467-cli-app-transport";

function authority(runtimeKey: RuntimeAuthorityKeyPair): RuntimeAuthority {
  return assertRuntimeAuthority({
    version: 1,
    kind: "runtime-authority",
    id: "test-runtime",
    key: runtimeKey.publicKeyJwk,
    status: "active",
    notBefore: "2020-01-01T00:00:00Z",
    notAfter: null,
    maxSessionTtlSeconds: 3600,
    capabilityCeiling: ["change.implement", "change.ready", "change.abort"],
  });
}

function requestDocument(runtimeKey: RuntimeAuthorityKeyPair): SessionIssuanceRequestDocument {
  return {
    version: 1,
    kind: "inari-session-issuance-request",
    runtimeAuthority: authority(runtimeKey),
    repository: REPOSITORY,
    task: { kind: "issue", number: 467 },
    capabilities: [{ kind: "change.implement", issue: 467 }],
    ttlSeconds: 1800,
  } as SessionIssuanceRequestDocument;
}

async function createBundleFile(dir: string): Promise<{ readonly path: string; readonly privateKeyPem: string }> {
  const runtimeKey = generateRuntimeAuthorityKeyPair();
  const created = createSessionCredentialBundle({ request: requestDocument(runtimeKey), runtimeKey, now: NOW });
  const filePath = path.join(dir, "bundle.json");
  persistSessionCredentialBundle(filePath, created.bundle);
  return { path: filePath, privateKeyPem: created.bundle.sessionPrivateKey };
}

function projection(): ChangeProjectionResult {
  const result = projectChangeFromGitHubEvidence({
    change: { repositoryHost: "github.com", repositoryId: REPOSITORY.id, rootIssue: 467 },
    branchGovernance: { pattern: "^feat/[0-9]+-[a-z0-9-]+$" },
    naming: { type: "feat", slug: "cli-app-transport" },
    baseBranch: "main",
    evidence: {
      issue: { status: "available", value: { number: 467, state: "open" } },
      branches: { status: "available", value: [{ name: BRANCH, sha: "a".repeat(40) }] },
      pullRequests: {
        status: "available",
        value: [{ number: 900, head: BRANCH, base: "main", state: "open", draft: true, merged: false }],
      },
    },
  });
  assert.equal(result.valid, true);
  return result;
}

function fakeFetch(handler: (url: URL, body: unknown) => { status: number; body: unknown }): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const body: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    const { status, body: responseBody } = handler(url, body);
    return new Response(JSON.stringify(responseBody), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("loads a valid Session credential bundle and signs a request with it", async () => {
  const dir = await mkdtemp(path.join(process.cwd(), ".direct-app-client-test-"));
  try {
    const { path: bundlePath, privateKeyPem } = await createBundleFile(dir);
    const { session } = loadDirectAppSession(bundlePath);
    assert.equal(typeof session.sessionId, "string");

    let sentBody: unknown;
    const fetchImpl = fakeFetch((url, body) => {
      sentBody = body;
      assert.equal(url.pathname, "/v1/execute");
      return {
        status: 200,
        body: {
          version: 1,
          ok: true,
          operation: "change.show",
          requestId: "r1",
          result: { version: 1, status: "succeeded", projection: projection() },
        },
      };
    });
    const executor = createDirectAppChangeRemoteExecutor({
      endpoint: new URL("https://app.example.com"),
      session,
      fetchImpl,
    });
    const result = await executor.read({ version: 1, issue: 467, operation: "show" });
    assert.equal(result.valid, true);

    const serialized = JSON.stringify(sentBody);
    assert.ok(!serialized.includes(privateKeyPem));
    assert.ok(!serialized.includes("PRIVATE KEY"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing Session credential file fails closed without a network call", () => {
  assert.throws(
    () => loadDirectAppSession("/nonexistent/bundle.json"),
    (error: unknown) => error instanceof DirectAppClientError && error.code === "SESSION_CREDENTIAL_INVALID",
  );
});

test("invalid Session credential bundle content fails closed", async () => {
  const dir = await mkdtemp(path.join(process.cwd(), ".direct-app-client-test-"));
  try {
    const filePath = path.join(dir, "bundle.json");
    await writeFile(filePath, JSON.stringify({ not: "a bundle" }));
    assert.throws(
      () => loadDirectAppSession(filePath),
      (error: unknown) => error instanceof DirectAppClientError && error.code === "SESSION_CREDENTIAL_INVALID",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects a non-HTTPS, non-localhost App endpoint before any network send", () => {
  assert.throws(
    () => resolveAppEndpoint("http://example.com"),
    (error: unknown) => error instanceof DirectAppClientError && error.code === "APP_ENDPOINT_INVALID",
  );
  assert.throws(
    () => resolveAppEndpoint("not a url"),
    (error: unknown) => error instanceof DirectAppClientError && error.code === "APP_ENDPOINT_INVALID",
  );
});

test("accepts HTTPS and an explicit localhost development fixture", () => {
  assert.equal(resolveAppEndpoint("https://app.example.com").protocol, "https:");
  assert.equal(resolveAppEndpoint("http://localhost:8787").protocol, "http:");
  assert.equal(resolveAppEndpoint("http://127.0.0.1:8787").protocol, "http:");
});

test("rejects a signed semantic request exceeding the 64 KiB bound before network send", async () => {
  const dir = await mkdtemp(path.join(process.cwd(), ".direct-app-client-test-"));
  try {
    const { path: bundlePath } = await createBundleFile(dir);
    const { session } = loadDirectAppSession(bundlePath);
    let called = false;
    const fetchImpl = fakeFetch(() => {
      called = true;
      return { status: 200, body: { ok: false, error: { code: "X", message: "unreachable" } } };
    });
    const executor = createDirectAppChangeRemoteExecutor({
      endpoint: new URL("https://app.example.com"),
      session,
      fetchImpl,
    });
    await assert.rejects(
      executor.execute({
        version: 1,
        issue: 467,
        operation: "issue",
        semanticPullRequestPlan: { padding: "x".repeat(MAX_SESSION_REQUEST_BYTES) },
      }),
      (error: unknown) => error instanceof DirectAppClientError && error.code === "APP_REQUEST_TOO_LARGE",
    );
    assert.equal(called, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("maps a bounded App transport failure onto ChangeRemoteExecutorError without leaking transport detail", async () => {
  const dir = await mkdtemp(path.join(process.cwd(), ".direct-app-client-test-"));
  try {
    const { path: bundlePath } = await createBundleFile(dir);
    const { session } = loadDirectAppSession(bundlePath);
    const fetchImpl = fakeFetch(() => ({
      status: 403,
      body: {
        version: 1,
        ok: false,
        error: { code: "SESSION_AUTHORIZATION_DENIED", message: "Session is not authorized for change.ready." },
      },
    }));
    const executor = createDirectAppChangeRemoteExecutor({
      endpoint: new URL("https://app.example.com"),
      session,
      fetchImpl,
    });
    await assert.rejects(
      executor.execute({ version: 1, issue: 467, operation: "ready" }),
      (error: unknown) => error instanceof ChangeRemoteExecutorError && error.code === "CHANGE_REMOTE_RUN_FAILED",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("carries caller-produced signed provenance through the direct-App request", async () => {
  const dir = await mkdtemp(path.join(process.cwd(), ".direct-app-client-test-"));
  try {
    const { path: bundlePath } = await createBundleFile(dir);
    const { session } = loadDirectAppSession(bundlePath);
    const runtimeKey = generateRuntimeAuthorityKeyPair();
    const signedProvenanceRecord = createChangeProvenanceRecord({
      rootIssue: 467,
      runtimeAuthority: authority(runtimeKey),
      runtimeKey,
      now: NOW,
    });
    let sentRequest: unknown;
    const fetchImpl = fakeFetch((_url, body) => {
      sentRequest = (body as { request: unknown }).request;
      return {
        status: 200,
        body: {
          version: 1,
          ok: true,
          operation: "change.issue",
          requestId: "r1",
          result: {
            version: 1,
            status: "succeeded",
            execution: { projection: projection() },
          },
        },
      };
    });
    const executor = createDirectAppChangeRemoteExecutor({
      endpoint: new URL("https://app.example.com"),
      session,
      fetchImpl,
    });
    await executor.execute({
      version: 1,
      issue: 467,
      operation: "issue",
      signedProvenanceRecord,
    });
    assert.deepEqual(
      (sentRequest as { signedProvenanceRecord: unknown }).signedProvenanceRecord,
      signedProvenanceRecord,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("compiles and sends the exact canonical branch.advance request for change publish", async () => {
  const dir = await mkdtemp(path.join(process.cwd(), ".direct-app-client-test-"));
  try {
    const { path: bundlePath } = await createBundleFile(dir);
    const { session } = loadDirectAppSession(bundlePath);
    const request: BranchAdvanceSemanticRequest = {
      version: 1,
      issue: 467,
      branch: BRANCH,
      expectedHead: "a".repeat(40),
      changes: [
        { operation: "upsert", path: "src/added.ts", mode: "100644", content: Buffer.from("x").toString("base64") },
      ],
      commit: { message: "implement feature" },
    };
    let sentRequest: unknown;
    const fetchImpl = fakeFetch((_url, body) => {
      sentRequest = (body as { request: unknown }).request;
      return {
        status: 200,
        body: {
          version: 1,
          ok: true,
          operation: "branch.advance",
          requestId: "r1",
          result: {
            version: 1,
            status: "succeeded",
            branchAdvance: {
              version: 1,
              operation: "branch.advance",
              status: "succeeded",
              outcome: "advanced",
              branch: BRANCH,
              expectedHead: request.expectedHead,
              resultingHead: "b".repeat(40),
            },
          },
        },
      };
    });
    const result = await sendDirectAppBranchAdvance({
      endpoint: new URL("https://app.example.com"),
      session,
      request,
      fetchImpl,
    });
    assert.equal(result.status, "succeeded");
    assert.equal(result.resultingHead, "b".repeat(40));
    assert.deepEqual(sentRequest, request);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("branch.advance rejection surfaces as a BranchAdvanceClientError", async () => {
  const dir = await mkdtemp(path.join(process.cwd(), ".direct-app-client-test-"));
  try {
    const { path: bundlePath } = await createBundleFile(dir);
    const { session } = loadDirectAppSession(bundlePath);
    const request: BranchAdvanceSemanticRequest = {
      version: 1,
      issue: 467,
      branch: BRANCH,
      expectedHead: "a".repeat(40),
      changes: [{ operation: "delete", path: "src/old.ts" }],
      commit: { message: "remove file" },
    };
    const fetchImpl = fakeFetch(() => ({
      status: 409,
      body: { version: 1, ok: false, error: { code: "SESSION_STATE_CONFLICT", message: "expectedHead is stale." } },
    }));
    await assert.rejects(
      sendDirectAppBranchAdvance({ endpoint: new URL("https://app.example.com"), session, request, fetchImpl }),
      (error: unknown) => error instanceof BranchAdvanceClientError && error.code === "BRANCH_ADVANCE_REJECTED",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
