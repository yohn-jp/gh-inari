import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createDelegatorRecord } from "../agent-authority/delegator-operations.js";
import { generateDelegatorKeyPair } from "../agent-authority/delegator-key.js";
import type { LocalAdmissionConfig } from "../local-control/config.js";
import {
  createLocalAdmissionHttpServer,
  LOCAL_ADMISSION_EXECUTIONS_PATH,
  LOCAL_ADMISSION_HEALTH_PATH,
  LOCAL_ADMISSION_SESSION_ID_HEADER,
  type AdmissionExecutorClient,
} from "./server.js";
import { LocalAdmissionError } from "./setup.js";

const EXECUTOR_ID = "exec_0123456789abcdef";
const ADMISSION_ID = "adm_0123456789abcdef";

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
