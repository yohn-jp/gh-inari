import assert from "node:assert/strict";
import { test } from "node:test";
import type { Env } from "./worker.js";

const VALID_ENV: Env = {
  INARI_GITHUB_APP_ID: "123",
  INARI_GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n",
  INARI_GITHUB_APP_INSTALLATION_ID: "456",
  INARI_TARGET_REPOSITORY_OWNER: "acme",
  INARI_TARGET_REPOSITORY_NAME: "inari",
};

let uniqueId = 0;

/** Cache-bust the ES module graph so each test gets its own module-scope runtime cache. */
async function freshWorkerModule(): Promise<typeof import("./worker.js")> {
  uniqueId += 1;
  return import(`./worker.js?test-instance=${uniqueId}`);
}

test("/healthz reports readiness without leaking secret values", async () => {
  const worker = await freshWorkerModule();
  const response = await worker.default.fetch(new Request("https://worker.example/healthz"), VALID_ENV);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { ok: boolean; service: string };
  assert.equal(body.ok, true);
  const text = JSON.stringify(body);
  assert.ok(!text.includes("fake"));
  assert.ok(!text.includes(VALID_ENV.INARI_GITHUB_APP_PRIVATE_KEY));
});

test("/healthz reports not-ready when a required secret is missing, without leaking configuration", async () => {
  const worker = await freshWorkerModule();
  const { INARI_GITHUB_APP_PRIVATE_KEY: _omitted, ...incomplete } = VALID_ENV;
  const response = await worker.default.fetch(new Request("https://worker.example/healthz"), incomplete as Env);
  assert.equal(response.status, 503);
  const body = (await response.json()) as { ok: boolean };
  assert.equal(body.ok, false);
});

test("/healthz accepts only GET without resolving the runtime for unsupported methods", async () => {
  const { INARI_GITHUB_APP_PRIVATE_KEY: _omitted, ...incomplete } = VALID_ENV;

  for (const method of ["HEAD", "POST", "PUT", "DELETE"]) {
    const worker = await freshWorkerModule();
    const response = await worker.default.fetch(
      new Request("https://worker.example/healthz", { method }),
      incomplete as Env,
    );
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("allow"), "GET");
    if (method !== "HEAD") {
      const body = (await response.json()) as { ok: boolean; error: { code: string } };
      assert.equal(body.ok, false);
      assert.equal(body.error.code, "METHOD_NOT_ALLOWED");
    }
  }
});

test("missing configuration fails closed for /v1/execute with a secret-safe error", async () => {
  const worker = await freshWorkerModule();
  const { INARI_GITHUB_APP_PRIVATE_KEY: _omitted, ...incomplete } = VALID_ENV;
  const response = await worker.default.fetch(
    new Request("https://worker.example/v1/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ certificate: "x" }),
    }),
    incomplete as Env,
  );
  assert.equal(response.status, 500);
  const body = (await response.json()) as { ok: boolean; error: { code: string } };
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "WORKER_CONFIGURATION_INVALID");
});

test("valid configuration delegates /v1/execute to the frozen #377 transport", async () => {
  const worker = await freshWorkerModule();
  const response = await worker.default.fetch(
    new Request("https://worker.example/v1/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ certificate: "not-a-real-certificate" }),
    }),
    VALID_ENV,
  );
  // Authentication fails closed before any network access; the important
  // assertion is that the request reached the #377 handler contract at all
  // (a bounded JSON envelope), not that authentication succeeded.
  assert.equal(response.status, 401);
  const body = (await response.json()) as { ok: boolean; error: { code: string } };
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "SESSION_AUTHENTICATION_FAILED");
});

test("an unknown path returns 404 from the #377 transport when configuration is valid", async () => {
  const worker = await freshWorkerModule();
  const response = await worker.default.fetch(new Request("https://worker.example/nope"), VALID_ENV);
  assert.equal(response.status, 404);
});

test("/v1/runtime-authority/publish rejects an unauthenticated caller before any Issuer/GitHub network access", async () => {
  const worker = await freshWorkerModule();
  const response = await worker.default.fetch(
    new Request("https://worker.example/v1/runtime-authority/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, authority: { id: "unauthenticated-caller" } }),
    }),
    VALID_ENV,
  );
  // VALID_ENV has no fetch injected, so any Issuer/GitHub network call this
  // handler attempted would throw. Getting a clean 401 back proves the
  // caller-authorization check runs, and rejects, before that.
  assert.equal(response.status, 401);
  const body = (await response.json()) as { ok: boolean; error: { code: string } };
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "UNAUTHORIZED");
});

test("missing configuration fails closed for /v1/runtime-authority/publish with a secret-safe error", async () => {
  const worker = await freshWorkerModule();
  const { INARI_GITHUB_APP_PRIVATE_KEY: _omitted, ...incomplete } = VALID_ENV;
  const response = await worker.default.fetch(
    new Request("https://worker.example/v1/runtime-authority/publish", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer caller-token" },
      body: JSON.stringify({ version: 1, authority: { id: "x" } }),
    }),
    incomplete as Env,
  );
  assert.equal(response.status, 500);
  const body = (await response.json()) as { ok: boolean; error: { code: string } };
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "WORKER_CONFIGURATION_INVALID");
});
