import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuthorizedExecution } from "../authorized-execution.js";
import { LocalExecutorClient, LocalExecutorClientError, type LocalExecutorClientOptions } from "./executor-client.js";

const ID = "exec_0123456789abcdef";

test("Executor HTTPS endpoints require an mTLS identity and never use the bind address as a destination", () => {
  assert.throws(() => new LocalExecutorClient({ id: ID, endpoint: "https://127.0.0.1:8765" }), /mTLS identity/u);
  assert.throws(
    () =>
      new LocalExecutorClient({
        id: ID,
        endpoint: "https://0.0.0.0:8765",
        transport: {
          certificate: Buffer.from("certificate"),
          privateKey: Buffer.from("private key"),
          caCertificate: Buffer.from("CA"),
          peerId: ID,
          peerRole: "executor",
        },
      }),
    /loopback destination/u,
  );
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function manualTimers(): {
  readonly timers: NonNullable<LocalExecutorClientOptions["timers"]>;
  readonly fireNext: () => number;
  readonly scheduledDelays: () => number[];
  readonly activeCount: () => number;
} {
  type Entry = { readonly callback: () => void; readonly delay: number; cleared: boolean; fired: boolean };
  const entries: Entry[] = [];
  const timers = {
    setTimeout: ((callback: () => void, delay = 0) => {
      const entry: Entry = { callback, delay, cleared: false, fired: false };
      entries.push(entry);
      return entry as unknown as ReturnType<typeof globalThis.setTimeout>;
    }) as typeof globalThis.setTimeout,
    clearTimeout: ((timer?: ReturnType<typeof globalThis.setTimeout>) => {
      const entry = timer as unknown as Entry | undefined;
      if (entry !== undefined) entry.cleared = true;
    }) as typeof globalThis.clearTimeout,
  };
  return {
    timers,
    fireNext() {
      const entry = entries.find((candidate) => !candidate.cleared && !candidate.fired);
      assert.ok(entry, "expected an active deadline timer");
      entry.fired = true;
      entry.callback();
      return entry.delay;
    },
    scheduledDelays: () => entries.map((entry) => entry.delay),
    activeCount: () => entries.filter((entry) => !entry.cleared && !entry.fired).length,
  };
}

test("Executor client verifies readiness and exact configured identity", async () => {
  const client = new LocalExecutorClient({
    id: ID,
    endpoint: "http://127.0.0.1:8765",
    fetch: async () =>
      json(200, {
        ok: true,
        version: "0.14.1",
        component: "executor",
        executorId: ID,
        protocol: 1,
        readiness: "ready",
      }),
  });
  assert.equal((await client.verifyReady()).executorId, ID);

  const wrong = new LocalExecutorClient({
    id: ID,
    endpoint: "http://127.0.0.1:8765",
    fetch: async () =>
      json(200, {
        ok: true,
        version: "0.14.1",
        component: "executor",
        executorId: "exec_fedcba9876543210",
        protocol: 1,
        readiness: "ready",
      }),
  });
  await assert.rejects(wrong.verifyReady(), (error: unknown) => {
    assert.ok(error instanceof LocalExecutorClientError);
    assert.equal(error.code, "EXECUTOR_IDENTITY_MISMATCH");
    return true;
  });
});

test("Executor deadlines reject invalid budgets before starting transport", () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return json(200, {});
  };
  assert.throws(
    () =>
      new LocalExecutorClient({
        id: ID,
        endpoint: "http://127.0.0.1:8765",
        fetch,
        timeoutMs: Number.POSITIVE_INFINITY,
      }),
    /timeout/u,
  );
  assert.throws(
    () => new LocalExecutorClient({ id: ID, endpoint: "http://127.0.0.1:8765", fetch, executionTimeoutMs: 60_001 }),
    /timeout/u,
  );
  assert.equal(calls, 0);
});

test("Executor fetch timeout aborts a stalled request and settles without waiting for late transport completion", async () => {
  const deadline = manualTimers();
  let started!: () => void;
  const fetchStarted = new Promise<void>((resolve) => (started = resolve));
  const captured = { signal: undefined as AbortSignal | undefined };
  const client = new LocalExecutorClient({
    id: ID,
    endpoint: "http://127.0.0.1:8765",
    timeoutMs: 321,
    timers: deadline.timers,
    fetch: async (_input, init) => {
      captured.signal = init?.signal ?? undefined;
      started();
      return await new Promise<Response>(() => {});
    },
  });
  const pending = client.verifyReady();
  await fetchStarted;
  assert.deepEqual(deadline.scheduledDelays(), [321]);
  deadline.fireNext();
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof LocalExecutorClientError);
    assert.equal(error.code, "EXECUTOR_TIMEOUT");
    assert.equal(error.runtimeFailure?.reason, "EXECUTOR_REQUEST_TIMEOUT");
    return true;
  });
  assert.equal(captured.signal?.aborted, true);
  assert.equal(deadline.activeCount(), 0);
});

test("Executor deadline spans response headers and cancels a partial response body", async () => {
  const deadline = manualTimers();
  const encoder = new TextEncoder();
  let chunkRead!: () => void;
  const bodyChunkRead = new Promise<void>((resolve) => (chunkRead = resolve));
  let nextChunkRequested!: () => void;
  const stalledRead = new Promise<void>((resolve) => (nextChunkRequested = resolve));
  let cancelled!: () => void;
  const bodyCancelled = new Promise<void>((resolve) => (cancelled = resolve));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('{"ok":true,"version":"1","component":"executor",'));
    },
    pull() {
      nextChunkRequested();
      return new Promise<void>(() => {});
    },
    cancel() {
      cancelled();
    },
  });
  const client = new LocalExecutorClient({
    id: ID,
    endpoint: "http://127.0.0.1:8765",
    timeoutMs: 100,
    timers: deadline.timers,
    onResponseBodyChunkRead: () => chunkRead(),
    fetch: async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
  });
  const pending = client.verifyReady();
  await bodyChunkRead;
  await stalledRead;
  assert.equal(body.locked, true);
  assert.deepEqual(deadline.scheduledDelays(), [100]);
  deadline.fireNext();
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof LocalExecutorClientError);
    assert.equal(error.code, "EXECUTOR_TIMEOUT");
    return true;
  });
  await bodyCancelled;
  assert.equal(deadline.activeCount(), 0);
});

test("Executor deadline disposes a fetch response that arrives after timeout", async () => {
  const deadline = manualTimers();
  let started!: () => void;
  const fetchStarted = new Promise<void>((resolve) => (started = resolve));
  let resolveFetch!: (response: Response) => void;
  const lateFetchResponse = new Promise<Response>((resolve) => (resolveFetch = resolve));
  let cancelled!: () => void;
  const bodyCancelled = new Promise<void>((resolve) => (cancelled = resolve));
  const client = new LocalExecutorClient({
    id: ID,
    endpoint: "http://127.0.0.1:8765",
    timeoutMs: 50,
    timers: deadline.timers,
    fetch: async () => {
      started();
      return await lateFetchResponse;
    },
  });
  const pending = client.verifyReady();
  await fetchStarted;
  deadline.fireNext();
  await assert.rejects(pending, (error: unknown) => error instanceof LocalExecutorClientError);
  const lateBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{}"));
    },
    cancel() {
      cancelled();
    },
  });
  resolveFetch(
    new Response(lateBody, {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  await bodyCancelled;
  assert.equal(deadline.activeCount(), 0);
});

test("Executor uses provider and execution budgets and clears timers after normal and protocol-error completion", async () => {
  const providerDeadline = manualTimers();
  let providerFetchStarted!: () => void;
  const providerStarted = new Promise<void>((resolve) => (providerFetchStarted = resolve));
  const provider = new LocalExecutorClient({
    id: ID,
    endpoint: "http://127.0.0.1:8765",
    timeoutMs: 11,
    providerTimeoutMs: 22,
    executionTimeoutMs: 33,
    timers: providerDeadline.timers,
    fetch: async () => {
      providerFetchStarted();
      return await new Promise<Response>(() => {});
    },
  });
  const providerPending = provider.readEvidence({
    version: 1,
    repository: { id: "123456789", name: "acme/inari" },
    authorityId: "runtime-test",
  });
  await providerStarted;
  assert.deepEqual(providerDeadline.scheduledDelays(), [22]);
  providerDeadline.fireNext();
  await assert.rejects(providerPending, (error: unknown) => error instanceof LocalExecutorClientError);

  const executionDeadline = manualTimers();
  let executionFetchStarted!: () => void;
  const executionStarted = new Promise<void>((resolve) => (executionFetchStarted = resolve));
  const execution = new LocalExecutorClient({
    id: ID,
    endpoint: "http://127.0.0.1:8765",
    timeoutMs: 11,
    providerTimeoutMs: 22,
    executionTimeoutMs: 33,
    timers: executionDeadline.timers,
    fetch: async () => {
      executionFetchStarted();
      return await new Promise<Response>(() => {});
    },
  });
  const executionPending = execution.execute({} as AuthorizedExecution);
  await executionStarted;
  assert.deepEqual(executionDeadline.scheduledDelays(), [33]);
  executionDeadline.fireNext();
  await assert.rejects(executionPending, (error: unknown) => error instanceof LocalExecutorClientError);

  const successDeadline = manualTimers();
  const success = new LocalExecutorClient({
    id: ID,
    endpoint: "http://127.0.0.1:8765",
    timers: successDeadline.timers,
    fetch: async () =>
      json(200, {
        ok: true,
        version: "0.14.1",
        component: "executor",
        executorId: ID,
        protocol: 1,
        readiness: "ready",
      }),
  });
  await success.verifyReady();
  assert.equal(successDeadline.activeCount(), 0);

  const errorDeadline = manualTimers();
  let protocolBodyCancelled!: () => void;
  const protocolBodyWasCancelled = new Promise<void>((resolve) => (protocolBodyCancelled = resolve));
  const protocolBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{}"));
    },
    cancel() {
      protocolBodyCancelled();
    },
  });
  const protocolError = new LocalExecutorClient({
    id: ID,
    endpoint: "http://127.0.0.1:8765",
    timers: errorDeadline.timers,
    fetch: async () => new Response(protocolBody, { headers: { "content-type": "text/plain" } }),
  });
  await assert.rejects(protocolError.verifyReady(), (error: unknown) => {
    assert.ok(error instanceof LocalExecutorClientError);
    assert.equal(error.code, "EXECUTOR_PROTOCOL_INVALID");
    return true;
  });
  await protocolBodyWasCancelled;
  assert.equal(errorDeadline.activeCount(), 0);
});

test("timed out dispatched execution has an unknown outcome and is never replayed", async () => {
  const deadline = manualTimers();
  let dispatched = 0;
  let providerEffects = 0;
  const client = new LocalExecutorClient({
    id: ID,
    endpoint: "http://127.0.0.1:8765",
    executionTimeoutMs: 17,
    timers: deadline.timers,
    fetch: async () => {
      dispatched += 1;
      providerEffects += 1;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(`{"ok":true,"component":"executor","executorId":"${ID}","protocol":1,"result":`),
            );
          },
        }),
        { status: 200, headers: { "content-type": "application/json; charset=utf-8" } },
      );
    },
  });
  const pending = client.execute({} as AuthorizedExecution);
  assert.deepEqual(deadline.scheduledDelays(), [17]);
  deadline.fireNext();
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof LocalExecutorClientError);
    assert.equal(error.code, "EXECUTOR_TIMEOUT");
    assert.match(error.message, /outcome is unknown/u);
    assert.deepEqual(
      error.runtimeFailure && { stage: error.runtimeFailure.stage, reason: error.runtimeFailure.reason },
      {
        stage: "provider-execution",
        reason: "EXECUTOR_EXECUTION_TIMEOUT",
      },
    );
    return true;
  });
  assert.equal(dispatched, 1);
  assert.equal(providerEffects, 1);
});

test("Executor client pins identity on evidence and execution responses", async () => {
  const calls: string[] = [];
  const client = new LocalExecutorClient({
    id: ID,
    endpoint: "http://127.0.0.1:8765",
    fetch: async (input) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname === "/v1/evidence")
        return json(200, {
          ok: true,
          component: "executor",
          executorId: ID,
          protocol: 1,
          evidence: { current: true },
        });
      return json(200, {
        ok: true,
        component: "executor",
        executorId: ID,
        protocol: 1,
        result: { version: 1, status: "succeeded" },
      });
    },
  });
  assert.deepEqual(
    await client.readEvidence({
      version: 1,
      repository: { id: "123456789", name: "acme/inari" },
      authorityId: "runtime-test",
    }),
    { current: true },
  );
  const result = await client.execute({} as AuthorizedExecution);
  assert.equal(result.status, "succeeded");
  assert.deepEqual(calls, ["/v1/evidence", "/v1/executions"]);
});

test("Executor client accepts bounded exact task status and rejects malformed or mismatched evidence", async () => {
  const authorization = {
    version: 1,
    kind: "implementation-authorization",
    contractVersion: 1,
    repository: { repositoryHost: "github.com", repositoryId: "123456789", repository: "acme/inari" },
    implementation: { repositoryHost: "github.com", repositoryId: "123456789", repository: "acme/inari", number: 1250 },
    base: { branch: "main", revision: "a".repeat(40), freshness: "fresh-1" },
    governedBodyDigest: "b".repeat(64),
  } as const;
  const request = {
    version: 1,
    repository: { id: "123456789", name: "acme/inari" },
    authorityId: "runtime-test",
    issue: 1250,
    implementationIssue: 1250,
    taskTerminationAuthorization: authorization,
  } as const;
  const response = (taskTermination: unknown, executorId = ID) =>
    json(200, {
      ok: true,
      component: "executor",
      executorId,
      protocol: 1,
      evidence: {
        repository: { repositoryHost: "github.com", repositoryId: "123456789", nameWithOwner: "acme/inari" },
        implementation: { implementation: authorization.implementation },
        taskTermination,
      },
    });
  const client = (taskTermination: unknown, executorId?: string) =>
    new LocalExecutorClient({
      id: ID,
      endpoint: "http://127.0.0.1:8765",
      fetch: async () => response(taskTermination, executorId),
    });
  const absent = {
    status: "absent",
    provenance: { source: "github-git-data", commit: "a".repeat(40) },
    recordProvenance: [],
  };
  assert.deepEqual(await client(absent).readEvidence(request), {
    repository: { repositoryHost: "github.com", repositoryId: "123456789", nameWithOwner: "acme/inari" },
    implementation: { implementation: authorization.implementation },
    taskTermination: absent,
  });
  for (const task of [
    { status: "absent", recordProvenance: [] },
    { ...absent, provenance: {} },
    { status: "present", recordProvenance: [], record: { version: 1 } },
    { status: "unavailable", recordProvenance: [], token: "secret" },
  ])
    await assert.rejects(
      client(task).readEvidence(request),
      (error: unknown) => error instanceof LocalExecutorClientError && error.code === "EXECUTOR_PROTOCOL_INVALID",
    );
  await assert.rejects(
    client(absent, "exec_fedcba9876543210").readEvidence(request),
    (error: unknown) => error instanceof LocalExecutorClientError && error.code === "EXECUTOR_IDENTITY_MISMATCH",
  );
});
