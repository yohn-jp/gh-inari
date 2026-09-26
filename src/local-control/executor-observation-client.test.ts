import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ExecutorAppCredentialStore } from "../executor/credential-store.js";
import { createLocalExecutorObservationPort } from "../executor/observation.js";
import { ExecutorRepositoryBindingStore } from "../executor/repository-binding-store.js";
import { ensureLocalExecutorConfiguration } from "../executor/setup.js";
import { createLocalExecutorHttpServer } from "./executor-server.js";
import { ExecutorObservationClient, ExecutorObservationClientError } from "./executor-observation-client.js";
import { LOCAL_EXECUTOR_OWNER_OBSERVATION_PATH } from "./executor-http.js";

const EXECUTOR_ID = "exec_0123456789abcdef";
const OBSERVATION = {
  version: 1,
  executorId: EXECUTOR_ID,
  apps: [
    {
      appId: "123",
      generation: "generation-000000123",
      fingerprint: `sha256:${"c".repeat(64)}`,
      providerVerified: true,
      source: "app-scoped",
    },
  ],
  bindings: [],
};

function respond(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function client(fetch: typeof globalThis.fetch, executorId = EXECUTOR_ID): ExecutorObservationClient {
  return new ExecutorObservationClient({ endpoint: "http://127.0.0.1:9", executorId, fetch });
}

async function rejectsWith(port: ExecutorObservationClient, code: string): Promise<void> {
  await assert.rejects(port.observe(), (error: unknown) => {
    assert.ok(error instanceof ExecutorObservationClientError);
    assert.equal(error.code, code);
    return true;
  });
}

const envelope = (observation: unknown = OBSERVATION, overrides: Record<string, unknown> = {}) => ({
  ok: true,
  component: "executor",
  executorId: EXECUTOR_ID,
  protocol: 1,
  observation,
  ...overrides,
});

test("#1223 the HTTP adapter observes a running Executor exactly as its local adapter over loopback", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "inari-observation-client-"));
  const environment = { INARI_CONFIG_HOME: path.join(root, "executor-host") };
  try {
    const { config } = await ensureLocalExecutorConfiguration(environment);
    const apps = new ExecutorAppCredentialStore(environment);
    const key = Buffer.from(
      generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }),
    );
    const credential = apps.markProviderVerified("123", apps.save(config.id, "123", key).record.generation);
    new ExecutorRepositoryBindingStore(environment).publish({
      repositoryHost: "github.com",
      repositoryId: "101",
      nameWithOwner: "acme/one",
      appId: "123",
      installationId: "77",
      generation: credential.generation,
      fingerprint: credential.fingerprint,
    });
    const local = createLocalExecutorObservationPort({ environment });
    const server = createLocalExecutorHttpServer({
      config: { ...config, listen: { host: "127.0.0.1", port: 0 } },
      listenPort: 0,
      version: "observation-test",
      executorId: config.id,
      execute: async () => {
        throw new Error("not used");
      },
      observeOwner: () => local.observe(),
    });
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const stoppedPort = port;
    try {
      const remote = new ExecutorObservationClient({ endpoint: `http://127.0.0.1:${port}`, executorId: config.id });
      const observed = await remote.observe();
      assert.deepEqual(observed, await local.observe());
      assert.equal(observed.bindings[0]?.status, "bound");
      const serialized = JSON.stringify(observed);
      for (const needle of [environment.INARI_CONFIG_HOME, "PRIVATE KEY", ".pem", key.toString("utf8").slice(40, 90)])
        assert.equal(serialized.includes(needle), false, needle);
      // Another expected Executor is an identity mismatch, never a silent success.
      await rejectsWith(
        new ExecutorObservationClient({ endpoint: `http://127.0.0.1:${port}`, executorId: "exec_fedcba9876543210" }),
        "EXECUTOR_OBSERVATION_IDENTITY_MISMATCH",
      );
    } finally {
      server.close();
      await once(server, "close");
    }
    // A stopped Executor is unavailable; the client never falls back to the owner files it cannot see.
    await rejectsWith(
      new ExecutorObservationClient({ endpoint: `http://127.0.0.1:${stoppedPort}`, executorId: config.id }),
      "EXECUTOR_OBSERVATION_UNAVAILABLE",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1223 malformed, oversized, foreign, forbidden or invalid responses fail closed", async () => {
  const calls: string[] = [];
  const fetchReturning =
    (response: () => Response): typeof globalThis.fetch =>
    async (input) => {
      calls.push(String(input));
      return response();
    };
  assert.deepEqual(await client(fetchReturning(() => respond(envelope()))).observe(), OBSERVATION);
  assert.deepEqual(calls, [`http://127.0.0.1:9${LOCAL_EXECUTOR_OWNER_OBSERVATION_PATH}`]);

  const cases: readonly [() => Response, string][] = [
    [() => respond("{", 200), "EXECUTOR_OBSERVATION_PROTOCOL_INVALID"],
    [() => respond(envelope(), 200, { "content-type": "text/plain" }), "EXECUTOR_OBSERVATION_PROTOCOL_INVALID"],
    [() => respond(`{"pad":"${"x".repeat(1_048_600)}"}`), "EXECUTOR_OBSERVATION_PROTOCOL_INVALID"],
    [() => respond(envelope(OBSERVATION, { protocol: 2 })), "EXECUTOR_OBSERVATION_PROTOCOL_INVALID"],
    [() => respond(envelope(OBSERVATION, { extra: true })), "EXECUTOR_OBSERVATION_PROTOCOL_INVALID"],
    [() => respond(envelope(OBSERVATION, { component: "admission" })), "EXECUTOR_OBSERVATION_PROTOCOL_INVALID"],
    [
      () => respond(envelope({ ...OBSERVATION, apps: [{ ...OBSERVATION.apps[0], file: "issuer-x.pem" }] })),
      "EXECUTOR_OBSERVATION_PROTOCOL_INVALID",
    ],
    [() => respond(envelope({ ...OBSERVATION, version: 2 })), "EXECUTOR_OBSERVATION_PROTOCOL_INVALID"],
    [
      () => respond(envelope(OBSERVATION, { executorId: "exec_fedcba9876543210" })),
      "EXECUTOR_OBSERVATION_IDENTITY_MISMATCH",
    ],
    [
      () => respond(envelope({ ...OBSERVATION, executorId: "exec_fedcba9876543210" })),
      "EXECUTOR_OBSERVATION_IDENTITY_MISMATCH",
    ],
    [() => respond({ ok: false, error: { code: "ROUTE_FORBIDDEN" } }, 403), "EXECUTOR_OBSERVATION_FORBIDDEN"],
    [
      () => respond({ ok: false, error: { code: "OWNER_OBSERVATION_UNAVAILABLE" } }, 503),
      "EXECUTOR_OBSERVATION_UNAVAILABLE",
    ],
  ];
  for (const [response, code] of cases) await rejectsWith(client(fetchReturning(response)), code);
  await rejectsWith(
    client(async () => {
      throw new Error("connect ECONNREFUSED");
    }),
    "EXECUTOR_OBSERVATION_UNAVAILABLE",
  );
  const redirected = respond(envelope());
  Object.defineProperty(redirected, "url", { value: "http://127.0.0.1:10/v1/owner/observation" });
  await rejectsWith(
    client(async () => redirected),
    "EXECUTOR_OBSERVATION_IDENTITY_MISMATCH",
  );
});

test("#1223 endpoints are explicit: unauthenticated observation is loopback-only and HTTPS requires a pinned Control identity", () => {
  const construct = (options: ConstructorParameters<typeof ExecutorObservationClient>[0]) => () =>
    new ExecutorObservationClient(options);
  const control = {
    certificate: Buffer.alloc(0),
    privateKey: Buffer.alloc(0),
    caCertificate: Buffer.alloc(0),
    peerRole: "executor" as const,
    peerId: EXECUTOR_ID,
  };
  assert.throws(construct({ endpoint: "http://executor.example.test:8443", executorId: EXECUTOR_ID }), TypeError);
  assert.throws(construct({ endpoint: "https://executor.example.test:8443", executorId: EXECUTOR_ID }), TypeError);
  assert.throws(
    construct({
      endpoint: "https://executor.example.test:8443",
      executorId: EXECUTOR_ID,
      transport: { ...control, peerId: "exec_fedcba9876543210" },
    }),
    TypeError,
  );
  assert.throws(
    construct({
      endpoint: "https://executor.example.test:8443",
      executorId: EXECUTOR_ID,
      transport: { ...control, peerRole: "admission" },
    }),
    TypeError,
  );
  assert.throws(construct({ endpoint: "http://127.0.0.1:1/v1", executorId: EXECUTOR_ID }), TypeError);
  assert.throws(construct({ endpoint: "http://user:pass@127.0.0.1:1", executorId: EXECUTOR_ID }), TypeError);
  assert.throws(construct({ endpoint: "http://127.0.0.1:1", executorId: "adm_0123456789abcdef" }), TypeError);
  // A separately hosted Executor is representable with an explicit endpoint and Control identity.
  assert.doesNotThrow(
    construct({ endpoint: "https://executor.example.test:8443", executorId: EXECUTOR_ID, transport: control }),
  );
});
