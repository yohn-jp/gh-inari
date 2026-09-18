import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GitHubHttpMalformedResponseError,
  GitHubHttpResponseLimitError,
  GitHubHttpTimeoutError,
  GitHubHttpTransportError,
  GitHubNativeHttpTransport,
  githubGraphqlUrl,
  githubRestBaseUrl,
} from "./native-http-transport.js";

const TOKEN = "ghp_native-http-transport-test-token";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

test("githubRestBaseUrl uses the dedicated API host for github.com and /api/v3 otherwise", () => {
  assert.equal(githubRestBaseUrl("github.com"), "https://api.github.com");
  assert.equal(githubRestBaseUrl("GITHUB.COM"), "https://api.github.com");
  assert.equal(githubRestBaseUrl("ghe.example.com"), "https://ghe.example.com/api/v3");
});

test("githubGraphqlUrl mirrors the same host split", () => {
  assert.equal(githubGraphqlUrl("github.com"), "https://api.github.com/graphql");
  assert.equal(githubGraphqlUrl("ghe.example.com"), "https://ghe.example.com/api/graphql");
});

test("request() issues a bounded REST call and decodes a JSON body", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const transport = new GitHubNativeHttpTransport({
    token: TOKEN,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init as RequestInit });
      return jsonResponse(200, { id: 1 });
    },
  });
  const response = await transport.request({ hostname: "github.com", method: "GET", path: "repos/acme/inari" });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { id: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.github.com/repos/acme/inari");
  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(headers["X-GitHub-Api-Version"], "2022-11-28");
});

test("request() targets an Enterprise host's /api/v3 base URL", async () => {
  let requestedUrl = "";
  const transport = new GitHubNativeHttpTransport({
    token: TOKEN,
    fetch: async (url) => {
      requestedUrl = String(url);
      return jsonResponse(200, {});
    },
  });
  await transport.request({ hostname: "ghe.example.com", method: "GET", path: "repos/acme/inari" });
  assert.equal(requestedUrl, "https://ghe.example.com/api/v3/repos/acme/inari");
});

test("request() and requestBinary() honor an explicit API base URL", async () => {
  const requestedUrls: string[] = [];
  const transport = new GitHubNativeHttpTransport({
    token: TOKEN,
    apiUrl: "http://127.0.0.1:1234/api/v3/",
    fetch: async (url) => {
      requestedUrls.push(String(url));
      return jsonResponse(200, {});
    },
  });
  await transport.request({ hostname: "github.com", method: "GET", path: "repos/acme/inari" });
  await transport.requestBinary({ hostname: "github.com", method: "GET", path: "repos/acme/inari/archive" });
  assert.deepEqual(requestedUrls, [
    "http://127.0.0.1:1234/api/v3/repos/acme/inari",
    "http://127.0.0.1:1234/api/v3/repos/acme/inari/archive",
  ]);
});

test("request() propagates a non-200 status without throwing", async () => {
  const transport = new GitHubNativeHttpTransport({
    token: TOKEN,
    fetch: async () => jsonResponse(404, { message: "Not Found" }),
  });
  const response = await transport.request({ hostname: "github.com", method: "GET", path: "repos/acme/missing" });
  assert.equal(response.status, 404);
  assert.deepEqual(response.body, { message: "Not Found" });
});

test("request() exposes only the bounded pagination link header", async () => {
  const transport = new GitHubNativeHttpTransport({
    token: TOKEN,
    fetch: async () =>
      jsonResponse(200, [], {
        link: '<https://api.github.com/repos/acme/inari/issues?page=2>; rel="next"',
        authorization: `Bearer ${TOKEN}`,
      }),
  });
  const response = await transport.request({ hostname: "github.com", method: "GET", path: "repos/acme/inari/issues" });
  assert.deepEqual(response.headers, {
    link: '<https://api.github.com/repos/acme/inari/issues?page=2>; rel="next"',
  });
});

test("request() accepts ordinary PUT mutations without widening the Change transport seam", async () => {
  let method = "";
  const transport = new GitHubNativeHttpTransport({
    token: TOKEN,
    fetch: async (_url, init) => {
      method = String((init as RequestInit).method);
      return jsonResponse(200, { merged: true });
    },
  });
  const response = await transport.request({
    hostname: "github.com",
    method: "PUT",
    path: "repos/acme/inari/pulls/1/merge",
    body: { merge_method: "squash" },
  });
  assert.equal(method, "PUT");
  assert.deepEqual(response.body, { merged: true });
});

test("requestGraphql() posts the query/variables to the GraphQL endpoint", async () => {
  let body: unknown;
  let url = "";
  const transport = new GitHubNativeHttpTransport({
    token: TOKEN,
    fetch: async (requestUrl, init) => {
      url = String(requestUrl);
      body = JSON.parse(String((init as RequestInit).body));
      return jsonResponse(200, { data: { ok: true } });
    },
  });
  const response = await transport.requestGraphql({
    hostname: "github.com",
    query: "query { viewer { login } }",
    variables: { x: 1 },
  });
  assert.equal(url, "https://api.github.com/graphql");
  assert.deepEqual(body, { query: "query { viewer { login } }", variables: { x: 1 } });
  assert.deepEqual(response.body, { data: { ok: true } });
});

test("requestBinary() returns raw bytes and never JSON-decodes them", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const transport = new GitHubNativeHttpTransport({
    token: TOKEN,
    fetch: async () => new Response(bytes, { status: 200, headers: { "content-type": "application/zip" } }),
  });
  const response = await transport.requestBinary({
    hostname: "github.com",
    method: "GET",
    path: "repos/acme/inari/zipball",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.bytes, bytes);
  assert.equal(response.contentType, "application/zip");
});

test("a request exceeding the bounded timeout rejects with GitHubHttpTimeoutError", async () => {
  const transport = new GitHubNativeHttpTransport({
    token: TOKEN,
    requestTimeoutMs: 20,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = (init as RequestInit).signal;
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  });
  await assert.rejects(
    transport.request({ hostname: "github.com", method: "GET", path: "repos/acme/inari" }),
    (error: unknown) => error instanceof GitHubHttpTimeoutError && error.timeoutMs === 20,
  );
});

test("headers arriving but the body never completing still rejects with GitHubHttpTimeoutError", async () => {
  const transport = new GitHubNativeHttpTransport({
    token: TOKEN,
    requestTimeoutMs: 20,
    fetch: async () => {
      const stream = new ReadableStream<Uint8Array>({
        start() {
          // Deliberately never enqueue a chunk or close: the body stalls forever.
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  await assert.rejects(
    transport.request({ hostname: "github.com", method: "GET", path: "repos/acme/inari" }),
    (error: unknown) => error instanceof GitHubHttpTimeoutError && error.timeoutMs === 20,
  );
});

test("a response exceeding the bounded byte limit rejects with GitHubHttpResponseLimitError", async () => {
  const transport = new GitHubNativeHttpTransport({
    token: TOKEN,
    maxResponseBytes: 4,
    fetch: async () => new Response("way too many bytes for the bound", { status: 200 }),
  });
  await assert.rejects(
    transport.request({ hostname: "github.com", method: "GET", path: "repos/acme/inari" }),
    (error: unknown) => error instanceof GitHubHttpResponseLimitError && error.limitBytes === 4,
  );
});

test("a malformed JSON body rejects with GitHubHttpMalformedResponseError", async () => {
  const transport = new GitHubNativeHttpTransport({
    token: TOKEN,
    fetch: async () => new Response("{not json", { status: 200, headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(
    transport.request({ hostname: "github.com", method: "GET", path: "repos/acme/inari" }),
    (error: unknown) => error instanceof GitHubHttpMalformedResponseError,
  );
});

test("a fetch-level failure never leaks the bearer token", async () => {
  const transport = new GitHubNativeHttpTransport({
    token: TOKEN,
    fetch: async () => {
      throw new Error(`connect ECONNREFUSED while sending Bearer ${TOKEN}`);
    },
  });
  await assert.rejects(
    transport.request({ hostname: "github.com", method: "GET", path: "repos/acme/inari" }),
    (error: unknown) => {
      assert.ok(error instanceof GitHubHttpTransportError);
      assert.ok(!error.message.includes(TOKEN));
      return true;
    },
  );
});

test("constructing the transport with an invalid token throws synchronously", () => {
  assert.throws(() => new GitHubNativeHttpTransport({ token: "" }));
  assert.throws(() => new GitHubNativeHttpTransport({ token: "has\u0000nul" }));
});

test("an out-of-range requestTimeoutMs is rejected at construction", () => {
  assert.throws(() => new GitHubNativeHttpTransport({ token: TOKEN, requestTimeoutMs: 0 }));
  assert.throws(() => new GitHubNativeHttpTransport({ token: TOKEN, requestTimeoutMs: 60_000 }));
});
