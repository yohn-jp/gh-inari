import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDirectAppHttpHandler,
  DIRECT_APP_EXECUTE_PATH,
  DIRECT_APP_HTTP_CONTRACT_VERSION,
  type DirectAppHttpFailureEnvelope,
  type DirectAppHttpSuccessEnvelope,
} from "./direct-app-http.js";
import type {
  CapabilityAuthorizedSessionExecutionResult,
  CapabilityAuthorizedSessionExecutor,
  CapabilityAuthorizedSessionOperation,
  SessionExecutionPhase,
} from "../session-authorized-change-executor.js";
import type { CapabilityExecutionProvenance } from "./capability-provenance.js";
import type { ChangeDiagnostic } from "../change.js";

const ENDPOINT_URL = `https://app.example${DIRECT_APP_EXECUTE_PATH}`;
const REPOSITORY = Object.freeze({ repositoryHost: "github.com", repositoryId: "1", nameWithOwner: "acme/inari" });

function provenance(
  operation: CapabilityAuthorizedSessionOperation,
  requestId = "req-1",
): CapabilityExecutionProvenance {
  return Object.freeze({
    version: 1,
    stage: "verified",
    repository: REPOSITORY,
    runtimeAuthority: Object.freeze({ id: "runtime-1", kid: "kid-1" }),
    session: Object.freeze({ id: "session-1", certificateJti: "jti-1" }),
    authority: Object.freeze({ ref: "refs/heads/main", sha: "a".repeat(40) }),
    request: Object.freeze({ requestId, operation, issuedAt: 1, expiresAt: 2 }),
    subject: Object.freeze({ kind: "change", issue: 465 }),
  }) as CapabilityExecutionProvenance;
}

function succeeded(operation: CapabilityAuthorizedSessionOperation): CapabilityAuthorizedSessionExecutionResult {
  return Object.freeze({
    version: 1,
    operation,
    status: "succeeded",
    provenance: provenance(operation),
  }) as CapabilityAuthorizedSessionExecutionResult;
}

function failed(
  phase: SessionExecutionPhase,
  operation?: CapabilityAuthorizedSessionOperation,
  diagnostics?: readonly ChangeDiagnostic[],
): CapabilityAuthorizedSessionExecutionResult {
  return Object.freeze({
    version: 1,
    ...(operation === undefined ? {} : { operation }),
    status: "failed",
    ...(operation === undefined ? {} : { provenance: provenance(operation) }),
    failure: Object.freeze({
      code: "SESSION_EXECUTION_FAILED",
      phase,
      message: `${phase} failed closed.`,
      ...(diagnostics === undefined ? {} : { diagnostics }),
    }),
  }) as CapabilityAuthorizedSessionExecutionResult;
}

function fakeExecutor(
  run: (
    envelope: unknown,
  ) => Promise<CapabilityAuthorizedSessionExecutionResult> | CapabilityAuthorizedSessionExecutionResult,
): { readonly executor: CapabilityAuthorizedSessionExecutor; readonly calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    executor: {
      execute: async (envelope: unknown) => {
        calls.push(envelope);
        return run(envelope);
      },
    },
  };
}

function postRequest(body: unknown, init: RequestInit = {}): Request {
  return new Request(ENDPOINT_URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
    body: JSON.stringify(body),
    ...init,
  });
}

async function readEnvelope<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

test("createDirectAppHttpHandler rejects an invalid executor", () => {
  assert.throws(() => createDirectAppHttpHandler({ executor: {} as CapabilityAuthorizedSessionExecutor }), TypeError);
});

test("createDirectAppHttpHandler rejects an out-of-range maxBodyBytes", () => {
  const { executor } = fakeExecutor(() => succeeded("change.show"));
  assert.throws(() => createDirectAppHttpHandler({ executor, maxBodyBytes: 0 }), TypeError);
  assert.throws(() => createDirectAppHttpHandler({ executor, maxBodyBytes: 999_999_999 }), TypeError);
});

for (const operation of ["change.issue", "change.show", "change.ready", "change.abort", "branch.advance"] as const) {
  test(`routes ${operation} to the #465 executor and returns a bounded success envelope`, async () => {
    const { executor, calls } = fakeExecutor(() => succeeded(operation));
    const handler = createDirectAppHttpHandler({ executor });
    const response = await handler(postRequest({ certificate: "c", operation }));

    assert.equal(response.status, 200);
    const body = await readEnvelope<DirectAppHttpSuccessEnvelope>(response);
    assert.equal(body.version, DIRECT_APP_HTTP_CONTRACT_VERSION);
    assert.equal(body.ok, true);
    assert.equal(body.operation, operation);
    assert.equal(body.requestId, "req-1");
    assert.equal(body.result.status, "succeeded");
    assert.equal(calls.length, 1);
  });
}

const FAILURE_CASES: readonly {
  readonly phase: SessionExecutionPhase;
  readonly status: number;
  readonly code: string;
}[] = [
  { phase: "authentication", status: 401, code: "SESSION_AUTHENTICATION_FAILED" },
  { phase: "request", status: 400, code: "SESSION_REQUEST_INVALID" },
  { phase: "authorization", status: 403, code: "SESSION_AUTHORIZATION_DENIED" },
  { phase: "evidence", status: 500, code: "SESSION_EVIDENCE_UNAVAILABLE" },
  { phase: "execution", status: 500, code: "SESSION_EXECUTION_FAILED" },
  { phase: "conflict", status: 409, code: "SESSION_STATE_CONFLICT" },
  { phase: "verification", status: 500, code: "SESSION_VERIFICATION_FAILED" },
  { phase: "recovery-required", status: 409, code: "SESSION_RECOVERY_REQUIRED" },
];

for (const failureCase of FAILURE_CASES) {
  test(`maps #465 ${failureCase.phase} failures to HTTP ${failureCase.status}`, async () => {
    const { executor } = fakeExecutor(() => failed(failureCase.phase, "change.issue"));
    const handler = createDirectAppHttpHandler({ executor });
    const response = await handler(postRequest({ certificate: "c" }));

    assert.equal(response.status, failureCase.status);
    const body = await readEnvelope<DirectAppHttpFailureEnvelope>(response);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, failureCase.code);
    assert.equal(body.operation, "change.issue");
  });
}

test("preserves bounded diagnostics on execution failure", async () => {
  const diagnostics: readonly ChangeDiagnostic[] = [
    Object.freeze({ path: "$.issue", message: "Issue is invalid." }) as ChangeDiagnostic,
  ];
  const { executor } = fakeExecutor(() => failed("execution", "change.ready", diagnostics));
  const handler = createDirectAppHttpHandler({ executor });
  const response = await handler(postRequest({ certificate: "c" }));

  const body = await readEnvelope<DirectAppHttpFailureEnvelope>(response);
  assert.equal(response.status, 500);
  assert.deepEqual(body.error.diagnostics, diagnostics);
});

test("rejects a non-JSON media type with 415 before invoking the executor", async () => {
  const { executor, calls } = fakeExecutor(() => succeeded("change.show"));
  const handler = createDirectAppHttpHandler({ executor });
  const response = await handler(
    new Request(ENDPOINT_URL, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }),
  );

  assert.equal(response.status, 415);
  const body = await readEnvelope<DirectAppHttpFailureEnvelope>(response);
  assert.equal(body.error.code, "UNSUPPORTED_MEDIA_TYPE");
  assert.equal(calls.length, 0);
});

test("rejects malformed JSON with 400 before invoking the executor", async () => {
  const { executor, calls } = fakeExecutor(() => succeeded("change.show"));
  const handler = createDirectAppHttpHandler({ executor });
  const response = await handler(
    new Request(ENDPOINT_URL, { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" }),
  );

  assert.equal(response.status, 400);
  const body = await readEnvelope<DirectAppHttpFailureEnvelope>(response);
  assert.equal(body.error.code, "MALFORMED_JSON");
  assert.equal(calls.length, 0);
});

test("rejects an oversized body declared via Content-Length with 413 before invoking the executor", async () => {
  const { executor, calls } = fakeExecutor(() => succeeded("change.show"));
  const handler = createDirectAppHttpHandler({ executor, maxBodyBytes: 16 });
  const response = await handler(
    new Request(ENDPOINT_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "1000" },
      body: JSON.stringify({ certificate: "c".repeat(200) }),
    }),
  );

  assert.equal(response.status, 413);
  const body = await readEnvelope<DirectAppHttpFailureEnvelope>(response);
  assert.equal(body.error.code, "PAYLOAD_TOO_LARGE");
  assert.equal(calls.length, 0);
});

test("rejects an oversized streamed body with 413 even without a Content-Length header", async () => {
  const { executor, calls } = fakeExecutor(() => succeeded("change.show"));
  const handler = createDirectAppHttpHandler({ executor, maxBodyBytes: 16 });
  const oversized = JSON.stringify({ certificate: "c".repeat(200) });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(oversized));
      controller.close();
    },
  });
  const request = new Request(ENDPOINT_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  const response = await handler(request);
  assert.equal(response.status, 413);
  const body = await readEnvelope<DirectAppHttpFailureEnvelope>(response);
  assert.equal(body.error.code, "PAYLOAD_TOO_LARGE");
  assert.equal(calls.length, 0);
});

test("does not widen the #373 64 KiB semantic ceiling via the 1 MiB default HTTP ceiling", async () => {
  const { executor, calls } = fakeExecutor(() => succeeded("change.show"));
  const handler = createDirectAppHttpHandler({ executor });
  const oversizedSemanticBody = "a".repeat(200_000);
  const response = await handler(postRequest({ certificate: "c", issue: oversizedSemanticBody }));

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
});

test("returns 405 for a non-POST method", async () => {
  const { executor } = fakeExecutor(() => succeeded("change.show"));
  const handler = createDirectAppHttpHandler({ executor });
  const response = await handler(new Request(ENDPOINT_URL, { method: "GET" }));

  assert.equal(response.status, 405);
  const body = await readEnvelope<DirectAppHttpFailureEnvelope>(response);
  assert.equal(body.error.code, "METHOD_NOT_ALLOWED");
});

test("returns 404 for an unknown path", async () => {
  const { executor } = fakeExecutor(() => succeeded("change.show"));
  const handler = createDirectAppHttpHandler({ executor });
  const response = await handler(new Request("https://app.example/v1/other", { method: "POST" }));

  assert.equal(response.status, 404);
  const body = await readEnvelope<DirectAppHttpFailureEnvelope>(response);
  assert.equal(body.error.code, "NOT_FOUND");
});

test("host/path parameters cannot override the signed target repository", async () => {
  const { executor, calls } = fakeExecutor(() => succeeded("change.show"));
  const handler = createDirectAppHttpHandler({ executor });
  await handler(
    new Request(`${ENDPOINT_URL}?owner=other&repo=other`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ certificate: "c" }),
    }),
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { certificate: "c" });
});

test("maps an unexpected executor throw to a secret-safe 500", async () => {
  const { executor } = fakeExecutor(() => {
    throw new Error("provider leaked detail: token=abc123");
  });
  const handler = createDirectAppHttpHandler({ executor });
  const response = await handler(postRequest({ certificate: "c" }));

  assert.equal(response.status, 500);
  const body = await readEnvelope<DirectAppHttpFailureEnvelope>(response);
  assert.equal(body.error.code, "INTERNAL_ERROR");
  assert.ok(!body.error.message.includes("token=abc123"));
});

test("never serializes credential-shaped fields even when nested in a result", async () => {
  const { executor } = fakeExecutor(() => succeeded("change.issue"));
  const handler = createDirectAppHttpHandler({ executor });
  const response = await handler(postRequest({ certificate: "c" }));
  const text = await response.text();

  assert.ok(!/private[_-]?key/iu.test(text));
  assert.ok(!/installationToken/iu.test(text));
});
