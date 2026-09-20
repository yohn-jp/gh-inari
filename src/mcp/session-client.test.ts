import assert from "node:assert/strict";
import test from "node:test";
import type { SessionRequestEnvelope } from "../agent-authority/session-request.js";
import type { SessionSigner } from "../agent-authority/session-signer.js";
import { createSessionMcpAdapter, createSessionMcpClient, type McpCallToolPort } from "./session-client.js";

const envelope = (requestId: string): SessionRequestEnvelope =>
  ({
    version: 1,
    alg: "EdDSA",
    certificate: "certificate.public",
    request: { number: 7 },
    certificateJti: "certificate-jti",
    repositoryId: "123",
    operation: "change.issue",
    requestId,
    issuedAt: 1_700_000_000,
    expiresAt: 1_700_000_060,
    signature: "signature.public-proof",
  }) as SessionRequestEnvelope;

function signerFor(calls: Array<Record<string, unknown>>): SessionSigner {
  return {
    sessionId: "session-1",
    publicKey: { kty: "OKP", crv: "Ed25519", x: "public-key" },
    certificate: undefined,
    metadata: {
      sessionId: "session-1",
      publicKey: { kty: "OKP", crv: "Ed25519", x: "public-key" },
    },
    sign: () => new Uint8Array([1]),
    signRequest: (input) => {
      calls.push(input as unknown as Record<string, unknown>);
      return envelope(input.requestId);
    },
  };
}

test("signs immediately before exactly one privileged MCP dispatch", async () => {
  const signingCalls: Array<Record<string, unknown>> = [];
  const toolCalls: unknown[] = [];
  const port: McpCallToolPort = {
    async callTool(request) {
      toolCalls.push(request);
      return { structuredContent: { accepted: true } };
    },
  };
  const client = createSessionMcpClient({
    signer: signerFor(signingCalls),
    callTool: port,
    requestId: () => "request-1",
    now: () => 1_700_000_000,
    ttlSeconds: 60,
  });

  const result = await client.execute({ request: { number: 7 }, operation: "change.issue" });

  assert.equal(result.ok, true);
  assert.equal(signingCalls.length, 1);
  assert.equal(toolCalls.length, 1);
  assert.deepEqual(toolCalls[0], {
    name: "inari_change_execute",
    arguments: { envelope: envelope("request-1") },
  });
  assert.equal(signingCalls[0]?.requestId, "request-1");
  assert.equal(signingCalls[0]?.issuedAt, 1_700_000_000);
  assert.equal(signingCalls[0]?.expiresAt, 1_700_000_060);
});

test("accepts explicit freshness inputs and signs each invocation", async () => {
  const calls: Array<Record<string, unknown>> = [];
  let dispatches = 0;
  const client = createSessionMcpClient({
    signer: signerFor(calls),
    callTool: {
      async callTool() {
        dispatches += 1;
        return {};
      },
    },
    requestId: () => "unused",
    now: () => 1_700_000_001,
  });

  await client.execute({
    request: { action: "first" },
    operation: "change.issue",
    requestId: "explicit-1",
    issuedAt: 1_700_000_100,
    expiresAt: 1_700_000_120,
  });
  await client.execute({
    request: { action: "second" },
    operation: "change.show",
    requestId: "explicit-2",
    issuedAt: 1_700_000_200,
    expiresAt: 1_700_000_220,
  });

  assert.equal(dispatches, 2);
  assert.deepEqual(
    calls.map((call) => call.requestId),
    ["explicit-1", "explicit-2"],
  );
});

test("configured handoff exposes bounded public metadata and no credential material", () => {
  const client = createSessionMcpAdapter({
    signer: signerFor([]),
    callTool: {
      async callTool() {
        return {};
      },
    },
  });

  assert.deepEqual(client.metadata, {
    sessionId: "session-1",
    publicKey: { kty: "OKP", crv: "Ed25519", x: "public-key" },
    toolName: "inari_change_execute",
  });
  assert.equal(JSON.stringify(client).includes("private"), false);
  assert.equal(JSON.stringify(client).includes("credential"), false);
});

test("does not dispatch when freshness inputs are invalid", async () => {
  let dispatches = 0;
  const calls: Array<Record<string, unknown>> = [];
  const client = createSessionMcpClient({
    signer: signerFor(calls),
    callTool: {
      async callTool() {
        dispatches += 1;
        return {};
      },
    },
    requestId: () => "bad\nrequest",
  });

  const result = await client.execute({ request: {}, operation: "change.issue" });

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.failure.code, "MCP_SESSION_CLIENT_INVALID_INPUT");
  assert.equal(dispatches, 0);
  assert.equal(calls.length, 0);
});

test("returns bounded tool and transport failures without authorization outcomes", async () => {
  const signer = signerFor([]);
  const toolFailure = createSessionMcpClient({
    signer,
    callTool: {
      async callTool() {
        return { isError: true, error: "secret provider detail" };
      },
    },
    requestId: () => "request-tool-failure",
    now: () => 1_700_000_000,
  });
  const transportFailure = createSessionMcpClient({
    signer,
    callTool: {
      async callTool() {
        throw new Error("private transport detail");
      },
    },
    requestId: () => "request-transport-failure",
    now: () => 1_700_000_000,
  });

  const toolResult = await toolFailure.execute({ request: {}, operation: "change.issue" });
  const transportResult = await transportFailure.execute({ request: {}, operation: "change.issue" });

  assert.equal(toolResult.ok, false);
  assert.equal(transportResult.ok, false);
  if (!toolResult.ok) {
    assert.equal(toolResult.failure.code, "MCP_SESSION_CLIENT_TOOL_FAILURE");
    assert.equal(toolResult.failure.message.includes("secret"), false);
  }
  if (!transportResult.ok) {
    assert.equal(transportResult.failure.code, "MCP_SESSION_CLIENT_TRANSPORT_FAILURE");
    assert.equal(transportResult.failure.message.includes("private"), false);
  }
});
