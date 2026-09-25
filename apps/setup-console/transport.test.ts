// Transport and bootstrap producer proofs; not real-browser certification (#1122).
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { SETUP_API_PATHS, SetupApiError, createSetupApiClient, readSetupState } from "./src/api-client.js";
import { SetupConsoleBootstrapError, createSetupOperatorContext } from "./src/bootstrap.js";
import { canonicalState } from "./test-fixtures.js";

const origin = "http://127.0.0.1:43123";
const bootstrap = { apiOrigin: origin, bearer: "b".repeat(43), csrf: "c".repeat(43), receivingMachine: "host-a" };

interface Seen {
  url: string;
  init: RequestInit;
}

function recordingFetch(respond: (seen: Seen) => Response) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const item = { url, init };
    seen.push(item);
    return respond(item);
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

test("bootstrap accepts only an exact local origin, well-formed tokens and a printable label", () => {
  const context = createSetupOperatorContext(bootstrap);
  assert.equal(context.apiOrigin, origin);
  assert.equal(context.receivingMachine, "host-a");
  assert.deepEqual(context.authorizationHeaders(), {
    authorization: `Bearer ${"b".repeat(43)}`,
    "x-csrf-token": "c".repeat(43),
  });
  assert.ok(createSetupOperatorContext({ ...bootstrap, apiOrigin: "http://localhost:8080" }));
  assert.ok(createSetupOperatorContext({ ...bootstrap, apiOrigin: "http://[::1]:8080" }));
  for (const invalid of [
    { ...bootstrap, apiOrigin: "https://example.test" },
    { ...bootstrap, apiOrigin: "http://127.0.0.1:43123/" },
    { ...bootstrap, apiOrigin: "http://127.0.0.1:43123/?bearer=x" },
    { ...bootstrap, apiOrigin: "http://user:pw@127.0.0.1:43123" },
    { ...bootstrap, apiOrigin: "http://0.0.0.0:43123" },
    { ...bootstrap, bearer: "short" },
    { ...bootstrap, csrf: "has space in it and is long enough" },
    { ...bootstrap, receivingMachine: "" },
    { ...bootstrap, receivingMachine: "a\nb" },
    { ...bootstrap, receivingMachine: "x".repeat(129) },
    { ...bootstrap, extra: true },
    null,
    "bootstrap",
  ]) {
    assert.throws(() => createSetupOperatorContext(invalid), SetupConsoleBootstrapError);
  }
});

test("requests use headers only, omit cookies/cache/referrer and carry no URL query", async () => {
  const state = canonicalState({ health: "not-running" });
  const action = state.actions[0]!;
  const result = {
    version: 1,
    actionId: action.id,
    generation: state.generation,
    outcome: "succeeded",
    diagnostics: [],
  };
  const { seen, fetchImpl } = recordingFetch(({ url }) => {
    if (url.endsWith(SETUP_API_PATHS.state)) return new Response(JSON.stringify(state));
    if (url.endsWith(SETUP_API_PATHS.confirm)) return new Response(JSON.stringify({ confirmation: "tok" }));
    return new Response(JSON.stringify(result));
  });
  const client = createSetupApiClient(createSetupOperatorContext(bootstrap), fetchImpl);
  assert.equal((await client.state()).generation.configuration, "gen-1");
  assert.equal(await client.confirm(action.id), "tok");
  const request = {
    version: 1 as const,
    actionId: action.id,
    generation: state.generation,
    confirmed: true,
    inputs: {},
  };
  assert.equal((await client.perform("tok", request)).outcome, "succeeded");
  const file = new Blob(["-----BEGIN KEY-----"]);
  assert.equal(
    (await client.enroll("issuer-key", action.id, "tok2", file, new AbortController().signal)).outcome,
    "succeeded",
  );

  assert.deepEqual(
    seen.map(({ url, init }) => [url, init.method]),
    [
      [origin + "/api/setup/state", "GET"],
      [origin + "/api/setup/confirm", "POST"],
      [origin + "/api/setup/actions", "POST"],
      [origin + "/api/setup/enrollment/issuer-key", "POST"],
    ],
  );
  for (const { url, init } of seen) {
    assert.ok(!url.includes("?") && !url.includes("#"));
    assert.equal(init.credentials, "omit");
    assert.equal(init.cache, "no-store");
    assert.equal(init.referrerPolicy, "no-referrer");
    assert.equal(init.redirect, "error");
    const headers = init.headers as Record<string, string>;
    assert.equal(headers.authorization, `Bearer ${"b".repeat(43)}`);
    assert.equal(headers["x-csrf-token"], "c".repeat(43));
  }
  assert.deepEqual(JSON.parse(seen[1]!.init.body as string), { actionId: action.id });
  assert.deepEqual(JSON.parse(seen[2]!.init.body as string), { confirmation: "tok", request });
  const enroll = seen[3]!.init;
  assert.equal(enroll.body, file, "the File/Blob is streamed as-is, never read into JSON");
  assert.equal((enroll.headers as Record<string, string>)["content-type"], "application/octet-stream");
  assert.equal((enroll.headers as Record<string, string>)["x-setup-action-id"], action.id);
  assert.equal((enroll.headers as Record<string, string>)["x-setup-confirmation"], "tok2");
  for (const { init } of seen.slice(0, 3)) assert.doesNotMatch(String(init.body ?? ""), /BEGIN/u);
});

test("HTTP failures map to fixed classifications without reading or echoing bodies", async () => {
  for (const [status, failure] of [
    [403, "rejected"],
    [409, "stale"],
    [400, "invalid"],
    [404, "not-found"],
    [500, "unavailable"],
  ] as const) {
    const { fetchImpl } = recordingFetch(() => new Response("secret echo", { status }));
    const client = createSetupApiClient(createSetupOperatorContext(bootstrap), fetchImpl);
    await assert.rejects(client.state(), (error: unknown) => {
      assert.ok(error instanceof SetupApiError);
      assert.equal(error.failure, failure);
      assert.doesNotMatch(error.message, /secret/u);
      return true;
    });
  }
  const offline = createSetupApiClient(createSetupOperatorContext(bootstrap), (async () => {
    throw new TypeError("network");
  }) as unknown as typeof fetch);
  await assert.rejects(
    offline.state(),
    (error: unknown) => error instanceof SetupApiError && error.failure === "unavailable",
  );
  const garbage = createSetupApiClient(
    createSetupOperatorContext(bootstrap),
    (async () => new Response("{not json")) as unknown as typeof fetch,
  );
  await assert.rejects(
    garbage.state(),
    (error: unknown) => error instanceof SetupApiError && error.failure === "response-invalid",
  );
  const client = createSetupApiClient(
    createSetupOperatorContext(bootstrap),
    (async () => new Response("{}")) as unknown as typeof fetch,
  );
  await assert.rejects(client.enroll("issuer-key", "a", "t", new Blob([]), new AbortController().signal));
  await assert.rejects(client.enroll("../x", "a", "t", new Blob(["x"]), new AbortController().signal));
  await assert.rejects(
    client.enroll("issuer-key", "a", "t", new Blob([new Uint8Array(64 * 1024 + 1)]), new AbortController().signal),
  );
});

test("state parsing validates canonical actions and rejects malformed or secret-bearing state", () => {
  const state = canonicalState({ configuration: "unconfigured" });
  assert.equal(readSetupState(state).actions[0]!.kind, "executor.configure");
  assert.throws(() => readSetupState({ ...state, actions: "x" }), SetupApiError);
  assert.throws(() => readSetupState({ ...state, generation: {} }), SetupApiError);
  const withSecret = JSON.parse(JSON.stringify(state));
  withSecret.actions[0].title = "-----BEGIN RSA PRIVATE KEY-----";
  assert.throws(() => readSetupState(withSecret), SetupApiError);
});

test("wizard sources use no persistent browser storage, cookies, URL credentials, logging or HTML parsing", async () => {
  const directory = new URL("./src/", import.meta.url);
  const files = (await readdir(directory)).filter((name) => name.endsWith(".ts"));
  assert.ok(files.length >= 6);
  const forbidden = [
    /localStorage/u,
    /sessionStorage/u,
    /indexedDB/iu,
    /document\.cookie/u,
    /cookieStore/u,
    /\bconsole\.(log|error|warn|info|debug|trace|dir|table)\b/u,
    /innerHTML|outerHTML|insertAdjacentHTML|document\.write/u,
    /\beval\(|new Function\(/u,
    /FileReader|\.arrayBuffer\(\)|\.stream\(\)/u,
    /location\.(search|hash|href)|URLSearchParams|history\./u,
    /postMessage|BroadcastChannel|serviceWorker|caches\./u,
  ];
  for (const name of files) {
    const source = await readFile(new URL(name, directory), "utf8");
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern, `${name} must not match ${pattern}`);
  }
});
