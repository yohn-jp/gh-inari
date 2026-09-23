import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuthorizedExecution } from "../authorized-execution.js";
import { LocalExecutorClient, LocalExecutorClientError } from "./executor-client.js";

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
