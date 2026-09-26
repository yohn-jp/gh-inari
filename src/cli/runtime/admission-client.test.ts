import assert from "node:assert/strict";
import { test } from "node:test";
import * as admissionServer from "../../local-control/admission-server.js";
import * as compatibilityFacade from "../../local-control/admission-client.js";
import * as launcherFacade from "../../local-control/session-launcher.js";
import * as launcher from "./session-launcher.js";
import * as client from "./admission-client.js";
import type { ExecutionIntent } from "../../local-control/execution-intent.js";

const TEST_ENDPOINT = "http://127.0.0.1:43123";
const TEST_SESSION_ID = "session-1211";
const TEST_EXECUTION_INTENT: ExecutionIntent = {
  version: 1,
  requestId: "request-1211",
  repository: {
    repositoryHost: "github.com",
    repositoryId: "1330755860",
    repositoryNameWithOwner: "yohn-jp/gh-inari",
  },
  operation: "change.show",
  request: { version: 1, operation: "show", issue: 1207 },
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function manualTimers() {
  type Handle = ReturnType<typeof globalThis.setTimeout>;
  const callbacks = new Map<Handle, { readonly dueAt: number; readonly callback: () => void }>();
  const delays: number[] = [];
  let now = 0;
  let nextId = 0;
  const setTimeout = ((callback: () => void, delay = 0) => {
    const handle = { id: ++nextId } as unknown as Handle;
    delays.push(delay);
    callbacks.set(handle, { dueAt: now + delay, callback });
    return handle;
  }) as typeof globalThis.setTimeout;
  const clearTimeout = ((handle: Handle) => {
    callbacks.delete(handle);
  }) as typeof globalThis.clearTimeout;

  return {
    timers: { setTimeout, clearTimeout },
    delays,
    get now() {
      return now;
    },
    get pendingCount() {
      return callbacks.size;
    },
    advanceBy(milliseconds: number) {
      const target = now + milliseconds;
      while (true) {
        const next = [...callbacks.entries()]
          .filter(([, timer]) => timer.dueAt <= target)
          .sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
        if (next === undefined) break;
        callbacks.delete(next[0]);
        now = next[1].dueAt;
        next[1].callback();
      }
      now = target;
    },
  };
}

test("the CLI Admission client wire constants match the Admission server without importing it", () => {
  assert.equal(client.LOCAL_ADMISSION_CLIENT_PROTOCOL_VERSION, admissionServer.LOCAL_ADMISSION_PROTOCOL_VERSION);
  assert.equal(client.LOCAL_ADMISSION_CLIENT_HEALTH_PATH, admissionServer.LOCAL_ADMISSION_HEALTH_PATH);
  assert.equal(client.LOCAL_ADMISSION_CLIENT_SESSIONS_PATH, admissionServer.LOCAL_ADMISSION_SESSIONS_PATH);
  assert.equal(client.LOCAL_ADMISSION_CLIENT_REPOSITORY_PATH, admissionServer.LOCAL_ADMISSION_REPOSITORY_PATH);
  assert.equal(client.LOCAL_ADMISSION_CLIENT_EXECUTIONS_PATH, admissionServer.LOCAL_ADMISSION_EXECUTIONS_PATH);
  assert.equal(client.LOCAL_ADMISSION_CLIENT_SESSION_ID_HEADER, admissionServer.LOCAL_ADMISSION_SESSION_ID_HEADER);
});

test("local-control compatibility facades re-export the CLI Runtime modules unchanged", () => {
  for (const name of Object.keys(client) as (keyof typeof client)[]) {
    assert.equal(compatibilityFacade[name], client[name], name);
  }
  for (const name of Object.keys(launcher) as (keyof typeof launcher)[]) {
    assert.equal(launcherFacade[name], launcher[name], name);
  }
  for (const name of [
    "createLocalAdmissionClient",
    "createAdmissionChangeExecutionPort",
    "createSessionExecutionIntent",
    "configuredLocalAdmissionTopology",
    "requireConfiguredLocalAdmissionRoute",
    "LocalAdmissionClientError",
  ] as const) {
    assert.equal(typeof compatibilityFacade[name], "function", name);
  }
  for (const name of [
    "startLocalSession",
    "closeLocalSession",
    "readLocalSessionBinding",
    "storeLocalSessionBinding",
    "readLocalSessionChangeIssueProvenance",
    "storeLocalSessionChangeIssueProvenance",
    "LocalSessionLauncherError",
  ] as const) {
    assert.equal(typeof launcherFacade[name], "function", name);
  }
});

test("control requests keep 10 seconds while executions can finish after 10 seconds", async () => {
  const timers = manualTimers();
  const admission = client.createLocalAdmissionClient({
    endpoint: TEST_ENDPOINT,
    timers: timers.timers,
    fetchImpl: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === client.LOCAL_ADMISSION_CLIENT_REPOSITORY_PATH) {
        return jsonResponse({
          ok: true,
          repository: {
            repositoryHost: "github.com",
            repositoryId: "1330755860",
            repositoryNameWithOwner: "yohn-jp/gh-inari",
          },
        });
      }
      assert.equal(path, client.LOCAL_ADMISSION_CLIENT_EXECUTIONS_PATH);
      timers.advanceBy(20_544);
      return jsonResponse({ ok: true, result: { status: "succeeded" } });
    },
  });

  const repository = await admission.resolveRepository("yohn-jp/gh-inari");
  assert.equal(repository.repositoryId, "1330755860");
  const result = await admission.executeIntent(TEST_EXECUTION_INTENT, TEST_SESSION_ID);

  assert.deepEqual(result, { status: "succeeded" });
  assert.deepEqual(timers.delays, [10_000, 60_000]);
  assert.equal(timers.now, 20_544);
  assert.equal(timers.pendingCount, 0);
});

test("execution deadline expiry reports an unknown outcome without retrying", async () => {
  const timers = manualTimers();
  let calls = 0;
  const admission = client.createLocalAdmissionClient({
    endpoint: TEST_ENDPOINT,
    timers: timers.timers,
    fetchImpl: (_input, init) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === undefined || signal === null) {
          reject(new Error("expected deadline signal"));
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  const result = admission.executeIntent(TEST_EXECUTION_INTENT, TEST_SESSION_ID).then(
    () => new Error("execution unexpectedly succeeded"),
    (error: unknown) => error,
  );

  timers.advanceBy(60_000);
  const error = await result;

  assert.ok(error instanceof client.LocalAdmissionClientError);
  assert.equal(error.code, "ADMISSION_EXECUTION_TIMEOUT");
  assert.match(error.message, /outcome is unknown/u);
  assert.match(error.message, /server-side execution may still complete/u);
  assert.equal(calls, 1);
  assert.equal(timers.pendingCount, 0);
});

test("control deadline expiry is distinct from transport failure", async () => {
  const timers = manualTimers();
  const admission = client.createLocalAdmissionClient({
    endpoint: TEST_ENDPOINT,
    timers: timers.timers,
    fetchImpl: (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === undefined || signal === null) {
          reject(new Error("expected deadline signal"));
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  });
  const result = admission.resolveRepository("yohn-jp/gh-inari").then(
    () => new Error("request unexpectedly succeeded"),
    (error: unknown) => error,
  );

  timers.advanceBy(10_000);
  const error = await result;

  assert.ok(error instanceof client.LocalAdmissionClientError);
  assert.equal(error.code, "ADMISSION_REQUEST_TIMEOUT");
  assert.deepEqual(timers.delays, [10_000]);
  assert.equal(timers.pendingCount, 0);
});

test("connection failures retain transport-unavailable mapping", async () => {
  let calls = 0;
  const admission = client.createLocalAdmissionClient({
    endpoint: TEST_ENDPOINT,
    fetchImpl: async () => {
      calls += 1;
      throw new TypeError("connection refused with private transport detail");
    },
  });

  await assert.rejects(admission.executeIntent(TEST_EXECUTION_INTENT, TEST_SESSION_ID), (error: unknown) => {
    assert.ok(error instanceof client.LocalAdmissionClientError);
    assert.equal(error.code, "ADMISSION_TRANSPORT_FAILED");
    assert.equal(error.message, "Configured local Admission is unavailable.");
    assert.equal(error.message.includes("private transport detail"), false);
    return true;
  });
  assert.equal(calls, 1);
});

test("bounded HTTP denial mapping remains unchanged", async () => {
  const admission = client.createLocalAdmissionClient({
    endpoint: TEST_ENDPOINT,
    fetchImpl: async () =>
      jsonResponse(
        {
          ok: false,
          error: {
            failure: {
              stage: "implementation-admission",
              reason: "ADMISSION_IMPLEMENTATION_UNAUTHORIZED",
              category: "denied",
              message: "The current Implementation is not authorized.",
            },
          },
        },
        403,
      ),
  });

  await assert.rejects(admission.executeIntent(TEST_EXECUTION_INTENT, TEST_SESSION_ID), (error: unknown) => {
    assert.ok(error instanceof client.LocalAdmissionClientError);
    assert.equal(error.code, "ADMISSION_REQUEST_DENIED");
    assert.equal(error.status, 403);
    assert.equal(error.details?.category, "denied");
    return true;
  });
});

test("execution timeout configuration rejects values above the compile-time bound", () => {
  assert.throws(
    () =>
      client.createLocalAdmissionClient({
        endpoint: TEST_ENDPOINT,
        executionTimeoutMs: 60_001,
        fetchImpl: async () => jsonResponse({ ok: true }),
      }),
    (error: unknown) => error instanceof client.LocalAdmissionClientError && error.code === "ADMISSION_TIMEOUT_INVALID",
  );
});
