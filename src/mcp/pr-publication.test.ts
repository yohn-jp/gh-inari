import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createInariMcpServer } from "./server.js";
import type { CapabilityAuthorizedSessionExecutor } from "../session-authorized-change-executor.js";

const publicationFailure = {
  version: 1 as const,
  operation: "pullRequest.publish" as const,
  status: "failed" as const,
  failure: {
    code: "SESSION_EXECUTION_FAILED" as const,
    phase: "authorization" as const,
    message: "Session capability admission denied.",
  },
};

async function connectedServer(sessionExecutor?: CapabilityAuthorizedSessionExecutor) {
  const server = createInariMcpServer(sessionExecutor === undefined ? {} : { sessionExecutor });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-pr-publication-test", version: "1" }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { server, client };
}

test("the default MCP catalog remains non-mutating and omits PR publication", async () => {
  const { server, client } = await connectedServer();
  try {
    const tools = await client.listTools();
    assert.equal(
      tools.tools.some((tool) => tool.name === "inari_pr_publish"),
      false,
    );
    assert.equal(
      tools.tools.some((tool) => tool.name === "inari_change_execute"),
      false,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("privileged MCP PR publication forwards the exact Session envelope", async () => {
  const envelope = Object.freeze({
    version: 1,
    operation: "pullRequest.publish",
    request: Object.freeze({ version: 1, issue: 927 }),
  });
  let received: unknown;
  const { server, client } = await connectedServer({
    execute: async (input) => {
      received = input;
      return publicationFailure;
    },
  });
  try {
    const tools = await client.listTools();
    const publication = tools.tools.find((tool) => tool.name === "inari_pr_publish");
    assert.ok(publication);
    assert.equal(publication.annotations?.readOnlyHint, false);
    assert.equal(publication.annotations?.destructiveHint, true);
    assert.deepEqual(Object.keys(publication.inputSchema.properties ?? {}), ["envelope"]);
    const response = await client.callTool({ name: "inari_pr_publish", arguments: { envelope } });
    assert.deepEqual(response.structuredContent, publicationFailure);
    assert.equal(received, envelope);
  } finally {
    await client.close();
    await server.close();
  }
});
