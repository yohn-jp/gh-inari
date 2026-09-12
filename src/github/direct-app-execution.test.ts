import assert from "node:assert/strict";
import { test } from "node:test";
import { createDirectAppSessionExecutor } from "./direct-app-execution.js";

const REPOSITORY = { hostname: "github.com", owner: "acme", name: "inari" } as const;
const FAKE_PRIVATE_KEY_PEM = "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n";

function noNetworkFetch(): typeof globalThis.fetch {
  return (async () => {
    throw new Error("no network access is expected before Session authentication succeeds");
  }) as typeof globalThis.fetch;
}

test("createDirectAppSessionExecutor returns a transport-neutral executor", () => {
  const executor = createDirectAppSessionExecutor({
    appId: "123",
    installationId: "456",
    privateKeyPem: FAKE_PRIVATE_KEY_PEM,
    repository: REPOSITORY,
    fetch: noNetworkFetch(),
  });
  assert.equal(typeof executor.execute, "function");
});

test("rejects a malformed installation identity before any network access", () => {
  assert.throws(() =>
    createDirectAppSessionExecutor({
      appId: "123",
      installationId: "not-a-decimal-id",
      privateKeyPem: FAKE_PRIVATE_KEY_PEM,
      repository: REPOSITORY,
      fetch: noNetworkFetch(),
    }),
  );
});

for (const operation of ["change.issue", "change.show", "change.ready", "change.abort", "branch.advance"] as const) {
  test(`${operation} fails closed at authentication for an unsigned envelope without contacting GitHub`, async () => {
    const executor = createDirectAppSessionExecutor({
      appId: "123",
      installationId: "456",
      privateKeyPem: FAKE_PRIVATE_KEY_PEM,
      repository: REPOSITORY,
      fetch: noNetworkFetch(),
    });
    const result = await executor.execute({ certificate: "not-a-real-certificate", request: { operation } });
    assert.equal(result.status, "failed");
    assert.equal(result.failure?.phase, "authentication");
  });
}
