import assert from "node:assert/strict";
import { test } from "node:test";
import { createInariMcpHttpHandler } from "./http-transport.js";

const ACCEPT = "application/json, text/event-stream";
const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "http-transport-test", version: "1" },
  },
};

async function post(handler: ReturnType<typeof createInariMcpHttpHandler>, body: unknown, init: RequestInit = {}) {
  return handler(
    new Request("https://example.test/mcp", {
      ...init,
      method: "POST",
      headers: { accept: ACCEPT, "content-type": "application/json", ...init.headers },
      body: init.body ?? JSON.stringify(body),
    }),
  );
}

test("serves the native catalog with a fresh stateless composition per request", async () => {
  const handler = createInariMcpHttpHandler();
  const initialize = await post(handler, INITIALIZE);
  assert.equal(initialize.status, 200);
  assert.equal(initialize.headers.get("mcp-session-id"), null);
  assert.equal((await initialize.json()).result.serverInfo.name, "inari");

  const first = await post(handler, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const second = await post(handler, { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.deepEqual((await first.json()).result.tools, (await second.json()).result.tools);
  assert.equal(
    (
      await post(handler, { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }).then((response) =>
        response.json(),
      )
    ).result.tools.some((tool: { name: string }) => tool.name === "inari_change_execute"),
    false,
  );
});

test("injects the existing Session executor without adding transport authorization", async () => {
  const handler = createInariMcpHttpHandler({
    sessionExecutor: { execute: async () => ({ version: 1, status: "succeeded" }) },
  });
  const response = await post(handler, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const tools = (await response.json()).result.tools as Array<{ name: string }>;
  assert.ok(tools.some((tool) => tool.name === "inari_change_execute"));
  assert.ok(tools.some((tool) => tool.name === "inari_pr_publish"));
});

test("fails closed for endpoint, method, media, protocol, Origin, and body bounds", async () => {
  const handler = createInariMcpHttpHandler({ allowedOrigins: ["https://allowed.example"] });
  const wrongPath = await handler(
    new Request("https://example.test/other", {
      method: "POST",
      headers: { accept: ACCEPT, "content-type": "application/json" },
      body: JSON.stringify(INITIALIZE),
    }),
  );
  assert.equal(wrongPath.status, 404);

  const get = await handler(new Request("https://example.test/mcp", { method: "GET" }));
  assert.equal(get.status, 405);

  const media = await post(handler, INITIALIZE, { headers: { "content-type": "text/plain" } });
  assert.equal(media.status, 415);

  const protocol = await post(handler, INITIALIZE, { headers: { "mcp-protocol-version": "unsupported" } });
  assert.equal(protocol.status, 400);

  const origin = await post(handler, INITIALIZE, { headers: { origin: "https://other.example" } });
  assert.equal(origin.status, 403);

  const bounded = createInariMcpHttpHandler({ maxBodyBytes: 32 });
  const oversized = await post(bounded, INITIALIZE);
  assert.equal(oversized.status, 413);
});

test("allows an explicitly configured Origin and rejects malformed JSON boundedly", async () => {
  const handler = createInariMcpHttpHandler({ allowedOrigins: ["https://allowed.example"] });
  const response = await post(handler, INITIALIZE, { headers: { origin: "https://allowed.example" } });
  assert.equal(response.status, 200);

  const malformed = await handler(
    new Request("https://example.test/mcp", {
      method: "POST",
      headers: { accept: ACCEPT, "content-type": "application/json" },
      body: "not-json",
    }),
  );
  assert.equal(malformed.status, 400);
  assert.match(await malformed.text(), /Request body is invalid/u);
});
