import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createInariMcpServer } from "./mcp/server.js";
import { createMcpSessionAppBridge } from "./mcp/session-app-bridge.js";
import type {
  CapabilityAuthorizedSessionExecutionResult,
  CapabilityAuthorizedSessionExecutor,
} from "./session-authorized-change-executor.js";

const SAFE_FAILURE: CapabilityAuthorizedSessionExecutionResult = Object.freeze({
  version: 1,
  status: "failed",
  failure: Object.freeze({
    code: "SESSION_EXECUTION_FAILED",
    phase: "authorization",
    message: "Session capability admission denied.",
  }),
});

function structuredContent(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}

test("the MCP Session/App bridge forwards the canonical envelope unchanged", async () => {
  const envelope = Object.freeze({ version: 1, operation: "change.abort", request: { issue: 381 } });
  let received: unknown;
  const executor: CapabilityAuthorizedSessionExecutor = {
    execute: async (input) => {
      received = input;
      return SAFE_FAILURE;
    },
  };

  const bridge = createMcpSessionAppBridge(executor);
  assert.equal(await bridge.execute(envelope), SAFE_FAILURE);
  assert.equal(received, envelope);
});

test("privileged MCP registration is opt-in and exposes only the canonical Session request", async () => {
  const secret = "-----BEGIN PRIVATE KEY-----not-for-MCP-----END PRIVATE KEY-----";
  const envelope = Object.freeze({
    version: 1,
    alg: "EdDSA",
    certificate: "certificate",
    request: { version: 1, issue: 381 },
    certificateJti: "certificate-jti",
    repositoryId: "123",
    operation: "change.abort",
    requestId: "request-id",
    issuedAt: 1,
    expiresAt: 2,
    signature: "signature",
  });
  let received: unknown;
  const server = createInariMcpServer({
    sessionExecutor: {
      execute: async (input) => {
        received = input;
        return SAFE_FAILURE;
      },
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-session-bridge-test", version: "1" }, { capabilities: {} });

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    const privileged = tools.tools.find((tool) => tool.name === "inari_change_execute");
    assert.ok(privileged);
    assert.equal(privileged.annotations?.readOnlyHint, false);
    assert.equal(privileged.annotations?.destructiveHint, true);
    assert.deepEqual(Object.keys(privileged.inputSchema.properties ?? {}), ["envelope"]);
    assert.equal(JSON.stringify(privileged).includes(secret), false);

    const response = await client.callTool({
      name: "inari_change_execute",
      arguments: { envelope },
    });
    assert.deepEqual(structuredContent(response.structuredContent), SAFE_FAILURE);
    assert.equal(received, envelope);
    assert.equal(JSON.stringify(response).includes(secret), false);
    assert.equal(JSON.stringify(response).includes("certificate"), false);
  } finally {
    await client.close();
    await server.close();
  }
});

test("unexpected privileged executor failures become bounded MCP results", async () => {
  const server = createInariMcpServer({
    sessionExecutor: {
      execute: async () => {
        throw new Error("installation token=must-not-cross-the-bridge");
      },
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-session-bridge-error-test", version: "1" }, { capabilities: {} });

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.callTool({
      name: "inari_change_execute",
      arguments: { envelope: { untrusted: true } },
    });
    const output = structuredContent(response.structuredContent);
    assert.equal(output.status, "failed");
    assert.equal(JSON.stringify(response).includes("installation token"), false);
  } finally {
    await client.close();
    await server.close();
  }
});
