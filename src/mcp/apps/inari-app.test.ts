import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createInariMcpServer } from "../server.js";
import type { GitHubAdapter } from "../../github/index.js";
import {
  INARI_APP_RESOURCE_MIME_TYPE,
  INARI_APP_RESOURCE_URI,
  INARI_APP_TOOL_NAME,
  INARI_APP_HTML,
} from "./inari-app.js";

test("the existing Issue view tool links to and serves the stable MCP App resource", async () => {
  const server = createInariMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "inari-app-test", version: "1" }, { capabilities: {} });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    const issueView = tools.tools.find((tool) => tool.name === INARI_APP_TOOL_NAME);
    assert.ok(issueView);
    assert.deepEqual(issueView._meta?.ui, { resourceUri: INARI_APP_RESOURCE_URI });
    assert.equal(issueView.annotations?.readOnlyHint, true);
    assert.equal(issueView.annotations?.destructiveHint, false);
    assert.ok(issueView.outputSchema);

    const resources = await client.listResources();
    const appResource = resources.resources.find((resource) => resource.uri === INARI_APP_RESOURCE_URI);
    assert.ok(appResource);
    assert.equal(appResource.mimeType, INARI_APP_RESOURCE_MIME_TYPE);

    const read = await client.readResource({ uri: INARI_APP_RESOURCE_URI });
    assert.equal(read.contents.length, 1);
    const content = read.contents[0];
    assert.ok(content);
    assert.equal(content.uri, INARI_APP_RESOURCE_URI);
    assert.equal(content.mimeType, INARI_APP_RESOURCE_MIME_TYPE);
    assert.ok("text" in content);
    assert.equal(content.text, INARI_APP_HTML);
    assert.match(content.text, /tools\/call/);
    assert.match(content.text, new RegExp(INARI_APP_TOOL_NAME));
  } finally {
    await client.close();
    await server.close();
  }
});

test("the App resource is presentation-only and does not replace the native Issue result", async () => {
  const server = createInariMcpServer({
    adapter: {
      async observeIssue() {
        throw new Error("provider unavailable");
      },
    } as unknown as GitHubAdapter,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "inari-app-fallback-test", version: "1" }, { capabilities: {} });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const issueView = (await client.listTools()).tools.find((tool) => tool.name === INARI_APP_TOOL_NAME);
    assert.ok(issueView);
    assert.equal(issueView.title, "View Issue with semantic status");
    assert.match(issueView.description ?? "", /semantic projection/);
    assert.ok(issueView.inputSchema);
    assert.ok(issueView.outputSchema);
    assert.equal(issueView.annotations?.readOnlyHint, true);

    const fallback = (await client.callTool({ name: INARI_APP_TOOL_NAME, arguments: { number: 1 } })) as {
      readonly isError?: boolean;
      readonly content?: readonly { readonly type: string; readonly text?: string }[];
    };
    assert.equal(fallback.isError, undefined);
    const text = fallback.content?.find((item) => item.type === "text");
    assert.ok(text && text.type === "text");
    assert.match(text.text ?? "", /Issue view provider observation failed/);
  } finally {
    await client.close();
    await server.close();
  }
});
