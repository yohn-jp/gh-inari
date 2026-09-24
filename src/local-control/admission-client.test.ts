import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createDelegatorRecord } from "../agent-authority/delegator-operations.js";
import { generateDelegatorKeyPair } from "../agent-authority/delegator-key.js";
import { changeReadRequest } from "../change-execution-port.js";
import { createLocalSessionBinding, type LocalSessionBinding } from "./session-binding.js";
import {
  createLocalAdmissionClient,
  createSessionExecutionIntent,
  configuredLocalAdmissionRoute,
  requireConfiguredLocalAdmissionRoute,
} from "./admission-client.js";
import { writeLocalJson, validateLocalCliConfig } from "./config.js";
import { publishLocalRuntimeEndpoint } from "./runtime-discovery.js";

const ENDPOINT = "http://127.0.0.1:41230";
const ISSUE = 1029;
const SESSION_ID = "sess_test-session-1029";
const REPOSITORY = { id: "1330755860", name: "yohn-jp/gh-inari" };

type CapturedRequest = { readonly url: URL; readonly init: RequestInit };

function bindingFixture(): LocalSessionBinding {
  const key = generateDelegatorKeyPair();
  const authority = createDelegatorRecord({
    id: "local-admission-client-test",
    key,
    notBefore: new Date("2026-08-01T00:00:00.000Z"),
    maxSessionTtlSeconds: 3_600,
    capabilityCeiling: ["change.implement"],
  });
  return createLocalSessionBinding({
    sessionId: SESSION_ID,
    repository: REPOSITORY,
    task: { kind: "issue", number: ISSUE },
    capabilities: [{ kind: "change.implement", issue: ISSUE }],
    ttlSeconds: 300,
    runtimeAuthority: authority,
    runtimeKey: key,
    now: new Date("2026-09-01T12:00:00.000Z"),
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("configured Admission client registers, closes, and executes only through its loopback route", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "inari-admission-client-"));
  const environment = { INARI_CONFIG_HOME: path.join(root, "config") };
  const binding = bindingFixture();
  const calls: CapturedRequest[] = [];
  writeLocalJson(
    "cli",
    "config.json",
    {
      version: 1,
      topology: { admission: "local", executor: "local" },
      admission: { id: "adm_0123456789abcdef" },
    },
    validateLocalCliConfig,
    environment,
  );
  publishLocalRuntimeEndpoint("admission", "adm_0123456789abcdef", 41230, environment);
  try {
    assert.deepEqual(configuredLocalAdmissionRoute(environment), {
      id: "adm_0123456789abcdef",
    });
    assert.deepEqual(requireConfiguredLocalAdmissionRoute(environment), {
      id: "adm_0123456789abcdef",
      endpoint: ENDPOINT,
    });
    const client = createLocalAdmissionClient({
      endpoint: requireConfiguredLocalAdmissionRoute(environment).endpoint as string,
      fetchImpl: async (input, init = {}) => {
        const url = input instanceof URL ? input : new URL(String(input));
        calls.push({ url, init });
        if (url.pathname === "/v1/sessions" && init.method === "POST") {
          return jsonResponse(201, {
            ok: true,
            session: { id: binding.sessionId, status: "active", exp: binding.exp },
          });
        }
        if (url.pathname === `/v1/sessions/${binding.sessionId}` && init.method === "DELETE") {
          return jsonResponse(200, { ok: true, session: { id: binding.sessionId, status: "closed" } });
        }
        if (url.pathname === "/v1/executions" && init.method === "POST") {
          return jsonResponse(200, { ok: true, result: { status: "succeeded" } });
        }
        throw new Error(`unexpected route ${url.pathname}`);
      },
    });

    assert.deepEqual(await client.registerSession(binding), { id: SESSION_ID, status: "active" });
    assert.deepEqual(await client.closeSession(binding), { id: SESSION_ID, status: "closed" });
    const intent = createSessionExecutionIntent(binding, "change.show", changeReadRequest(ISSUE));
    assert.deepEqual(await client.executeIntent(intent, SESSION_ID), { status: "succeeded" });

    assert.deepEqual(
      calls.map(({ url, init }) => [url.origin, url.pathname, init.method]),
      [
        [ENDPOINT, "/v1/sessions", "POST"],
        [ENDPOINT, `/v1/sessions/${SESSION_ID}`, "DELETE"],
        [ENDPOINT, "/v1/executions", "POST"],
      ],
    );
    for (const { init } of calls) {
      const headers = init.headers as Record<string, string>;
      assert.equal(headers.authorization, undefined);
      assert.equal(init.credentials, "omit");
      assert.equal(init.redirect, "error");
    }
    assert.equal((calls[0]?.init.headers as Record<string, string>)["x-inari-session-id"], undefined);
    assert.equal((calls[1]?.init.headers as Record<string, string>)["x-inari-session-id"], undefined);
    const closeBody = JSON.parse(String(calls[1]?.init.body)) as Record<string, unknown>;
    assert.deepEqual(closeBody, { version: 1, binding });
    const executionBody = JSON.parse(String(calls[2]?.init.body)) as Record<string, unknown>;
    assert.deepEqual(Object.keys(executionBody).sort(), ["operation", "repository", "request", "requestId", "version"]);
    assert.equal(
      calls[2]?.init.headers && (calls[2]?.init.headers as Record<string, string>)["x-inari-session-id"],
      SESSION_ID,
    );
    assert.equal(
      calls.some(({ url }) => /executor|8765/u.test(url.href)),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid Admission endpoints and transport failure fail closed without another route", async () => {
  assert.throws(() => createLocalAdmissionClient({ endpoint: "https://example.com" }), {
    code: "ADMISSION_ROUTE_INVALID",
  });
  let requests = 0;
  const client = createLocalAdmissionClient({
    endpoint: ENDPOINT,
    fetchImpl: async () => {
      requests += 1;
      throw new Error("unavailable");
    },
  });
  await assert.rejects(client.registerSession(bindingFixture()), { code: "ADMISSION_TRANSPORT_FAILED" });
  assert.equal(requests, 1);
});
